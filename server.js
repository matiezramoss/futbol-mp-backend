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
 * body: { title, unit_price, external_reference, payFull?, deposit_pct?, payer? }
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      unit_price = 1000,
      quantity = 1,
      external_reference,
      payer = {},
      payFull = false,
      deposit_pct = null,
    } = req.body || {};

    let finalAmount = Number(unit_price) || 0;
    let pctApplied = null;

    if (!payFull && deposit_pct != null) {
      // Si no pidió total y viene un porcentaje → cobramos solo ese %
      finalAmount = Math.round((finalAmount * deposit_pct) / 100 * 100) / 100;
      pctApplied = deposit_pct;
    } else {
      // Pago total
      pctApplied = 100;
    }

    const pref = new Preference(mp);

    const body = {
      items: [
        {
          id: external_reference || 'booking',
          title,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: finalAmount,
        },
      ],
      payer,
      external_reference: external_reference || undefined,
      notification_url: `${process.env.PUBLIC_URL || 'https://futbol-mp-backend.onrender.com'}/mp/webhook`,
      back_urls: {
        success: `${process.env.PUBLIC_URL || 'https://futbol-mp-backend.onrender.com'}/mp/success`,
        failure: `${process.env.PUBLIC_URL || 'https://futbol-mp-backend.onrender.com'}/mp/failure`,
        pending: `${process.env.PUBLIC_URL || 'https://futbol-mp-backend.onrender.com'}/mp/pending`,
      },
      auto_return: 'approved',
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      charged_amount: finalAmount,
      pct_applied: pctApplied,
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res.status(500).json({ error: true, message: String(err?.message || err) });
  }
});

/**
 * Webhook de MP
 */
app.post('/mp/webhook', async (req, res) => {
  try {
    const { type, 'data.id': dataId } = { ...req.query, ...req.body?.data };

    console.log('[WEBHOOK] query:', req.query);
    console.log('[WEBHOOK] body:', JSON.stringify(req.body));

    const paymentId = req.query?.['data.id'] || dataId;
    if (String(type).toLowerCase() === 'payment' && paymentId) {
      const payment = new Payment(mp);
      const info = await payment.get({ id: paymentId });

      console.log('[PAYMENT]', {
        id: info.id,
        status: info.status,
        external_reference: info.external_reference,
        transaction_amount: info.transaction_amount,
      });

      // 👉 Acá actualizar Firestore según status
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200);
  }
});

// Puesto en marcha
app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
