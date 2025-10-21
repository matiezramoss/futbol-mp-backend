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
app.use(express.json({ limit: '5mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Comisión fija por transacción (tuya) — para MP
const COMMISSION_FIXED = 1000;

if (!MP_ACCESS_TOKEN) {
  console.warn('[WARN] MP_ACCESS_TOKEN no está seteado. Setéalo en Render > Environment.');
}

// Cliente MP
const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/** Health / raíz */
app.get('/', (_req, res) => res.send('OK futbol-mp-backend'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* ------------------------------------------------------------------
   Helper post-pago: render HTML mínimo y deep link a la app
   ------------------------------------------------------------------ */
function renderAndDeepLink(res, status, req) {
  const qs = new URLSearchParams(req.query).toString();
  const deeplink = `yoreservo://mp-result?status=${encodeURIComponent(status)}${qs ? `&${qs}` : ''}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url='${deeplink}'" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Volviendo a YoReservo…</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;background:#fafafa}
    .box{max-width:560px;margin:auto;border:1px solid #eee;border-radius:12px;padding:24px;background:#fff}
    h2{margin:0 0 8px 0}
    .ok{color:#0a7;font-weight:800}
    .fail{color:#b00020;font-weight:800}
    .pend{color:#915f00;font-weight:800}
    a{color:#0a7;font-weight:700;text-decoration:none}
  </style>
</head>
<body>
  <div class="box">
    <h2 class="${status==='success'?'ok':status==='failure'?'fail':'pend'}">
      ${status==='success' ? '¡Pago aprobado!' : status==='failure' ? 'Pago rechazado' : 'Pago pendiente'}
    </h2>
    <p>Te estamos reenviando a <b>YoReservo</b>…</p>
    <p>Si no pasa nada, tocá este enlace: <a href="${deeplink}">volver a la app</a></p>
  </div>
</body>
</html>`);
}

// Endpoints de retorno para evitar 404 y volver a la app
app.get('/mp/success', (req, res) => renderAndDeepLink(res, 'success', req));
app.get('/mp/failure', (req, res) => renderAndDeepLink(res, 'failure', req));
app.get('/mp/pending', (req, res) => renderAndDeepLink(res, 'pending', req));

/**
 * Crea preferencia
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

      // extras
      complejoId,
      name,
      fecha,
      hora,
      tipo,
      priceNum,
      userId,
      userEmail,
    } = req.body || {};

    const base = Number(unit_price) || 0;
    const pct = Number(deposit_pct) || 30;
    const fraction = payFull ? 1 : (pct / 100);
    const baseFractionAmount = Number((base * fraction).toFixed(2));
    const chargedAmount = Number((baseFractionAmount + COMMISSION_FIXED).toFixed(2));

    const pref = new Preference(mp);

    const body = {
      items: [
        {
          id: external_reference || 'booking',
          title,
          quantity: Number(quantity) || 1,
          currency_id: 'ARS',
          unit_price: chargedAmount,
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
        payFull: !!payFull,
        deposit_pct: payFull ? null : pct,

        basePrice: base,
        base_fraction_amount: baseFractionAmount,
        commission_fixed: COMMISSION_FIXED,
        total: chargedAmount,

        complejoId, name, fecha, hora, tipo, priceNum, userId, userEmail,
      },
    };

    const result = await pref.create({ body });

    return res.status(200).json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      pct_applied: payFull ? 100 : pct,
      charged_amount: chargedAmount,
      base_fraction_amount: baseFractionAmount,
      commission_fixed: COMMISSION_FIXED,
    });
  } catch (err) {
    console.error('create-preference error:', err);
    return res.status(500).json({ error: true, message: String(err?.message || err) });
  }
});

/* ============================================================
   Liquidación diaria (idempotente por pago/operación)
   ============================================================ */
async function upsertDailySettlement({ complejoId, fecha, paymentInfo }) {
  if (!complejoId || !fecha || !paymentInfo) return;
  const {
    id: mp_payment_id,
    status,
    transaction_amount,
    metadata = {},
  } = paymentInfo;

  const isFull = !!metadata?.payFull;
  const commission = Number(metadata?.commission_fixed ?? 0) || 0; // 👈 en manual dejamos 0
  const baseFraction = Number(metadata?.base_fraction_amount ?? metadata?.manual_amount ?? 0) || 0;
  const totalCharged = Number(metadata?.total ?? transaction_amount ?? baseFraction) || 0;

  const dayDoc = db.collection('liquidaciones')
    .doc(String(complejoId))
    .collection('days')
    .doc(String(fecha));

  const pagoDoc = dayDoc.collection('pagos').doc(String(mp_payment_id));

  await db.runTransaction(async (tx) => {
    const pagoSnap = await tx.get(pagoDoc);
    if (pagoSnap.exists) return;

    tx.set(pagoDoc, {
      mp_payment_id,
      status,
      createdAt: FieldValue.serverTimestamp(),
      total_charged: totalCharged,
      commission,
      base_fraction: baseFraction,
      payFull: isFull,
      deposit_pct: isFull ? null : (Number(metadata?.deposit_pct ?? 0) || null),
      manual: !!metadata?.manual,
    });

    const daySnap = await tx.get(dayDoc);
    if (!daySnap.exists) {
      tx.set(dayDoc, {
        complejoId,
        fecha,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        pagado: false,
        pagadoAt: null,

        count_total: 0,
        count_full: 0,
        count_deposit: 0,
        sum_total_charged: 0,
        sum_commission: 0,
        sum_base_fraction: 0,
        sum_net_to_complex: 0,
      }, { merge: true });
    }

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
 * Webhook de MP (se mantiene)
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

      if (info.status === 'approved') {
        const ref = String(info.external_reference || '');
        const [complejoId, fecha, tipo, hora] = ref.split('|');
        if (complejoId && fecha && tipo && hora) {
          const reservasRef = db.collection('complejos').doc(complejoId).collection('reservas');
          const snap = await reservasRef
            .where('fecha', '==', fecha)
            .where('tipo', '==', Number(tipo))
            .where('hora', '==', hora)
            .where('estado', 'in', ['pending', 'pendiente'])
            .limit(1).get();

          if (!snap.empty) {
            const docRef = snap.docs[0].ref;
            const m = info?.metadata || {};
            await docRef.set({
              estado: 'confirmada',
              pago: {
                mp_payment_id: info.id,
                status: info.status,
                date_approved: info.date_approved || FieldValue.serverTimestamp(),
                amount: info.transaction_amount,
                amount_base: m.basePrice ?? null,
                amount_base_fraction: m.base_fraction_amount ?? null,
                commission: m.commission_fixed ?? COMMISSION_FIXED,
                amount_total: m.total ?? info.transaction_amount,
                payFull: m.payFull ?? null,
                deposit_pct: m.deposit_pct ?? null,
                manual: false,
              },
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });

            await upsertDailySettlement({ complejoId, fecha, paymentInfo: info });
          } else {
            console.log('[WEBHOOK] No se encontró reserva pendiente para', ref);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err);
    res.sendStatus(200);
  }
});

/* =====================================================================================
   PDF (igual que antes)
   ===================================================================================== */
async function getReservaDoc({ complejoId, reservaId }) {
  const ref = db.collection('complejos').doc(complejoId).collection('reservas').doc(reservaId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: snap.id, ref, data: snap.data() };
}

async function findReservaByExternalRef(external_reference) {
  if (!external_reference) return null;
  const [complejoId, fecha, tipo, hora] = String(external_reference).split('|');
  if (!complejoId || !fecha || !tipo || !hora) return null;

  const reservasRef = db.collection('complejos').doc(complejoId).collection('reservas');
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

function streamReservaPDF({ res, reserva, complejoId }) {
  const d = reserva?.data || {};
  const doc = new PDFDocument({ size: 'A4', margin: 48 });

  const fileName = `reserva-${reserva?.id || 'comprobante'}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  doc.fontSize(18).text('Comprobante de Reserva', { align: 'center' }).moveDown(0.5);
  doc.fontSize(10).fillColor('#666')
    .text(`Complejo: ${d.complejoNombre || d.complejoName || complejoId || '—'}`, { align: 'center' })
    .text(`Reserva ID: ${reserva?.id || '—'}`, { align: 'center' })
    .text(`Fecha de emisión: ${new Date().toLocaleString('es-AR')}`, { align: 'center' })
    .fillColor('#000').moveDown(1.2);

  const kv = (k, v) => { doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }); doc.font('Helvetica').text(String(v ?? '—')); };

  kv('Estado', (d.estado || '').toUpperCase());
  kv('Fecha', d.fecha);
  kv('Hora', d.hora);
  kv('Tipo de cancha', `F${d.tipo}`);

  const nombre = d.fullName || d.nombre || d.displayName || '—';
  kv('A nombre de', nombre);
  if (d.telefono || d.phone) kv('Teléfono', d.telefono || d.phone);
  if (d.email) kv('Email', d.email);

  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').text('Pago', { underline: true }).moveDown(0.2);
  const pago = d.pago || {};
  kv('Estado del pago', pago.status || '—');
  kv('Importe total', pago.amount_total != null ? `$${Number(pago.amount_total).toLocaleString('es-AR')}` : (pago.amount != null ? `$${Number(pago.amount).toLocaleString('es-AR')}` : '—'));
  if (pago.amount_base_fraction != null) kv('Reserva (según modalidad)', `$${Number(pago.amount_base_fraction).toLocaleString('es-AR')}`);
  if (pago.commission != null) kv('Comisión YoReservo', `$${Number(pago.commission).toLocaleString('es-AR')}`);
  if (pago.mp_payment_id) kv('MP Payment ID', pago.mp_payment_id);
  if (pago.manual) kv('Carga manual verificada', 'Sí');

  doc.moveDown(1);
  doc.fontSize(9).fillColor('#555')
    .text('Este comprobante certifica que la reserva fue registrada como CONFIRMADA según la información provista por el complejo y la plataforma de pago. Conservalo para tu ingreso.', { align: 'left' })
    .fillColor('#000');
  doc.end();
}

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

/* =========================================================================
   💠 Endpoints isCheck con chequeo de cupos ATÓMICO
   ========================================================================= */
function normalizeTipoVariants(tipo) {
  const out = [];
  const n = Number(tipo);
  if (Number.isFinite(n)) out.push(n);
  out.push(String(tipo));
  // quitar duplicados
  return Array.from(new Set(out));
}

app.post('/checks/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewerUid } = req.body || {};

    const result = await db.runTransaction(async (tx) => {
      const checkRef = db.collection('checks').doc(id);
      const checkSnap = await tx.get(checkRef);
      if (!checkSnap.exists) throw new Error('Check no encontrado');

      const c = checkSnap.data() || {};
      if (c.estado !== 'pending') throw new Error('El check no está pendiente');

      const { userId, complejoId, fecha, hora, tipo, monto } = c;
      if (!userId || !complejoId || !fecha || !hora) {
        throw new Error('Datos incompletos en el check');
      }

      // total canchas por tipo (mapa canchas["<tipo>"])
      const complejoRef = db.collection('complejos').doc(String(complejoId));
      const complejoSnap = await tx.get(complejoRef);
      if (!complejoSnap.exists) throw new Error('Complejo no encontrado');

      const map = (complejoSnap.data()?.canchas) || {};
      const key = String(Number.isFinite(Number(tipo)) ? Number(tipo) : String(tipo));
      const total = Number(map?.[key] ?? 0) || 1;

      // count confirmadas en ese slot
      const reservasRef = complejoRef.collection('reservas');
      const variants = normalizeTipoVariants(tipo);

      const q = reservasRef
        .where('fecha', '==', String(fecha))
        .where('hora', '==', String(hora))
        .where('tipo', 'in', variants)
        .where('estado', '==', 'confirmada')
        .limit(total + 1);

      const ocupadasSnap = await q.get();
      const ocupadas = ocupadasSnap.size || 0;

      if (ocupadas >= total) {
        return {
          ok: false,
          reason: 'capacity',
          total,
          ocupadas,
          libres: 0,
        };
      }

      // crear reserva confirmada
      const newResRef = reservasRef.doc();
      tx.set(newResRef, {
        key: `${fecha}|${tipo}|${hora}`,
        fecha: String(fecha),
        hora: String(hora),
        tipo: Number.isFinite(Number(tipo)) ? Number(tipo) : String(tipo),
        userId: String(userId),
        estado: 'confirmada',
        createdAt: FieldValue.serverTimestamp(),
        createdBy: reviewerUid || 'check-bot',
        channel: 'check',
        updatedAt: FieldValue.serverTimestamp(),
        pago: {
          manual: true,
          status: 'approved',
          amount: Number(monto) || 0,
          amount_base: Number(monto) || 0,
          amount_base_fraction: Number(monto) || 0,
          commission: 0,
          amount_total: Number(monto) || 0,
          date_approved: FieldValue.serverTimestamp(),
          payFull: null,
          deposit_pct: null,
          mp_payment_id: `manual_${id}`,
        },
      });

      // aprobar check
      tx.set(checkRef, {
        estado: 'approved',
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: reviewerUid || 'check-bot',
      }, { merge: true });

      return {
        ok: true,
        reservaId: newResRef.id,
        total,
        ocupadas: ocupadas + 1,
        libres: Math.max(total - (ocupadas + 1), 0),
      };
    });

    if (!result.ok && result.reason === 'capacity') {
      return res.status(409).json({
        error: true,
        message: 'Sin disponibilidad',
        total: result.total,
        ocupadas: result.ocupadas,
        libres: result.libres,
      });
    }

    // liquidación diaria (manual) fuera de la transacción
    // (si querés, podés moverlo adentro con un doc agregado, pero no es crítico)
    try {
      const checkSnap = await db.collection('checks').doc(String(req.params.id)).get();
      const c = checkSnap.data() || {};
      await upsertDailySettlement({
        complejoId: c.complejoId,
        fecha: c.fecha,
        paymentInfo: {
          id: `manual_${req.params.id}`,
          status: 'approved',
          transaction_amount: Number(c.monto) || 0,
          metadata: {
            manual: true,
            manual_amount: Number(c.monto) || 0,
            payFull: null,
            deposit_pct: null,
            commission_fixed: 0,
            total: Number(c.monto) || 0,
          },
        },
      });
    } catch (e) {
      console.warn('[settlement] warn:', e?.message || e);
    }

    res.json(result);
  } catch (e) {
    console.error('approve error:', e);
    res.status(400).json({ error: true, message: String(e?.message || e) });
  }
});

app.post('/checks/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewerUid, reason } = req.body || {};

    const result = await db.runTransaction(async (tx) => {
      const checkRef = db.collection('checks').doc(id);
      const checkSnap = await tx.get(checkRef);
      if (!checkSnap.exists) throw new Error('Check no encontrado');
      const c = checkSnap.data() || {};
      if (c.estado !== 'pending') throw new Error('El check no está pendiente');

      tx.set(checkRef, {
        estado: 'rejected',
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: reviewerUid || 'check-bot',
        reason: reason || 'Rechazado',
      }, { merge: true });

      return { ok: true };
    });

    res.json(result);
  } catch (e) {
    console.error('reject error:', e);
    res.status(400).json({ error: true, message: String(e?.message || e) });
  }
});

// Puesto en marcha
app.listen(PORT, () => {
  console.log(`MP backend listening on :${PORT}`);
});
