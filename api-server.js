'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const INDEX_FILE = process.env.INDEX_FILE || path.join(__dirname, 'index.html');
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'snow-academico';
const ADMIN_UID = process.env.ADMIN_UID || '';
const configuredCreditLimit = Number(process.env.DEFAULT_DAILY_CREDIT_LIMIT || 5);
const DEFAULT_DAILY_CREDIT_LIMIT = Number.isInteger(configuredCreditLimit) ? Math.max(0, Math.min(50, configuredCreditLimit)) : 5;
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free';
// OpenRouter tries these models in order when a provider is rate-limited or unavailable.
const FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',
  'openrouter/free'
];
const MAX_BODY = 512 * 1024;
const UPSTREAM_IDLE_TIMEOUT_MS = 120000;
const UPSTREAM_TOTAL_TIMEOUT_MS = 480000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const requestCounts = new Map();
let firebaseCertCache = { expiresAt: 0, certificates: {} };
let adminDb = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (serviceAccount.project_id !== FIREBASE_PROJECT_ID) {
      throw new Error('La cuenta de servicio no pertenece al FIREBASE_PROJECT_ID configurado.');
    }
    const app = getApps()[0] || initializeApp({
      credential: cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID
    });
    adminDb = getFirestore(app);
  }
} catch (error) {
  console.error('Firebase Admin credential configuration error:', error.message);
}
if (!adminDb) console.warn('Daily credits are unavailable until FIREBASE_SERVICE_ACCOUNT_JSON is configured in the server environment.');

function utcDayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function requireAdminSdk(res) {
  if (adminDb) return true;
  send(res, 503, { error: 'El control seguro de créditos requiere configurar FIREBASE_SERVICE_ACCOUNT_JSON en Render.' });
  return false;
}

