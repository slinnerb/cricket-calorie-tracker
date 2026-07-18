'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Nutrition estimator backed by a local LLM.
 *
 * Two wire formats are supported so it works with whatever the server exposes:
 *   mode 'openai' -> POST {baseUrl}/v1/chat/completions   (OpenAI-compatible)
 *   mode 'ollama' -> POST {baseUrl}/api/chat              (Ollama native)
 *
 * The model is asked to return STRICT JSON describing calories + macros for the
 * whole entry, plus a per-item breakdown. We parse defensively because small
 * local models sometimes wrap JSON in prose or code fences.
 */

const SYSTEM_PROMPT = `You are a careful nutrition estimator. The user describes food or drink they consumed, in casual language that may include vague portions like "a bite of", "a sip", "half a", "a handful", or "a small bowl".

Estimate the nutrition for the TOTAL described, using standard reference values and common sense about the stated portion. A "bite" is roughly 1/8 to 1/4 of a typical serving; a "sip" is ~30 ml; "a handful" ~30 g; when no portion is given, assume one typical serving.

Break the input into ONE item per distinct food or drink. When something is counted (e.g. "3 oreos"), put the count in "qty" and make that item's "calories" (and grams) the TOTAL for all of them — e.g. 3 Oreos at ~45 kcal each => { "name":"Oreo", "qty":3, "calories":135 }. For a single or uncounted item use qty 1. Keep the coffee, the sandwich, etc. as their own separate items.

Respond with ONLY a JSON object, no prose, no markdown fences, in exactly this shape:
{
  "items": [
    { "name": "string", "qty": number, "portion": "string", "calories": number, "carbs_g": number, "sugar_g": number, "protein_g": number, "fat_g": number }
  ],
  "calories": number,      // total kcal for everything described
  "carbs_g": number,       // total grams
  "sugar_g": number,       // total grams (subset of carbs)
  "protein_g": number,     // total grams
  "fat_g": number,         // total grams
  "confidence": "low" | "medium" | "high",
  "notes": "string"        // one short sentence on assumptions made
}

All numbers must be plain numbers (no units, no ranges). Round to whole calories and one decimal for grams. Totals must equal the sum of the items. If the input is not food or drink, return all zeros with a note explaining why.`;

