// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// SDK v2 Mercado Pago
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

// PDF
import PDFDocument from 'pdfkit';

// Firebase Admin
import admin from 'firebase-admin';

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
} catch (e) {
  console.warn('[WARN] admin.initializeApp()', e?.message || e);
}

const db = admin.firestore();
const { FieldValue } = admin.firestore;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Comisión fija por transacción (tuya)
const COMMISSION_FIXED = 1000;

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
 * body: {
 *   title, quantity, unit_price, external_reference,
 *   payFull?: boolean, deposit_pct?: number,
 *   payer?, notification_url?,
 *   // opcionales (si los mandás, los guardo en metadata):
 *   complejoId, name, fecha, hora, tipo, priceNum, userId, userEmail
 * }
 *
 * CAMBIO: se suma comisión fija de $1000 al monto cobrado en MP (visible para el usuario).
 */
app.post('/mp/create-preference', async (req, res) => {
  try {
    const {
      title = 'Reserva',
      quantity = 1,
      unit_price = 1000,
      external_reference, // ej: `${complejoId}|${fecha}|${tipo}|${hora}`
      notification_url,   // opcional (si no viene, uso /mp/webhook)
      payer = {},
      payFull = false,
      deposit_pct = 30,

      // extras que podés mandar desde tu app (los dejo en metadata)
      complejoId,
      name,
      fecha,
      hora,
      tipo,
      priceNum,
      userId,
      userEmail,
    } = req.body || {};

    // base de la reserva (precio que llega desde tu app)
    const base = Number(unit_price) || 0;

    // si hay seña, cobramos sólo una fracción de la base, pero igual sumamos la comisión fija
    const pct = Number(deposit_pct) || 30;
    const fraction = payFull ? 1 : (pct / 100);

    // monto correspondiente a la reserva (según seña o pago total)
    const baseFractionAmount = Number((base * fraction).toFixed(2));

    // monto final a cobrar en MP = fracción de base + comisión fija
    const chargedAmount = Number((baseFractionAmount + COMMISSION_FIXED).toFixed(2));

    const pref = new Preference(mp);

    const body = {
      items: [
        {
          id: external_reference || 'booking',
          title,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: chargedAmount, // 👈 lo que ve y paga el usuario (con $1000 incluidos)
        },
      ],
      payer,
      external_reference: external_reference || undefined,
      notification_url: notification_url || `${PUBLIC_URL}/mp/webhook`,
      back_urls: {
        success: `${PUBLIC_URL}/mp/success`,
        failure: `${PUBLIC_URL}/mp/failure`,
        pending: `${PUBLIC_URL}/mp/pending`,
      },
      auto_return: 'approved',
      metadata: {
        // modalización
        payFull: !!payFull,
        deposit_pct: payFull ? null : pct,

        // desglose de importes
        basePrice: base,                          // precio base de la reserva (sin comisión)
        base_fraction_amount: baseFractionAmount, // seña o total (según payFull)
        commission_fixed: COMMISSION_FIXED,       // $1000 fijos
        total: chargedAmount,                     // lo que se cobra en MP

        // extras opcionales para tracking
        complejoId,
        name,
        fecha,
        hora,
        tipo,
        priceNum,
        userId,
        userEmail,
      },
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      pct_applied: payFull ? 100 : pct,
      charged_amount: chargedAmount, // 👈 monto final con comisión
      base_fraction_amount: baseFractionAmount,
      commission_fixed: COMMISSION_FIXED,
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res
      .status(500)
      .json({ error: true, message: String(err?.message || err) });
  }
});

/* ============================================================
   Helper: registrar liquidación diaria (idempotente por pago)
   Ruta: liquidaciones/{complejoId}/days/{YYYY-MM-DD}
         subcolección pagos/{mp_payment_id}
   - Suma:
     * count_total
     * count_full / count_deposit
     * sum_total_charged (lo cobrado en MP, con comisión)
     * sum_commission (tus $1000 por pago)
     * sum_base_fraction (monto para el complejo por pago)
     * sum_net_to_complex (== sum_base_fraction)
   - Flag diario: pagado (default false)
   ============================================================ */
async function upsertDailySettlement({ complejoId, fecha, paymentInfo }) {
  if (!complejoId || !fecha || !paymentInfo) return;
  const {
    id: mp_payment_id,
    status,
    transaction_amount,   // == total cobrado en MP
    metadata = {},
  } = paymentInfo;

  const isFull = !!metadata?.payFull;
  const commission = Number(metadata?.commission_fixed ?? COMMISSION_FIXED) || COMMISSION_FIXED;
  const baseFraction = Number(metadata?.base_fraction_amount ?? 0) || 0;
  const totalCharged = Number(metadata?.total ?? transaction_amount ?? 0) || 0;

  const dayDoc = db.collection('liquidaciones')
    .doc(String(complejoId))
    .collection('days')
    .doc(String(fecha));

  const pagoDoc = dayDoc.collection('pagos').doc(String(mp_payment_id));

  await db.runTransaction(async (tx) => {
    const pagoSnap = await tx.get(pagoDoc);
    if (pagoSnap.exists) {
      // Ya fue contado: salimos (idempotencia)
      return;
    }

    // Crear el pago individual
    tx.set(pagoDoc, {
      mp_payment_id,
      status,
      createdAt: FieldValue.serverTimestamp(),
      total_charged: totalCharged,      // con comisión incluida
      commission,                       // $1000
      base_fraction: baseFraction,      // monto usable por el complejo (seña o total)
      payFull: isFull,
      deposit_pct: isFull ? null : (Number(metadata?.deposit_pct ?? 0) || 0),
    });

    // Inicializar día si no existe
    const daySnap = await tx.get(dayDoc);
    if (!daySnap.exists) {
      tx.set(dayDoc, {
        complejoId,
        fecha,                   // YYYY-MM-DD
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        pagado: false,           // para que lo marques desde la app al transferir
        pagadoAt: null,

        // agregados
        count_total: 0,
        count_full: 0,
        count_deposit: 0,
        sum_total_charged: 0,
        sum_commission: 0,
        sum_base_fraction: 0,
        sum_net_to_complex: 0,   // == sum_base_fraction
      }, { merge: true });
    }

    // Acumular
    tx.set(dayDoc, {
      updatedAt: FieldValue.serverTimestamp(),
      count_total: FieldValue.increment(1),
      count_full: FieldValue.increment(isFull ? 1 : 0),
      count_deposit: FieldValue.increment(isFull ? 0 : 1),
      sum_total_charged: FieldValue.increment(totalCharged),
      sum_commission: FieldValue.increment(commission),
      sum_base_fraction: FieldValue.increment(baseFraction),
      sum_net_to_complex: FieldValue.increment(baseFraction),
    }, { merge: true });
  });
}

/**
 * Webhook de MP
 * MP pega con: ?type=payment&data.id=########
 * Confirmamos reserva en Firestore cuando el pago está approved.
 *
 * CAMBIO: guardamos en `pago` el desglose (base / fracción / comisión / total).
 *         y registramos liquidación diaria (acumuladores por día/club).
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

      if (info.status === 'approved') {
        // external_reference = `${complejoId}|${fecha}|${tipo}|${hora}`
        const ref = String(info.external_reference || '');
        const [complejoId, fecha, tipo, hora] = ref.split('|');

        if (complejoId && fecha && tipo && hora) {
          // buscamos la reserva pendiente y la confirmamos
          const reservasRef = db
            .collection('complejos')
            .doc(complejoId)
            .collection('reservas');

          const snap = await reservasRef
            .where('fecha', '==', fecha)
            .where('tipo', '==', Number(tipo))
            .where('hora', '==', hora)
            .where('estado', 'in', ['pending', 'pendiente'])
            .limit(1)
            .get();

          if (!snap.empty) {
            const docRef = snap.docs[0].ref;

            const m = info?.metadata || {};

            await docRef.set(
              {
                estado: 'confirmada',
                pago: {
                  mp_payment_id: info.id,
                  status: info.status,
                  date_approved:
                    info.date_approved ||
                    admin.firestore.FieldValue.serverTimestamp(),

                  // montos
                  amount: info.transaction_amount, // lo que cobró MP (== total)
                  amount_base: m.basePrice ?? null,                // base (sin comisión)
                  amount_base_fraction: m.base_fraction_amount ?? null, // seña/total sin comisión
                  commission: m.commission_fixed ?? COMMISSION_FIXED,   // $1000 fijos
                  amount_total: m.total ?? info.transaction_amount,     // total cobrado (con comisión)

                  // modalidad
                  payFull: m.payFull ?? null,
                  deposit_pct: m.deposit_pct ?? null,
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            console.log('[WEBHOOK] Reserva confirmada en', docRef.path);

            // 👇 Registrar/acumular liquidación del día (idempotente)
            await upsertDailySettlement({
              complejoId,
              fecha,        // usamos la fecha de la reserva (YYYY-MM-DD)
              paymentInfo: info,
            });
          } else {
            console.log('[WEBHOOK] No se encontró reserva pendiente para', ref);
          }
        }
      }
    }

    // MP prefiere 200 siempre
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200);
  }
});

/* =====================================================================================
   PDF “on-the-fly” (NO guarda nada): genera y streamea el comprobante de una reserva
   ===================================================================================== */

/**
 * Helper: devuelve doc de reserva
 * - Ruta típica: complejos/{complejoId}/reservas/{reservaId}
 */
async function getReservaDoc({ complejoId, reservaId }) {
  const ref = db
    .collection('complejos')
    .doc(complejoId)
    .collection('reservas')
    .doc(reservaId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: snap.id, ref, data: snap.data() };
}

/**
 * Helper: busca una reserva confirmada a partir de external_reference
 * external_reference = `${complejoId}|${fecha}|${tipo}|${hora}`
 */
async function findReservaByExternalRef(external_reference) {
  if (!external_reference) return null;
  const [complejoId, fecha, tipo, hora] = String(external_reference).split('|');
  if (!complejoId || !fecha || !tipo || !hora) return null;

  const reservasRef = db
    .collection('complejos')
    .doc(complejoId)
    .collection('reservas');
  const q = reservasRef
    .where('fecha', '==', fecha)
    .where('tipo', '==', Number(tipo))
    .where('hora', '==', hora)
    .where('estado', '==', 'confirmada')
    .limit(1);
  const snap = await q.get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ref: d.ref, data: d.data(), complejoId };
}

