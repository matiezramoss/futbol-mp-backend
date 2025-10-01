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
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no está seteado. Setéalo en Render > Environment.');
}

// Cliente MP
const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/** Health / raíz */
app.get('/', (_req, res) => res.send('OK futbol-mp-backend'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/**
 * Crea preferencia
 * body: { title, quantity, unit_price, external_reference, notification_url? }
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      quantity = 1,
      unit_price = 1000,
      external_reference,          // ej: ID de tu reserva en Firestore
      notification_url,            // opcional: si no lo mandás, usa /mp/webhook de este server
      payer = {}
    } = req.body || {};

    const pref = new Preference(mp);

    const body = {
      items: [
        {
          id: external_reference || 'booking',
          title,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: Number(unit_price) || 1000
        }
      ],
      payer,
      external_reference: external_reference || undefined,
      notification_url:
        notification_url ||
        `${process.env.PUBLIC_URL || ''}/mp/webhook`, // tu dominio de Render + /mp/webhook
      back_urls: {
        success: `${process.env.PUBLIC_URL || ''}/success`,
        failure: `${process.env.PUBLIC_URL || ''}/failure`,
        pending: `${process.env.PUBLIC_URL || ''}/pending`
      },
      auto_return: 'approved'
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,               // producción
      sandbox_init_point: result.sandbox_init_point // pruebas
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
    // MP manda info por querystring (type, data.id) y también firma el body para otros eventos
    const { type, 'data.id': dataId } = { ...req.query, ...req.body?.data };

    console.log('[WEBHOOK] query:', req.query);
    console.log('[WEBHOOK] body:', JSON.stringify(req.body));

    // Sólo atendemos pagos
    const paymentId = req.query?.['data.id'] || dataId;
    if (String(type).toLowerCase() === 'payment' && paymentId) {
      const payment = new Payment(mp);
      const info = await payment.get({ id: paymentId });

      // info.status puede ser 'approved', 'rejected', 'in_process'
      console.log('[PAYMENT]', {
        id: info.id,
        status: info.status,
        external_reference: info.external_reference,
        transaction_amount: info.transaction_amount
      });

      // 👉 Acá es donde vos deberías:
      // - actualizar la reserva en Firestore a "confirmada" si status === 'approved'
      // - o marcarla según corresponda
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    // MP quiere 200 siempre para no reintentar indefinidamente; si querés, logueá el error.
    res.sendStatus(200);
  }
});

// Puesto en marcha
app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
