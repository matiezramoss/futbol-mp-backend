// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// MP SDK v2
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

// Firebase Admin (para buscar admins y tokens)
import admin from 'firebase-admin';

const app = express();

// CORS (permití tu app o * si querés abierto mientras desarrollás)
const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no está seteado.');
}
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://futbol-mp-backend.onrender.com';

// Inicializar Firebase Admin (si no estaba)
if (!admin.apps.length) {
  try {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : null;
    admin.initializeApp({
      credential: svc ? admin.credential.cert(svc) : admin.credential.applicationDefault(),
    });
  } catch (e) {
    console.error('[FIREBASE ADMIN] init error:', e);
  }
}
const fs = admin.firestore();

// MP client
const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/** Health / raíz */
app.get('/', (_req, res) => res.send('OK futbol-mp-backend'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/**
 * Helper: enviar push por Expo
 * Requiere dev build / app instalada en el dispositivo donde está ese token
 */
async function sendExpoPush({ to, title, body, data = {} }) {
  if (!to) return;
  const payload = { to, title, body, data, sound: 'default' };
  const resp = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try { console.log('[PUSH]', await resp.json()); } catch {}
}

/**
 * Crea preferencia
 * body: { title, quantity, unit_price, external_reference, notification_url?, payer?, payFull?, deposit_pct? }
 * - Si payFull === true => cobra unit_price
 * - Si payFull === false => cobra (unit_price * deposit_pct / 100)
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      quantity = 1,
      unit_price = 1000,
      external_reference,
      notification_url,
      payer = {},
      payFull = false,
      deposit_pct = 30,
    } = req.body || {};

    const baseAmount = Number(unit_price) || 0;
    const charged = payFull ? baseAmount : Math.round((baseAmount * deposit_pct) / 100);

    const pref = new Preference(mp);
    const body = {
      items: [
        {
          title,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: charged,
        },
      ],
      payer,
      external_reference: external_reference || undefined,
      // back_urls a tu backend (pueden redirigir a pantallas de éxito si querés)
      back_urls: {
        success: `${PUBLIC_URL}/mp/success`,
        failure: `${PUBLIC_URL}/mp/failure`,
        pending: `${PUBLIC_URL}/mp/pending`,
      },
      auto_return: 'approved',
      notification_url: notification_url || `${PUBLIC_URL}/mp/webhook`,
      // Metadata para auditoría
      metadata: {
        base_price: baseAmount,
        payFull,
        deposit_pct,
        charged_amount: charged,
      },
      additional_info: `charged=${charged}; payFull=${payFull}; deposit_pct=${deposit_pct}`,
      payment_methods: {
        // ejemplo: excluir ATM y pay_on_delivery
        excluded_payment_types: [{ id: 'atm' }],
      },
    };

    const result = await pref.create({ body });
    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      charged_amount: charged,
      pct_applied: payFull ? 100 : deposit_pct,
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res.status(500).json({ error: true, message: String(err?.message || err) });
  }
});

/**
 * Webhook de MP (payment events)
 * MP pega con: ?type=payment&data.id=########
 */
app.post('/mp/webhook', async (req, res) => {
  try {
    const { type, 'data.id': dataId } = { ...req.query, ...req.body?.data };
    const paymentId = req.query?.['data.id'] || dataId;

    console.log('[WEBHOOK] query:', req.query);
    console.log('[WEBHOOK] body:', JSON.stringify(req.body || {}));

    if (String(type).toLowerCase() === 'payment' && paymentId) {
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
        // external_reference viene como: `${complejoId}|${fecha}|${tipo}|${hora}`
        const complexId = String(info.external_reference || '').split('|')[0];

        // (A) TODO: acá confirmás/creás la reserva en Firestore (tu lógica)
        // ...

        // (B) Enviamos push a admins del complejo (si hay tokens)
        try {
          if (complexId) {
            const qs = await fs
              .collection('users')
              .where('isAdmin', '==', true)
              .where('adminOf', 'array-contains', complexId)
              .get();

            const tokens = [];
            qs.forEach(d => {
              const t = d.data()?.pushToken;
              if (t) tokens.push(t);
            });

            await Promise.all(
              tokens.map(t =>
                sendExpoPush({
                  to: t,
                  title: 'Nueva reserva',
                  body: `Pago aprobado (${info.transaction_amount}) — ${info.external_reference}`,
                  data: {
                    type: 'booking-approved',
                    external_reference: info.external_reference,
                    payment_id: info.id,
                    amount: info.transaction_amount,
                  },
                })
              )
            );
          }
        } catch (e) {
          console.error('push admins error:', e);
        }
      }
    }

    // MP espera 200 siempre para evitar reintentos infinitos
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200);
  }
});

// Endpoints simples para redirecciones (opcionales)
app.get('/mp/success', (_req, res) => res.send('Pago aprobado'));
app.get('/mp/failure', (_req, res) => res.send('Pago fallido'));
app.get('/mp/pending', (_req, res) => res.send('Pago pendiente'));

// Start
app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
