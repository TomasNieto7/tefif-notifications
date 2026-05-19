const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configuración de Firebase Admin
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Referencia a Firestore
const db = admin.firestore();

// Endpoint: Registrar Token en Firestore
app.post("/tokens/register", async (req, res) => {
  const { user_id, pushToken } = req.body;
  try {
    // Guardamos el token en una colección llamada "push_tokens"
    // Usamos el user_id como ID del documento para que no se dupliquen
    await db.collection("push_tokens").doc(user_id).set({
      pushToken: pushToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(200).send("Token guardado en Firestore");
  } catch (err) {
    res.status(500).send("Error en Firestore: " + err.message);
  }
});

// Endpoint: Broadcast (Usado por addEventScreen y addNoticeScreen)
app.post("/notifications/broadcast", async (req, res) => {
  const { title, body, data } = req.body;
  try {
    // Obtenemos todos los tokens de la colección
    const snapshot = await db.collection("push_tokens").get();
    const tokens = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.pushToken) tokens.push(data.pushToken);
    });

    if (tokens.length > 0) {
      const message = {
        notification: { title, body },
        data: data || {},
        tokens: tokens,
      };
      // Usamos sendEachForMulticast que es la versión más actual del SDK
      const response = await admin.messaging().sendEachForMulticast(message);
      res.status(200).send(`Notificaciones enviadas: ${response.successCount}`);
    } else {
      res.status(200).send("No hay dispositivos registrados en Firestore");
    }
  } catch (err) {
    console.error("Error en el broadcast:", err);
    res.status(500).send("Error interno: " + err.message);
  }
});

// Cron Job Corregido: Se ejecuta cada 5 minutos
cron.schedule("*/5 * * * *", async () => {
  try {
    console.log("⏰ Iniciando Cron Job de recordatorios...");

    // 1. Autenticación automática con el Backend Principal
    const loginRes = await axios.post(
      "https://tefif-backend.onrender.com/api/tefif/users/login",
      {
        exp: "TU_EXPEDIENTE_ADMIN", // Pon aquí un expediente de admin válido en tu BD
        password: "TU_CONTRASEÑA_ADMIN", // Pon aquí su contraseña correspondiente
      },
    );

    const { token } = loginRes.data; // Extraemos el JWT generado
    console.log("🔑 Token de sincronización obtenido con éxito.");

    // 2. Consulta al calendario usando el Header de Autorización requerido
    const res = await axios.get(
      "https://tefif-backend.onrender.com/api/tefif/calendar",
      {
        headers: {
          Authorization: `Bearer ${token}`, // Inyección del token Bearer
        },
      },
    );
    const eventos = res.data;

    const ahora = new Date();
    const tiempoMinimo = new Date(ahora.getTime() + 5 * 60 * 1000);
    const tiempoMaximo = new Date(ahora.getTime() + 15 * 60 * 1000);

    for (const item of eventos) {
      const fechaEvento = new Date(`${item.start_date}T${item.start_time}`);

      if (fechaEvento >= tiempoMinimo && fechaEvento <= tiempoMaximo) {
        // Traemos los tokens de Firestore
        const snapshot = await db.collection("push_tokens").get();
        const tokens = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data.pushToken) tokens.push(data.pushToken);
        });

        // Enviamos el recordatorio multicast si hay dispositivos
        if (tokens.length > 0) {
          const message = {
            notification: {
              title: `⏳ ¡Ya casi empieza: ${item.event?.name || "Evento"}!`,
              body: `El evento inicia en unos minutos (${item.start_time}). ¡No tardes en llegar!`,
            },
            tokens: tokens,
          };

          await admin.messaging().sendEachForMulticast(message);
          console.log(`📢 Recordatorio enviado para: ${item.event?.name}`);
        }
      }
    }
  } catch (error) {
    console.error(
      "❌ Error en Cron Job de recordatorios:",
      error.response?.data?.message || error.message,
    );
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Servidor Firestore-ready"),
);
