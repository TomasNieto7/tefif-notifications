const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configuración de Firebase Admin
// Render creará este archivo físicamente en la raíz gracias a "Secret Files"
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Endpoint: Registrar Token en Firestore
app.post("/tokens/register", async (req, res) => {
  const { user_id, pushToken } = req.body;
  try {
    await db.collection("push_tokens").doc(user_id).set({
      pushToken: pushToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(200).send("Token guardado en Firestore");
  } catch (err) {
    res.status(500).send("Error en Firestore: " + err.message);
  }
});

// Endpoint: Broadcast masivo
app.post("/notifications/broadcast", async (req, res) => {
  const { title, body, data } = req.body;
  try {
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

// Cron Job: Recordatorio inteligente (Cada 5 minutos)
cron.schedule("*/5 * * * *", async () => {
  try {
    console.log("⏰ Iniciando Cron Job de recordatorios...");

    // Extrayendo de forma segura las credenciales configuradas en Render
    const adminExp = process.env.ADMIN_EXP;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminExp || !adminPassword) {
      console.error("❌ Error: ADMIN_EXP o ADMIN_PASSWORD no están configurados en Render.");
      return;
    }

    // 1. Autenticación automática con el Backend Principal
    const loginRes = await axios.post("https://tefif-backend.onrender.com/api/tefif/users/login", {
      exp: adminExp,
      password: adminPassword
    });

    const { token } = loginRes.data;

    // 2. Consulta al calendario usando el JWT dinámico
    const res = await axios.get(
      "https://tefif-backend.onrender.com/api/tefif/calendar",
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
    const eventos = res.data;

    const ahora = new Date();
    const tiempoMinimo = new Date(ahora.getTime() + 5 * 60 * 1000);
    const tiempoMaximo = new Date(ahora.getTime() + 15 * 60 * 1000);

    for (const item of eventos) {
      const fechaEvento = new Date(`${item.start_date}T${item.start_time}`);

      if (fechaEvento >= tiempoMinimo && fechaEvento <= tiempoMaximo) {
        const snapshot = await db.collection("push_tokens").get();
        const tokens = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data.pushToken) tokens.push(data.pushToken);
        });

        if (tokens.length > 0) {
          const message = {
            notification: {
              title: `⏳ ¡Ya casi empieza: ${item.event?.name || 'Evento'}!`,
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
    console.error("❌ Error en Cron Job de recordatorios:", error.response?.data?.message || error.message);
  }
});

// Escucha en el puerto que Render asigne dinámicamente o por defecto en el 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor corriendo exitosamente en el puerto ${PORT}`),
);