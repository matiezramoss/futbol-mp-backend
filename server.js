// server.js
const express = require('express');
const cors = require('cors');
const mercadopago = require('mercadopago');
const admin = require('firebase-admin');

const app = express();

// Middlewares (MP a veces manda urlencoded)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS: RN no necesita CORS, pero si querés testear desde web, dejalo abierto
app.use(cors({ origin: true }));

/**
 * ====== Config Mercado Pago ======
 * Usá tu ACCESS_TOKEN de TEST en Render (variable MP_ACCESS_TOKEN)
 */
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no seteado');
}
mercadopago.configurations.setAccessToken(MP_ACCESS_TOKEN);

/**
 * ====== Config Firebase Admin ======
 * En Render setearás FIREBASE_SERVICE_ACCOUNT con el JSON completo
 * del service account (pegado tal cual).
 */
const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : null;

if (!admin.apps.length) {
  if (svcJson) {
    admin.initializeApp({
      credential: admin.credential.cert(svcJson),
    });
  } else {
    console.warn('[WARN] FIREBASE_SERVICE_ACCOUNT no seteado — No se podrá escribir en Firestore');
    admin.initializeApp();
  }
}

const db = admin.firestore();

/** Salud */
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

/**
 * Crea una preferencia de pago.
 * body esperado:
 * {
 *   reservaId, complejoId, title, price,
 *   quantity?, payer?: { email, name },
 *   backUrls?: { success, failure, pending }
 * }
 */
app.post('/create-preference', async (req, res) => {
  try {
    const {
      reservaId,
      complejoId,
      title,
      price,
      quantity = 1,
      payer = {},
      backUrls = {},
      metadata = {}
    } = req.body || {};

    if (!reservaId || !complejoId || !price) {
      return res.status(400).json({ error: 'Falta reservaId/complejoId/price' });
    }

    const external_reference = `${complejoId}|${reservaId}`;

    // Construyo la notification_url con el host público del propio server
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const notification_url = `${baseUrl}/webhook`;

    const preference = {
      items: [
        {
          title: title || `Reserva ${reservaId}`,
          quantity: Number(quantity) || 1,
          unit_price: Number(price),
        },
      ],
      payer: {
        email: payer.email || undefined,
        name: payer.name || undefined,
      },
      external_reference,
      metadata,
      back_urls: {
        success: backUrls.success || `${baseUrl}/ok`,
        failure: backUrls.failure || `${baseUrl}/fail`,
        pending: backUrls.pending || `${baseUrl}/pending`,
      },
      auto_return: 'approved',
      notification_url, // 👈 Render es público: MP puede pegar acá
    };

    const mpRes = await mercadopago.preferences.create(preference);
    const { id, init_point, sandbox_init_point } = mpRes.body || {};

    return res.json({
      preference_id: id,
      init_point,
      sandbox_init_point,
    });
  } catch (e) {
    console.error('create-preference error', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * Webhook de MP:
 * - MP envía { data: { id }, action, type } (varía)
 * - Consultamos el pago por ID y actualizamos la reserva en Firestore:
 *   /complejos/{complejoId}/reservas/{reservaId}
 */
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('[webhook] raw body:', JSON.stringify(body).slice(0, 1000));

    // MP suele mandar { data: { id }, type: 'payment', action: 'payment.updated' }
    const paymentId = body?.data?.id || body?.id || body?.resource?.split('/').pop();
    if (!paymentId) {
      // Aceptamos igual para que MP no reintente eternamente
      return res.status(200).send('ok - no payment id');
    }

    // Busco el pago en MP
    const r = await mercadopago.payment.findById(paymentId);
    const payment = r?.response || {};
    const status = payment?.status; // approved | rejected | pending | in_process
    const external_reference = payment?.external_reference || '';
    const orderId = payment?.order?.id;

    console.log('[webhook] payment:', { paymentId, status, external_reference, orderId });

    // Parseo referencia "complejoId|reservaId"
    if (external_reference && external_reference.includes('|') && svcJson) {
      const [complejoId, reservaId] = external_reference.split('|');

      const ref = db.doc(`complejos/${complejoId}/reservas/${reservaId}`);
      const update = {
        mpPaymentId: String(paymentId),
        mpStatus: String(status || ''),
        mpRaw: payment,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (status === 'approved') {
        update.estado = 'confirmada';
        update.paidAt = admin.firestore.FieldValue.serverTimestamp();
      } else if (status === 'rejected') {
        update.estado = 'rechazada';
      } else {
        update.estado = 'pending';
      }

      await ref.set(update, { merge: true });
      console.log('[webhook] Firestore actualizado =>', complejoId, reservaId, update.estado);
    } else {
      console.log('[webhook] sin external_reference o sin FIREBASE_SERVICE_ACCOUNT — omito Firestore');
    }

    // Importante: devolver 200/201/204 rápido para que MP no reintente
    return res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error', e);
    // Devolvemos 200 igual para evitar reintentos infinitos (en sandbox)
    return res.status(200).send('ok');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MP backend listening on port ${PORT}`);
});
