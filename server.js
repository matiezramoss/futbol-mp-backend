// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// ======================= FIREBASE ADMIN =======================
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ======================= MERCADOPAGO CONFIG ===================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const USE_MP_PROD = String(process.env.USE_MP_PROD).toLowerCase() === "true";
const PUBLIC_URL = process.env.PUBLIC_URL || "https://futbol-mp-backend.onrender.com";

// Health
app.get("/health", (req, res) => res.send("ok"));

// ======================= CREATE PREFERENCE ===================
app.post("/mp/create-preference", async (req, res) => {
  try {
    const { title, quantity, unit_price, external_reference, payer } = req.body;

    const body = {
      items: [
        {
          title: title || "Reserva",
          quantity: quantity || 1,
          currency_id: "ARS",
          unit_price: Number(unit_price),
        },
      ],
      payer: payer || {},
      external_reference,
      back_urls: {
        success: `${PUBLIC_URL}/mp/success`,
        failure: `${PUBLIC_URL}/mp/failure`,
        pending: `${PUBLIC_URL}/mp/pending`,
      },
      auto_return: "approved",
      notification_url: `${PUBLIC_URL}/mp/webhook`,
    };

    const resp = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error("MP create error:", data);
      return res.status(400).json({ error: true, message: data });
    }

    return res.json(data);
  } catch (e) {
    console.error("create-preference fail", e);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ======================= WEBHOOK ===================
app.post("/mp/webhook", async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === "payment") {
      const paymentId = data.id;

      // Buscar info del pago
      const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const pago = await resp.json();

      if (pago.status === "approved") {
        const externalRef = pago.external_reference; // acá viene tu reserva
        const amount = pago.transaction_amount;

        // externalRef = complejoId|fecha|hora|tipo|uid  (ejemplo de convención)
        const [complejoId, fecha, hora, tipo, uid] = (externalRef || "").split("|");

        if (complejoId && fecha && hora && tipo && uid) {
          const reservaRef = db.collection("complejos").doc(complejoId).collection("reservas").doc();

          await reservaRef.set({
            fecha,
            hora,
            tipo: Number(tipo),
            estado: "confirmada",
            channel: "mp",
            createdBy: uid,
            price: amount,
            paymentId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log("Reserva creada por webhook ✅", reservaRef.id);
        } else {
          console.warn("External reference inválido:", externalRef);
        }
      }

      if (pago.status === "rejected") {
        console.log("Pago rechazado, nada que crear");
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});

// ===================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