async function settleGenerationCredit(firebaseUser, reservationId, outcome) {
  const match = String(reservationId || '').match(/^(\d{4}-\d{2}-\d{2})_([\w-]{20,50})$/);
  if (!match || !['completed', 'cancelled', 'error'].includes(outcome)) {
    throw Object.assign(new Error('La reserva de crédito no es válida.'), { status: 400 });
  }
  const day = match[1];
  const ageDays = Math.abs(Date.parse(`${utcDayKey()}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays > 2) throw Object.assign(new Error('La reserva de crédito expiró.'), { status: 400 });
  const ref = adminDb.collection('creditUsage').doc(`${firebaseUser.uid}_${day}`);
  return adminDb.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { settled: false, used: 0 };
    const record = snapshot.data();
    const pending = { ...(record.pending || {}) };
    const settled = { ...(record.settled || {}) };
    if (Object.prototype.hasOwnProperty.call(settled, reservationId)) return { settled: true, used: record.used || 0 };
    if (!Object.prototype.hasOwnProperty.call(pending, reservationId)) return { settled: false, used: record.used || 0 };
    delete pending[reservationId];
    settled[reservationId] = outcome;
    const keys = Object.keys(settled);
    for (const key of keys.slice(0, Math.max(0, keys.length - 150))) delete settled[key];
    const used = Math.max(0, Number(record.used) || 0) + (outcome === 'completed' || outcome === 'cancelled' ? 1 : 0);
    tx.set(ref, {
      uid: record.uid, email: record.email || '', day: record.day,
      pending, settled, used,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { settled: true, used };
  });
}

function isRateLimited(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = (typeof forwardedFor === 'string' ? forwardedFor.split(',').at(-1).trim() : '') || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = requestCounts.get(clientIp);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    requestCounts.set(clientIp, entry);
  }
  entry.count += 1;
  for (const [ip, item] of requestCounts) {
    if (item.resetAt <= now) requestCounts.delete(ip);
  }
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > limit) {
        reject(Object.assign(new Error('Solicitud demasiado grande'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(Object.assign(new Error('JSON no válido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function getFirebaseCertificates() {
  if (Date.now() < firebaseCertCache.expiresAt) return firebaseCertCache.certificates;
  const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!response.ok) throw new Error(`Firebase certificate request failed: ${response.status}`);
  const certificates = await response.json();
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 300);
  firebaseCertCache = { certificates, expiresAt: Date.now() + maxAge * 1000 };
  return certificates;
}

async function getFirebaseUser(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || !header.kid || claims.aud !== FIREBASE_PROJECT_ID ||
        claims.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` ||
        typeof claims.sub !== 'string' || !claims.sub || claims.exp <= Math.floor(Date.now() / 1000) ||
        claims.iat > Math.floor(Date.now() / 1000) + 60) return null;
    const certificates = await getFirebaseCertificates();
    const certificate = certificates[header.kid];
    if (!certificate) return null;
    const signedData = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    if (!crypto.verify('RSA-SHA256', signedData, crypto.createPublicKey(certificate), signature)) return null;
    return { uid: claims.sub, email: claims.email || '', emailVerified: claims.email_verified === true, token };
  } catch (error) {
    console.error('Firebase token verification error:', error.message);
    return null;
  }
}
async function getAccountBanStatus(firebaseUser) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/(default)/documents/userAccess/${encodeURIComponent(firebaseUser.uid)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${firebaseUser.token}` } });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Firestore account access check failed: ${response.status}`);
  const document = await response.json();
  return document.fields?.banned?.booleanValue === true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true }, 'application/json; charset=utf-8');
  }
  if ((req.method === 'GET' && req.url === '/api/admin/credits') || (req.method === 'PUT' && req.url === '/api/admin/credits')) {
    const firebaseUser = await getFirebaseUser(req);
    if (!firebaseUser) return send(res, 401, { error: 'Inicia sesión para continuar.' });
    if (!ADMIN_UID || firebaseUser.uid !== ADMIN_UID) return send(res, 403, { error: 'Solo el administrador puede cambiar el límite de créditos.' });
    if (!requireAdminSdk(res)) return;
    try {
      const settingsRef = adminDb.collection('appSettings').doc('dailyCredits');
      if (req.method === 'PUT') {
        const body = await readJson(req, 2048);
        const limit = Number(body.limit);
        if (!Number.isInteger(limit) || limit < 0 || limit > 50) return send(res, 400, { error: 'El límite debe ser un número entero entre 0 y 50.' });
        await settingsRef.set({ limit, updatedAt: FieldValue.serverTimestamp(), updatedBy: firebaseUser.uid }, { merge: true });
      }
      const settings = await settingsRef.get();
      const limit = Number.isInteger(settings.data()?.limit) ? settings.data().limit : DEFAULT_DAILY_CREDIT_LIMIT;
      const day = utcDayKey();
      const usageSnapshot = await adminDb.collection('creditUsage').where('day', '==', day).get();
      const users = usageSnapshot.docs.map(doc => {
        const data = doc.data();
        const pending = Object.keys(data.pending || {}).length;
        const used = Math.max(0, Number(data.used) || 0);
        return { uid: data.uid, email: data.email || '', used, pending, remaining: Math.max(0, limit - used - pending) };
      }).sort((a, b) => a.email.localeCompare(b.email));
      return send(res, 200, { limit, day, users });
    } catch (error) {
      console.error('Admin credit settings error:', error.message);
      return send(res, 500, { error: 'No se pudieron guardar o leer los límites diarios de créditos.' });
    }
  }
  if ((req.method === 'POST' && (req.url === '/api/credits/start' || req.url === '/api/credits/finish'))) {
    const firebaseUser = await getFirebaseUser(req);
    if (!firebaseUser) return send(res, 401, { error: 'Inicia sesión para generar un trabajo.' });
    if (!requireAdminSdk(res)) return;
    try {
      if (await getAccountBanStatus(firebaseUser)) return send(res, 403, { error: 'Esta cuenta está suspendida. Contacta con administración.' });
      const body = await readJson(req, 2048);
      if (req.url === '/api/credits/finish') {
        const result = await settleGenerationCredit(firebaseUser, body.reservationId, body.outcome);
        return send(res, result.settled ? 200 : 404, { ok: result.settled, used: result.used });
      }
      const day = utcDayKey();
      const usageRef = adminDb.collection('creditUsage').doc(`${firebaseUser.uid}_${day}`);
      const settingsRef = adminDb.collection('appSettings').doc('dailyCredits');
      const reservationId = `${day}_${crypto.randomUUID()}`;
      const now = Date.now();
      const result = await adminDb.runTransaction(async tx => {
        const [settingsSnapshot, usageSnapshot] = await Promise.all([tx.get(settingsRef), tx.get(usageRef)]);
        const limit = Number.isInteger(settingsSnapshot.data()?.limit) ? settingsSnapshot.data().limit : DEFAULT_DAILY_CREDIT_LIMIT;
        const data = usageSnapshot.data() || {};
        const pending = { ...(data.pending || {}) };
        for (const [id, createdAt] of Object.entries(pending)) {
          if (!Number.isFinite(Number(createdAt)) || now - Number(createdAt) > 2 * 60 * 60 * 1000) delete pending[id];
        }
        const used = Math.max(0, Number(data.used) || 0);
        if (used + Object.keys(pending).length >= limit) {
          throw Object.assign(new Error('Llegaste al límite diario de créditos. Intenta mañana o consulta al administrador.'), { status: 429, creditLimit: limit, used });
        }
        pending[reservationId] = now;
        tx.set(usageRef, {
          uid: firebaseUser.uid, email: firebaseUser.email || '', day, used, pending,
          settled: data.settled || {}, updatedAt: FieldValue.serverTimestamp()
        });
        return { limit, used, pending: Object.keys(pending).length };
      });
      return send(res, 200, {
        reservationId, limit: result.limit, used: result.used,
        remaining: Math.max(0, result.limit - result.used - result.pending)
      });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error('Credit reservation error:', error.message);
      return send(res, status, { error: status === 429 ? error.message : status === 400 ? error.message : 'No se pudo comprobar el crédito diario. Intenta de nuevo.' });
    }
  }
  if (req.method === 'GET' && req.url === '/api/admin/check') {
    const firebaseUser = await getFirebaseUser(req);
    if (!firebaseUser) return send(res, 401, { error: 'Inicia sesión para continuar.' });
    const isAdmin = Boolean(ADMIN_UID && firebaseUser.uid === ADMIN_UID);
    try {
      const isBanned = await getAccountBanStatus(firebaseUser);
      return send(res, 200, { isAdmin, isBanned }, 'application/json; charset=utf-8');
    } catch (error) {
      console.error('Account access check failed:', error.message);
      return send(res, 503, { error: 'No se pudo verificar el acceso a esta cuenta. Intenta de nuevo.' });
    }
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      return send(res, 200, await fs.promises.readFile(INDEX_FILE, 'utf8'), 'text/html; charset=utf-8');
    } catch {
      return send(res, 500, { error: 'No se encontró index.html. Configure INDEX_FILE.' });
    }
  }
  if (req.url.startsWith('/api/auth/')) {
    return send(res, 404, { error: 'La autenticación ahora se gestiona con Firebase.' });
  }
  if (req.method !== 'POST' || req.url !== '/api/generate') {
    return send(res, 404, { error: 'Ruta no encontrada' });
  }
  if (isRateLimited(req)) {
    return send(res, 429, { error: 'Se alcanzó el límite temporal de solicitudes. Espera unos minutos antes de volver a intentar.' });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return send(res, 503, { error: 'Falta configurar OPENROUTER_API_KEY en el servidor.' });
  }
  const firebaseUser = await getFirebaseUser(req);
  if (!firebaseUser) return send(res, 401, { error: 'Inicia sesión para generar un trabajo.' });
  try {
    if (await getAccountBanStatus(firebaseUser)) {
      return send(res, 403, { error: 'Esta cuenta está suspendida. Contacta con administración.' });
    }
  } catch (error) {
    console.error('Account access check failed:', error.message);
    return send(res, 503, { error: 'No se pudo verificar el acceso a esta cuenta. Intenta de nuevo.' });
  }

  let upstreamTimeout;
  let upstreamTotalTimeout;
  let streamHeartbeat;
  try {
    const startedAt = Date.now();
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
        return send(res, 413, { error: 'La solicitud excede el tamaño permitido.' });
      }
    }
    const input = JSON.parse(raw || '{}');
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      return send(res, 400, { error: 'Falta el contenido del trabajo.' });
    }
    const configuredModels = [MODEL, ...FALLBACK_MODELS];
    const fallbackAttempt = Math.max(0, Math.floor(Number(input.fallbackAttempt) || 0)) % configuredModels.length;
    const modelChoices = [...configuredModels.slice(fallbackAttempt), ...configuredModels.slice(0, fallbackAttempt)];
    console.log(`Solicitud de generacion recibida. Intento ${fallbackAttempt + 1}; modelos: ${modelChoices.join(' -> ')}. Consultando OpenRouter...`);
    const requestedTokens = Number(input.maxTokens || 6000);
    const maxTokens = Math.min(16000, Math.max(1000, Math.floor(requestedTokens)));
    const upstreamController = new AbortController();
    const resetIdleTimeout = () => {
      clearTimeout(upstreamTimeout);
      upstreamTimeout = setTimeout(() => upstreamController.abort(new Error('upstream idle timeout')), UPSTREAM_IDLE_TIMEOUT_MS);
    };
    resetIdleTimeout();
    upstreamTotalTimeout = setTimeout(() => upstreamController.abort(new Error('upstream total timeout')), UPSTREAM_TOTAL_TIMEOUT_MS);
    res.on('close', () => {
      if (!res.writableEnded) upstreamController.abort(new Error('client disconnected'));
    });
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: upstreamController.signal,
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'x-title': 'Snow Académico'
      },
      body: JSON.stringify({
        models: modelChoices,
        provider: { sort: 'latency' },
        stream: input.stream === true,
        max_tokens: maxTokens,
        temperature: 0.25,
        messages: [
          { role: 'system', content: 'Eres un redactor académico cuidadoso. Entrega únicamente el trabajo final solicitado en español y en el formato de marcadores indicado por el usuario. No expongas razonamientos, borradores, planes, instrucciones internas ni comentarios sobre cómo vas a responder. No inventes hechos ni referencias. No presentes cifras, resultados, estudios, organizaciones ni casos como reales si no puedes respaldarlos con una fuente identificable; marca con claridad como hipotéticos los ejemplos inventados y no los atribuyas a estudios. Ajusta el nivel de tecnicismo a la asignatura y carrera, define las siglas necesarias y usa ejemplos pertinentes a ese campo cuando ayuden. Incluye toda sección pedida expresamente, sin confundir una mención temática con una sección formal. Cuando se solicite APA 7.ª, ordena las referencias alfabéticamente por el primer autor o institución y comprueba que las citas de autor y año y las referencias coincidan en ambos sentidos. Si el mensaje contiene una continuación y un borrador previo, considéralo como el mismo trabajo: no lo reinicies, no dupliques lo ya entregado y continúa exactamente desde su final para completar las partes pendientes. Completa todas las secciones antes de terminar. Si no puedes completar el trabajo, indícalo brevemente en lugar de presentar un borrador como final.' },
          { role: 'user', content: input.prompt }
        ]
      })
    });
    if (!upstream.ok) {
      clearTimeout(upstreamTimeout);
      clearTimeout(upstreamTotalTimeout);
      const data = await upstream.json().catch(() => ({}));
      const upstreamMessage = data?.error?.message || 'Sin detalle del proveedor';
      console.error('OpenRouter API error:', upstream.status, upstreamMessage);
      const status = upstream.status === 429 ? 429 : 502;
      return send(res, status, { error: `OpenRouter respondio ${upstream.status}: ${upstreamMessage}` });
    }
    if (input.stream === false) {
      clearTimeout(upstreamTimeout);
      clearTimeout(upstreamTotalTimeout);
      const data = await upstream.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return send(res, 502, { error: 'El modelo gratuito no devolvió texto.' });
      }
      console.log(`Generacion completada en ${Math.round((Date.now() - startedAt) / 1000)} segundos. Modelo usado: ${data.model || 'no informado'}.`);
      return send(res, 200, { content });
    }

    if (!upstream.body) {
      clearTimeout(upstreamTimeout);
      clearTimeout(upstreamTotalTimeout);
      return send(res, 502, { error: 'OpenRouter no inicio la transmision del texto.' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // Keep Render's streaming connection alive while a free model is thinking.
    streamHeartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, 15000);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let usedModel = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdleTimeout();
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try { usedModel = JSON.parse(payload).model || usedModel; } catch {}
      }
    }
    const finalChunk = decoder.decode();
    if (finalChunk) res.write(finalChunk);
    clearTimeout(upstreamTimeout);
    clearTimeout(upstreamTotalTimeout);
    clearInterval(streamHeartbeat);
    if (!res.writableEnded) res.end();
    console.log(`Generacion completada en ${Math.round((Date.now() - startedAt) / 1000)} segundos. Modelo usado: ${usedModel || 'no informado'}.`);
  } catch (error) {
    clearTimeout(upstreamTimeout);
    clearTimeout(upstreamTotalTimeout);
    clearInterval(streamHeartbeat);
    const cause = error.cause;
    const diagnostic = `${error.name || ''} ${error.message || ''} ${cause?.name || ''} ${cause?.message || ''}`;
    const timedOut = /timeout|timed out|aborted due to timeout/i.test(diagnostic);
    console.error('Generation server error:', diagnostic, cause?.code ? `[${cause.code}]` : '');
    const message = timedOut ? 'OpenRouter dejó de responder temporalmente. La aplicación intentará continuar desde el borrador recibido.' : 'No se pudo conectar con OpenRouter. La aplicación puede reintentar sin borrar el borrador.';
    if (res.headersSent && !res.writableEnded && !res.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
      return;
    }
    if (!res.destroyed) return send(res, timedOut ? 504 : 502, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Snow Academico listo en http://${HOST}:${PORT}. Modelo: ${MODEL}`);
});
