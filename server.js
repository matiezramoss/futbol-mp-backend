// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// SDK v2 MP
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

// Expo Push
import { Expo } from 'expo-server-sdk';

// Firebase Admin (para Firestore server-side)
import admin from 'firebase-admin';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // tu dominio render, ej: https://futbol-mp-backend.onrender.com
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ===== Validaciones mínimas =====
if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no está seteado. Setéalo en Render > Environment.');
}
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.warn('[WARN] Credenciales Firebase Admin no seteadas (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)');
}

// ===== MP Cliente =====
const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// ===== Firebase Admin init (idempotente) =====
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY,
      }),
    });
    console.log('[FB-ADMIN] inicializado');
  } catch (e) {
    console.error('[FB-ADMIN] init error:', e);
  }
}
const fdb = admin.firestore();

// ===== Expo Push =====
const expo = new Expo();

// Health
app.get('/', (_req, res) => res.send('OK futbol-mp-backend'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/**
 * POST /mp/create-preference
 * body: {
 *   title, quantity, unit_price, external_reference,
 *   payer,
 *   pct  // porcentaje opcional (ej 30 para cobrar seña), si no viene cobra total
 *   metadata: { complejoId, complejoName, fecha, hora, tipo, userId }
 * }
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      quantity = 1,
      unit_price = 1000,
      external_reference,     // ej: "userId|YYYY-MM-DD|tipo|HH:MM" (legacy)
      payer = {},
      pct,                    // si viene ej 30 => cobra % del unit_price
      metadata = {},          // COMPLEJO y detalle para el webhook
    } = req.body || {};

    const chargedUnitPrice =
      typeof pct === 'number' && pct > 0
        ? Math.round((Number(unit_price) || 0) * pct / 100)
        : Number(unit_price) || 0;

    const pref = new Preference(mp);
    const body = {
      items: [
        {
          title,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: chargedUnitPrice,
        },
      ],
      payer,
      external_reference: external_reference || undefined,
      metadata, // 👈 importante para el webhook (complejoId, etc.)
      notification_url: `${PUBLIC_URL}/mp/webhook`,
      back_urls: {
        success: `${PUBLIC_URL}/mp/success`,
        failure: `${PUBLIC_URL}/mp/failure`,
        pending: `${PUBLIC_URL}/mp/pending`,
      },
      auto_return: 'approved',
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      charged_amount: chargedUnitPrice * (Number(quantity) || 1),
      pct_applied: typeof pct === 'number' ? pct : null,
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res.status(500).json({ error: true, message: String(err?.message || err) });
  }
});

/**
 * Helper: crear/actualizar reserva en Firestore cuando MP aprueba
 * El documento se guarda en: complejos/{complejoId}/reservas/{autoID}
 */
async function upsertReservaApproved({ meta, paymentInfo }) {
  const {
    complejoId,
    complejoName,
    fecha,
    hora,
    tipo,
    userId,
    fullName,
    phone,
    email,
  } = meta || {};

  if (!complejoId || !fecha || !hora || !tipo) {
    console.warn('[RESERVA] Faltan datos clave en metadata, no se crea reserva.', meta);
    return null;
  }

  const key = `${fecha}|${tipo}|${hora}`;
  const col = fdb.collection('complejos').doc(complejoId).collection('reservas');
  const docRef = col.doc(); // auto-id

  const payload = {
    key,
    fecha,
    tipo: Number(tipo) || tipo,
    hora,
    userId: userId || null,
    estado: 'confirmada',         // aprobado => confirmada (ocupa cupo)
    channel: 'online',
    createdBy: userId || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    fullName: fullName || null,
    phone: phone || null,
    email: email || null,
    complejoName: complejoName || null,
    mpPaymentId: paymentInfo?.id || null,
    mpStatus: paymentInfo?.status || null,
    mpTotalPaid: paymentInfo?.transaction_amount || null,
  };

  await docRef.set(payload);
  return { id: docRef.id, ...payload, complexId: complejoId };
}

/**
 * Helper: buscar admins del complejo y sus tokens
 */
async function getAdminPushTokens(complejoId) {
  const qs = await fdb
    .collection('users')
    .where('isAdmin', '==', true)
    .where('adminOf', 'array-contains', String(complejoId))
    .get();

  const tokens = [];
  qs.forEach((d) => {
    const t = d.data()?.expoPushToken;
    if (typeof t === 'string' && t.startsWith('ExponentPushToken')) {
      tokens.push({ token: t, userId: d.id });
    }
  });
  return tokens;
}

/**
 * Helper: enviar notificaciones vía Expo
 */
async function sendExpoPush({ tokens, title, body, data }) {
  if (!tokens?.length) return;

  const messages = tokens.map(({ token }) => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      console.log('[PUSH] receipts:', receipts);
    } catch (e) {
      console.error('[PUSH] error sending chunk:', e);
    }
  }
}

/**
 * Webhook MP
 * MP llama con ?type=payment&data.id=########
 */
app.post('/mp/webhook', async (req, res) => {
  try {
    const { type } = req.query || {};
    const paymentId = req.query?.['data.id'] || req.body?.data?.id || req.body?.['data.id'];

    console.log('[WEBHOOK] query:', req.query);
    console.log('[WEBHOOK] body:', JSON.stringify(req.body));

    if (String(type).toLowerCase() !== 'payment' || !paymentId) {
      // no es un pago, respondemos 200 igual para frenar reintentos
      return res.sendStatus(200);
    }

    const payment = new Payment(mp);
    const info = await payment.get({ id: paymentId });

    console.log('[PAYMENT]', {
      id: info.id,
      status: info.status,
      external_reference: info.external_reference,
      transaction_amount: info.transaction_amount,
      metadata: info.metadata,
    });

    if (info.status === 'approved') {
      // Creamos/actualizamos la reserva...
      const reserva = await upsertReservaApproved({
        meta: info.metadata || {},
        paymentInfo: info,
      });

      // ...y si tenemos complejoId, notificamos admins
      const complejoId = info.metadata?.complejoId;
      if (complejoId) {
        const tokens = await getAdminPushTokens(complejoId);
        if (tokens.length) {
          await sendExpoPush({
            tokens,
            title: 'Nueva reserva acreditada',
            body: `${info.metadata?.complejoName || 'Tu complejo'} — ${info.metadata?.fecha} ${info.metadata?.hora} (F${info.metadata?.tipo})`,
            data: {
              type: 'booking_approved',
              complejoId,
              fecha: info.metadata?.fecha,
              hora: info.metadata?.hora,
              tipo: info.metadata?.tipo,
            },
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200); // MP prefiere 200 para cortar reintentos
  }
});

// Start
app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
