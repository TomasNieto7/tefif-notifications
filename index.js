const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. CONFIGURACIÓN DE FIREBASE ADMIN
// ==========================================
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ==========================================
// 2. MEMORIA ANTI-SPAM (HISTORIAL DEL DÍA)
// ==========================================
// Guardamos los IDs de los eventos que ya notificamos para no repetir alertas
const recordatoriosEnviadosHoy = new Set();

// ==========================================
// ENDPOINT: Registrar Token en Firestore
// ==========================================
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

// ==========================================
// ENDPOINT: Broadcast masivo manual
// ==========================================
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

// ==========================================
// 3. CRON JOB: RECORDATORIOS INTELIGENTES (Cada 5 min)
// ==========================================
cron.schedule("*/5 * * * *", async () => {
  try {
    console.log("⏰ Iniciando Cron Job de recordatorios...");

    const adminExp = process.env.ADMIN_EXP;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminExp || !adminPassword) {
      console.error("❌ Error: ADMIN_EXP o ADMIN_PASSWORD no están configurados en Render.");
      return;
    }

    // Obtener la hora y fecha local de Querétaro/CDMX
    const cdmxString = new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" });
    const ahora = new Date(cdmxString);

    // Rango de evaluación (próximos 5 a 15 minutos)
    const tiempoMinimo = new Date(ahora.getTime() + 5 * 60 * 1000);
    const tiempoMaximo = new Date(ahora.getTime() + 15 * 60 * 1000);

    console.log(`🕒 Rango de evaluación corregido (Local UAQ): [${tiempoMinimo.toLocaleTimeString('es-MX', {hour12:false})}] hasta [${tiempoMaximo.toLocaleTimeString('es-MX', {hour12:false})}]`);

    // Autenticación con el Backend Principal
    const loginRes = await axios.post("https://tefif-backend.onrender.com/api/tefif/users/login", {
      exp: String(adminExp).trim(),
      password: String(adminPassword).trim()
    }, { timeout: 7000 });

    const { token } = loginRes.data;

    // Consulta de eventos al calendario
    const res = await axios.get(
      "https://tefif-backend.onrender.com/api/tefif/calendar",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const eventos = res.data;

    // Formateador YYYY-MM-DD local
    const formatearFechaLocal = (d) => {
      const year = d.getFullYear();
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      const day = d.getDate().toString().padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    const fechaHoyLocal = formatearFechaLocal(ahora);

    for (const item of eventos) {
      // Filtro 1: Que corresponda al día de hoy
      if (item.start_date === fechaHoyLocal) {
        
        // CANDADO ANTI-SPAM DEFINITIVO: ¿Ya se notificó este evento?
        // Usamos el id único del evento o calendario para comprobar
        const eventoId = item.calendar_id || item.event_id || item.id;
        if (recordatoriosEnviadosHoy.has(eventoId)) {
          console.log(`⏭️ El evento "${item.event?.name || 'Sin nombre'}" (ID: ${eventoId}) ya fue notificado hoy. Saltando para evitar spam...`);
          continue; // Se salta al siguiente evento de la lista
        }

        // Reconstrucción matemática de la hora del evento
        const [horaEv, minEv] = item.start_time.split(':');
        const fechaEvento = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), parseInt(horaEv), parseInt(minEv));

        // Filtro 2: Que esté en la ventana de tiempo correcta
        if (fechaEvento >= tiempoMinimo && fechaEvento <= tiempoMaximo) {
          console.log(`🎯 ¡Evento en rango detectado: "${item.event?.name}"! Obteniendo tokens...`);
          
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
            
            const pushRes = await admin.messaging().sendEachForMulticast(message);
            console.log(`📢 Recordatorio enviado con éxito. Dispositivos alertados: ${pushRes.successCount}`);
            
            // EL TRUCO: Guardamos el ID en el Set de memoria para que no vuelva a entrar en la próxima vuelta
            recordatoriosEnviadosHoy.add(eventoId);
            console.log(`🔒 ID ${eventoId} bloqueado en memoria anti-spam por el resto del día.`);
          } else {
            console.log("⚠️ No hay tokens registrados en Firestore para enviar el recordatorio.");
          }
        }
      }
    }
    console.log("🏁 Ciclo de verificación finalizado correctamente.");
  } catch (error) {
    console.error("❌ Error en Cron Job de recordatorios:", error.response?.data?.message || error.message);
  }
});

// ==========================================
// 4. CRON JOB EXTRA: LIMPIEZA DE HISTORIAL (A la medianoche)
// ==========================================
// Este cron corre todos los días a las 00:00 hrs para liberar la memoria y permitir alertas al día siguiente
cron.schedule("0 0 * * *", () => {
  recordatoriosEnviadosHoy.clear();
  console.log("🧹 Memoria anti-spam reiniciada con éxito para el nuevo día.");
}, {
  scheduled: true,
  timezone: "America/Mexico_City" // Nos aseguramos de que limpie a la medianoche de México
});

// ==========================================
// 5. INICIALIZACIÓN DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor de notificaciones TEFIF corriendo de forma segura en el puerto ${PORT}`),
);