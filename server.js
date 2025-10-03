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
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://futbol-mp-backend.onrender.com';

if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no está seteado. Setéalo en Render > Environment.');
}

const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

app.get('/', (_req, res) => res.send('OK futbol-mp-backend'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/**
 * POST /mp/create-preference
 * body: {
 *   title: string,
 *   unit_price: number,          // precio total real de la cancha (p. ej. 2345)
 *   external_reference: string,  // clave de tu reserva (YYYY-MM-DD|tipo|HH:MM o similar)
 *   payer?: { email?: string, name?, surname?, ... },
 *   payFull?: boolean,           // si true, cobra 100%
 *   deposit_pct?: number         // si payFull = false, cobra este porcentaje (default 30)
 * }
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      unit_price = 0,
      external_reference,
      payer = {},
      payFull = false,
      deposit_pct,
    } = req.body || {};

    const priceNum = Number(unit_price) || 0;
    // Si NO es pago total, cobramos porcentaje (default 30%)
    const pct = payFull ? 100 : (Number(deposit_pct) || 30);
    let charge = (priceNum * pct) / 100;

    // Importante: Mercado Pago toma hasta 2 decimales. Redondeamos a 2 para evitar diferencias.
    charge = Math.round(charge * 100) / 100;

    const pref = new Preference(mp);

    const body = {
      items: [
        {
          id: external_reference || 'booking',
          title,
          quantity: 1,
          currency_id: 'ARS',
          unit_price: charge,
        },
      ],
      payer,
      external_reference: external_reference || undefined,
      notification_url: `${PUBLIC_URL}/mp/webhook`,
      back_urls: {
        success: `${PUBLIC_URL}/mp/success`,
        failure: `${PUBLIC_URL}/mp/failure`,
        pending: `${PUBLIC_URL}/mp/pending`,
      },
      auto_return: 'approved',
      // (Opcional) si querés solo tarjeta y no efectivo/atm:
      // payment_methods: {
      //   excluded_payment_types: [
      //     { id: 'ticket' }, // sin efectivo
      //     { id: 'atm' },    // sin atm
      //   ],
      // },
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,                 // producción
      sandbox_init_point: result.sandbox_init_point, // sandbox
      charged_amount: charge,                        // debug para que veas el monto cobrado
      charged_pct: pct,                              // debug
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res.status(500).json({ error: true, message: String(err?.message || err) });
  }
});

/**
 * Webhook: MP llama con ?type=payment&data.id=########
 * (Acá podés actualizar Firestore cuando esté aprobado)
 */
app.post('/mp/webhook', async (req, res) => {
  try {
    const { type, 'data.id': dataId } = { ...req.query, ...req.body?.data };
    const paymentId = req.query?.['data.id'] || dataId;

    console.log('[WEBHOOK] query:', req.query);
    console.log('[WEBHOOK] body:', JSON.stringify(req.body));

    if (String(type).toLowerCase() === 'payment' && paymentId) {
      const payment = new Payment(mp);
      const info = await payment.get({ id: paymentId });

      console.log('[PAYMENT]', {
        id: info.id,
        status: info.status,               // approved | rejected | in_process
        external_reference: info.external_reference,
        transaction_amount: info.transaction_amount,
      });

      // TODO: si status === 'approved'
      // - crear la reserva en Firestore (confirmada) con external_reference
      // - o actualizar su estado, etc.
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
