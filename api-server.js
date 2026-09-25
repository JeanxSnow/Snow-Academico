'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const INDEX_FILE = process.env.INDEX_FILE || path.join(__dirname, 'index.html');
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';
// OpenRouter tries these models in order when a provider is rate-limited or unavailable.
const FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'openrouter/free'
];
const MAX_BODY = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 180000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const requestCounts = new Map();

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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true }, 'application/json; charset=utf-8');
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      return send(res, 200, await fs.promises.readFile(INDEX_FILE, 'utf8'), 'text/html; charset=utf-8');
    } catch {
      return send(res, 500, { error: 'No se encontró index.html. Configure INDEX_FILE.' });
    }
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

  let upstreamTimeout;
  try {
    const startedAt = Date.now();
    console.log(`Solicitud de generacion recibida. Modelos: ${[MODEL, ...FALLBACK_MODELS].join(' -> ')}. Consultando OpenRouter...`);
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
    const requestedTokens = Number(input.maxTokens || 6000);
    const maxTokens = Math.min(16000, Math.max(1000, Math.floor(requestedTokens)));
    const upstreamController = new AbortController();
    upstreamTimeout = setTimeout(() => upstreamController.abort(new Error('timeout')), UPSTREAM_TIMEOUT_MS);
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
        models: [MODEL, ...FALLBACK_MODELS],
        stream: input.stream === true,
        max_tokens: maxTokens,
        temperature: 0.25,
        messages: [
          { role: 'system', content: 'Eres un redactor académico cuidadoso. Entrega únicamente el trabajo final solicitado en español y en el formato de marcadores indicado por el usuario. No expongas razonamientos, borradores, planes, instrucciones internas ni comentarios sobre cómo vas a responder. No inventes hechos ni referencias. No presentes cifras, resultados, estudios, organizaciones ni casos como reales si no puedes respaldarlos con una fuente identificable; marca con claridad como hipotéticos los ejemplos inventados y no los atribuyas a estudios. Ajusta el nivel de tecnicismo a la asignatura y carrera, define las siglas necesarias y usa ejemplos pertinentes a ese campo cuando ayuden. Incluye toda sección pedida expresamente, sin confundir una mención temática con una sección formal. Cuando se solicite APA 7.ª, ordena las referencias alfabéticamente por el primer autor o institución y comprueba la correspondencia entre citas y referencias. Completa todas las secciones antes de terminar. Si no puedes completar el trabajo, indícalo brevemente en lugar de presentar un borrador como final.' },
          { role: 'user', content: input.prompt }
        ]
      })
    });
    if (!upstream.ok) {
      clearTimeout(upstreamTimeout);
      const data = await upstream.json().catch(() => ({}));
      const upstreamMessage = data?.error?.message || 'Sin detalle del proveedor';
      console.error('OpenRouter API error:', upstream.status, upstreamMessage);
      const status = upstream.status === 429 ? 429 : 502;
      return send(res, status, { error: `OpenRouter respondio ${upstream.status}: ${upstreamMessage}` });
    }
    if (input.stream === false) {
      clearTimeout(upstreamTimeout);
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
      return send(res, 502, { error: 'OpenRouter no inicio la transmision del texto.' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let usedModel = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
    if (!res.writableEnded) res.end();
    console.log(`Generacion completada en ${Math.round((Date.now() - startedAt) / 1000)} segundos. Modelo usado: ${usedModel || 'no informado'}.`);
  } catch (error) {
    clearTimeout(upstreamTimeout);
    const cause = error.cause;
    const diagnostic = `${error.name || ''} ${error.message || ''} ${cause?.name || ''} ${cause?.message || ''}`;
    const timedOut = /timeout|timed out|aborted due to timeout/i.test(diagnostic);
    console.error('Generation server error:', diagnostic, cause?.code ? `[${cause.code}]` : '');
    const message = timedOut ? 'OpenRouter no completo la respuesta en 180 segundos. Intenta de nuevo mas tarde.' : 'No se pudo conectar con OpenRouter. Revisa la conexion e intenta de nuevo.';
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