function estimatorMessages(text) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Estimate the nutrition for: "${text}"` }
  ];
}

async function estimate(settings, text) {
  const ai = settings.ai || {};
  const raw = await chat(ai, estimatorMessages(text));
  const parsed = extractJSON(raw);
  if (!parsed) {
    const err = new Error('The AI did not return usable JSON.');
    err.raw = raw;
    throw err;
  }
  return sanitizeEstimate(parsed);
}

/** Lightweight connectivity + model check used by the Settings "Test" button. */
async function testConnection(settings) {
  const ai = settings.ai || {};
  const started = Date.now();
  const raw = await chat(ai, [
    { role: 'system', content: 'Reply with only the word: OK' },
    { role: 'user', content: 'Say OK.' }
  ]);
  return {
    ok: true,
    ms: Date.now() - started,
    sample: String(raw || '').slice(0, 120),
    model: ai.model || '(server default)'
  };
}

// ---- transport ----

async function chat(ai, messages) {
  const mode = ai.mode === 'ollama' ? 'ollama' : 'openai';
  const base = String(ai.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('No AI server URL configured. Open Settings and set the base URL.');

  if (mode === 'ollama') {
    const body = { model: ai.model || undefined, messages, stream: false, format: 'json', options: { temperature: 0.2 } };
    const res = await request(ai, base + '/api/chat', body);
    if (!ok(res)) throw httpError(res);
    return extractContent(parse(res.text), mode);
  }

  // OpenAI-compatible. Try with strict JSON mode; if the server rejects that
  // parameter (some local gateways 4xx on response_format), retry without it.
  const path = base + '/v1/chat/completions';
  const withFmt = { model: ai.model || undefined, messages, stream: false, temperature: 0.2, response_format: { type: 'json_object' } };
  let res = await request(ai, path, withFmt);
  if (!ok(res) && res.status >= 400 && res.status < 500) {
    const noFmt = { model: ai.model || undefined, messages, stream: false, temperature: 0.2 };
    const res2 = await request(ai, path, noFmt);
    if (ok(res2)) res = res2; // otherwise surface the original error below
  }
  if (!ok(res)) throw httpError(res);
  return extractContent(parse(res.text), 'openai');
}

function ok(res) { return res.status >= 200 && res.status < 300; }
function httpError(res) { return new Error(`AI server returned HTTP ${res.status}: ${String(res.text).slice(0, 300)}`); }
function parse(text) {
  try { return JSON.parse(text); }
  catch (e) { throw new Error('Could not parse AI server response: ' + String(text).slice(0, 300)); }
}

/** Low-level POST returning { status, text }. Rejects only on network/TLS/timeout. */
function request(ai, urlStr, body) {
  const url = new URL(urlStr);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'Content-Type': 'application/json', 'Content-Length': payload.length };
  if (ai.apiKey) headers['Authorization'] = 'Bearer ' + ai.apiKey;

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    headers,
    timeout: ai.timeoutMs || 60000
  };
  if (isHttps && ai.allowInsecureTLS) options.rejectUnauthorized = false;

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('AI request timed out. Is the model loaded and the server reachable?')); });
    req.on('error', (e) => reject(friendlyNetError(e, url)));
    req.write(payload);
    req.end();
  });
}

function extractContent(json, mode) {
  if (mode === 'ollama') {
    return json && json.message ? json.message.content : '';
  }
  // OpenAI-compatible
  if (json && json.choices && json.choices[0]) {
    const c = json.choices[0];
    return (c.message && c.message.content) || c.text || '';
  }
  return '';
}

function friendlyNetError(e, url) {
  const code = e && e.code;
  if (code === 'ECONNREFUSED') return new Error(`Connection refused by ${url.host}. The AI server may be down or on a different port.`);
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return new Error(`Timed out reaching ${url.host}. Check the address / firewall.`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`Host ${url.hostname} not found on the network.`);
  if (code && code.startsWith('ERR_TLS') || (e.message || '').includes('self-signed') || (e.message || '').includes('self signed')) {
    return new Error('TLS certificate rejected. Enable "Allow self-signed certificate" in Settings for this local server.');
  }
  return e;
}

// ---- JSON handling ----

function extractJSON(s) {
  if (!s) return null;
  let t = String(s).trim();
  // Strip ``` fences if present.
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // Fast path.
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  // Grab the first balanced {...} block.
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) {
        const block = t.slice(start, i + 1);
        try { return JSON.parse(block); } catch (_) { return null; }
      } }
    }
  }
  return null;
}

function sanitizeEstimate(p) {
  const num = (v) => {
    if (typeof v === 'string') {
      const m = v.match(/-?\d+(\.\d+)?/);
      v = m ? m[0] : 0;
    }
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const items = Array.isArray(p.items) ? p.items.map(it => {
    const q = Number(it.qty);
    return {
      name: String(it.name || '').slice(0, 120),
      qty: Number.isFinite(q) && q > 0 ? q : 1,
      portion: String(it.portion || ''),
      calories: Math.round(num(it.calories)),
      carbs_g: round1(num(it.carbs_g)),
      sugar_g: round1(num(it.sugar_g)),
      protein_g: round1(num(it.protein_g)),
      fat_g: round1(num(it.fat_g))
    };
  }) : [];

  // Prefer explicit totals; fall back to summing items.
  const sum = (k) => items.reduce((a, it) => a + (it[k] || 0), 0);
  const total = {
    calories: Math.round(p.calories != null ? num(p.calories) : sum('calories')),
    carbs_g: round1(p.carbs_g != null ? num(p.carbs_g) : sum('carbs_g')),
    sugar_g: round1(p.sugar_g != null ? num(p.sugar_g) : sum('sugar_g')),
    protein_g: round1(p.protein_g != null ? num(p.protein_g) : sum('protein_g')),
    fat_g: round1(p.fat_g != null ? num(p.fat_g) : sum('fat_g'))
  };
  const conf = ['low', 'medium', 'high'].includes(p.confidence) ? p.confidence : 'medium';
  return { ...total, items, confidence: conf, notes: String(p.notes || '').slice(0, 400) };
}

function round1(n) { return Math.round(n * 10) / 10; }

module.exports = { estimate, testConnection };
