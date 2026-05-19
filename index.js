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

// Cron Job: Revisar eventos próximos cada hora
cron.schedule("0 * * * *", async () => {
  try {
    // Consulta al backend principal de TEFIF [cite: 4]
    const res = await axios.get(
      "https://tefif-backend.onrender.com/api/tefif/calendar",
    );
    const eventos = res.data;

    const ahora = new Date();
    const manana = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);

    for (const item of eventos) {
      const fechaEvento = new Date(`${item.start_date}T${item.start_time}`);

      if (fechaEvento > ahora && fechaEvento <= manana) {
        const snapshot = await db.collection("push_tokens").get();
        const tokens = [];
        snapshot.forEach((doc) => tokens.push(doc.data().pushToken));

        if (tokens.length > 0) {
          await admin.messaging().sendMulticast({
            notification: {
              title: "¡Evento mañana!",
              body: `Recuerda asistir a: ${item.event?.name}`,
            },
            tokens: tokens,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error en Cron Job:", error.message);
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Servidor Firestore-ready"),
);