/**
 * Genera el PDF a partir de una reserva y lo streamea
 */
function streamReservaPDF({ res, reserva, complejoId }) {
  const d = reserva?.data || {};
  const doc = new PDFDocument({ size: 'A4', margin: 48 });

  // Encabezados HTTP
  const fileName = `reserva-${reserva?.id || 'comprobante'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);

  doc.pipe(res);

  // Header
  doc.fontSize(18).text('Comprobante de Reserva', { align: 'center' }).moveDown(0.5);
  doc
    .fontSize(10)
    .fillColor('#666')
    .text(`Complejo: ${d.complejoNombre || d.complejoName || complejoId || '—'}`, { align: 'center' })
    .text(`Reserva ID: ${reserva?.id || '—'}`, { align: 'center' })
    .text(`Fecha de emisión: ${new Date().toLocaleString('es-AR')}`, { align: 'center' })
    .fillColor('#000')
    .moveDown(1.2);

  // Datos principales
  const kv = (k, v) => {
    doc.font('Helvetica-Bold').text(`${k}: `, { continued: true });
    doc.font('Helvetica').text(String(v ?? '—'));
  };

  kv('Estado', (d.estado || '').toUpperCase());
  kv('Fecha', d.fecha);
  kv('Hora', d.hora);
  kv('Tipo de cancha', `F${d.tipo}`);

  const nombre = d.fullName || d.nombre || d.displayName || '—';
  kv('A nombre de', nombre);
  if (d.telefono || d.phone) kv('Teléfono', d.telefono || d.phone);
  if (d.email) kv('Email', d.email);

  doc.moveDown(0.6);

  // Pago (si existe)
  doc.font('Helvetica-Bold').text('Pago', { underline: true }).moveDown(0.2);
  const pago = d.pago || {};
  kv('Estado del pago', pago.status || '—');
  kv('Importe total', pago.amount_total != null ? `$${Number(pago.amount_total).toLocaleString('es-AR')}` : (pago.amount != null ? `$${Number(pago.amount).toLocaleString('es-AR')}` : '—'));
  if (pago.amount_base_fraction != null) kv('Reserva (según modalidad)', `$${Number(pago.amount_base_fraction).toLocaleString('es-AR')}`);
  if (pago.commission != null) kv('Comisión YoReservo', `$${Number(pago.commission).toLocaleString('es-AR')}`);
  if (pago.mp_payment_id) kv('MP Payment ID', pago.mp_payment_id);

  doc.moveDown(1);

  // Nota legal
  doc
    .fontSize(9)
    .fillColor('#555')
    .text(
      'Este comprobante certifica que la reserva fue registrada como CONFIRMADA según la información provista por el complejo y la plataforma de pago. Conservalo para tu ingreso.',
      { align: 'left' }
    )
    .fillColor('#000');

  doc.end();
}

/**
 * Endpoint 1: PDF por ruta directa
 * GET /receipt/:complejoId/:reservaId.pdf
 */
app.get('/receipt/:complejoId/:reservaId.pdf', async (req, res) => {
  try {
    const { complejoId, reservaId } = req.params || {};
    if (!complejoId || !reservaId) return res.status(400).send('Faltan parámetros');
    const reserva = await getReservaDoc({ complejoId, reservaId });
    if (!reserva) return res.status(404).send('Reserva no encontrada');
    streamReservaPDF({ res, reserva, complejoId });
  } catch (e) {
    console.error('receipt error:', e);
    res.status(500).send('Error generando PDF');
  }
});

/**
 * Endpoint 2: PDF por external_reference (confirmadas)
 * GET /receipt/by-ref?external_reference=...
 */
app.get('/receipt/by-ref', async (req, res) => {
  try {
    const { external_reference } = req.query || {};
    if (!external_reference) return res.status(400).send('Falta external_reference');
    const reserva = await findReservaByExternalRef(String(external_reference));
    if (!reserva) return res.status(404).send('Reserva no encontrada o no confirmada');
    streamReservaPDF({ res, reserva, complejoId: reserva.complejoId });
  } catch (e) {
    console.error('receipt/by-ref error:', e);
    res.status(500).send('Error generando PDF');
  }
});

// Puesto en marcha
app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
