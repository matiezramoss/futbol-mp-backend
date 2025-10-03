// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// SDK v2
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

const app = express();
app.use(cors({
  origin: '*', // si querés restringir: ['https://TU-APP.com', 'exp://...']
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // ej: https://futbol-mp-backend.onrender.com
const DEFAULT_DEPOSIT_PCT = Number(process.env.DEPOSIT_PCT || 30); // % por defecto para señas

if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no está seteado. Setealo en Render > Environment.');
}

const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/** Root / health */
app.get('/', (_req, res) => res.send('OK futbol-mp-backend'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/**
 * Crea preferencia
 * Request JSON:
 * {
 *   title, quantity, unit_price, external_reference,
 *   payer, deposit_pct
 * }
 *
 * - unit_price: precio TOTAL de la cancha (en pesos, sin separadores) p.ej. 31870
 * - deposit_pct: 30 para seña 30%, 100 para total. Si no viene, usa DEFAULT_DEPOSIT_PCT
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      quantity = 1,
      unit_price = 0,             // precio TOTAL de la cancha
      external_reference,         // ej: "complejoId|YYYY-MM-DD|tipo|HH:MM"
      notification_url,           // opcional: por defecto usamos /mp/webhook
      payer = {},
      deposit_pct,                // 30 ó 100 (o lo que mandes)
    } = req.body || {};

    // Normalizamos valores
    const unitPriceNum = Number(unit_price) || 0; // TOTAL en pesos
    const pct = Number.isFinite(Number(deposit_pct))
      ? Math.max(1, Math.min(100, Number(deposit_pct)))
      : Math.max(1, Math.min(100, DEFAULT_DEPOSIT_PCT));

    // 💰 Este es el **monto que se va a cobrar**: seña o total
    const chargeAmount = Math.round(unitPriceNum * pct / 100);

    // Etiquetas claras en el título según el % que se está cobrando
    const titleWithPct = pct === 100
      ? `${title} — Total`
      : `${title} — Seña ${pct}%`;

    const pref = new Preference(mp);
    const body = {
      items: [
        {
          id: external_reference || 'booking',
          title: titleWithPct,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: chargeAmount, // 👈 COBRAMOS EL MONTO CALCULADO (seña o total)
        }
      ],
      payer,
      external_reference: external_reference || undefined,
      notification_url: notification_url || (PUBLIC_URL ? `${PUBLIC_URL}/mp/webhook` : undefined),
      back_urls: PUBLIC_URL
        ? {
            success: `${PUBLIC_URL}/success`,
            failure: `${PUBLIC_URL}/failure`,
            pending: `${PUBLIC_URL}/pending`,
          }
        : undefined,
      auto_return: 'approved',
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      charged_amount: chargeAmount,  // (info útil para debug)
      pct_applied: pct,              // (info útil para debug)
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res
      .status(500)
      .json({ error: true, message: String(err?.message || err) });
  }
});

/**
 * Webhook de MP
 * MP pega con: ?type=payment&data.id=########
 * Acá confirmás pagos y actualizás en tu Firestore (si corresponde).
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

      // info.status: 'approved', 'rejected', 'in_process'
      console.log('[PAYMENT]', {
        id: info.id,
        status: info.status,
        external_reference: info.external_reference,
        transaction_amount: info.transaction_amount,
      });

      // 👉 TODO (si querés): confirmar reserva en Firestore cuando status === 'approved'
      // usando info.external_reference (p. ej. complejoId|fecha|tipo|hora)
    }

    // MP prefiere 200 siempre.
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
