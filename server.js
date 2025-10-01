// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// SDK v2
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // sin / al final

if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no está seteado. Setéalo en Render > Environment.');
}
if (!PUBLIC_URL) {
  console.warn('[WARN] PUBLIC_URL no está seteado. Setéalo en Render > Environment (https://TUAPP.onrender.com).');
}

// Cliente MP
const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/** Health / raíz */
app.get('/', (_req, res) => res.send('OK futbol-mp-backend'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/**
 * Crea preferencia
 * body: { title, quantity, unit_price, external_reference, notification_url?, payer? }
 * Forzamos wallet de Mercado Pago (sin pedir tarjeta) con purpose: 'wallet_purchase'
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      quantity = 1,
      unit_price = 1000,
      external_reference,          // ej: ID de tu reserva en Firestore
      notification_url,            // opcional: si no lo mandás, usa /mp/webhook de este server
      payer = {},
    } = req.body || {};

    const pref = new Preference(mp);

    const body = {
      items: [
        {
          id: external_reference || 'booking',
          title,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: Number(unit_price) || 1000,
        },
      ],
      payer,
      external_reference: external_reference || undefined,

      // 👉 si no viene por body, usamos el webhook de este backend
      notification_url: notification_url || `${PUBLIC_URL}/mp/webhook`,

      // URLs de retorno (no imprescindibles, pero útiles si abrís en WebView)
      back_urls: {
        success: `${PUBLIC_URL}/success`,
        failure: `${PUBLIC_URL}/failure`,
        pending: `${PUBLIC_URL}/pending`,
      },
      auto_return: 'approved',

      // 🔒 Sólo billetera de MP (sin formulario de tarjeta)
      purpose: 'wallet_purchase',
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,                 // producción
      sandbox_init_point: result.sandbox_init_point, // pruebas
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res.status(500).json({ error: true, message: String(err?.message || err) });
  }
});

/**
 * Webhook de MP
 * MP pega con: ?type=payment&data.id=########
 */
app.post('/mp/webhook', async (req, res) => {
  try {
    // MP manda info por querystring (type, data.id). En algunos casos viene topic/data.id.
    const type = req.query?.type || req.query?.topic;
    const paymentId = req.query?.['data.id'] || req.query?.id;

    console.log('[WEBHOOK] query:', req.query);
    console.log('[WEBHOOK] body:', JSON.stringify(req.body));

    if (String(type).toLowerCase() === 'payment' && paymentId) {
      const payment = new Payment(mp);
      const info = await payment.get({ id: paymentId });

      // info.status: 'approved' | 'rejected' | 'in_process' | ...
      console.log('[PAYMENT]', {
        id: info.id,
        status: info.status,
        external_reference: info.external_reference,
        transaction_amount: info.transaction_amount,
      });

      // 👉 Acá: actualizar la reserva en Firestore:
      // if (info.status === 'approved') { ... }
    }

    // Siempre 200 (MP reintenta si no)
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200);
  }
});

// Páginas simples de retorno (útiles para pruebas)
app.get('/success', (_req, res) => res.send('Pago aprobado ✅'));
app.get('/failure', (_req, res) => res.send('Pago rechazado ❌'));
app.get('/pending', (_req, res) => res.send('Pago pendiente ⏳'));

// Puesto en marcha
app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
