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
  "calories": number,      // total kcal — your single best estimate
  "calories_low": number,  // low end of a realistic range for the total
  "calories_high": number, // high end of a realistic range for the total
  "carbs_g": number,       // total grams
  "sugar_g": number,       // total grams (subset of carbs)
  "protein_g": number,     // total grams
  "fat_g": number,         // total grams
  "confidence": "low" | "medium" | "high",
  "notes": "string"        // one short sentence on assumptions made
}

All numbers must be plain numbers (no units). Round to whole calories and one decimal for grams. The item calories must sum to "calories". Make the low/high range HONEST: keep it tight when the food and portion are clear, and widen it when the portion, recipe, or cooking method is uncertain — a wider range should go with lower confidence. If the input is not food or drink, return all zeros with a note explaining why.`;

function estimatorMessages(text, hints) {
  let sys = SYSTEM_PROMPT;
  if (Array.isArray(hints) && hints.length) {
    sys += `\n\nPersonal notes about THIS user's usual foods — trust them to calibrate portions/calories when the input matches one:\n`
      + hints.slice(0, 24).map(h => '- ' + String(h)).join('\n');
  }
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `Estimate the nutrition for: "${text}"` }
  ];
}

async function estimate(settings, text, hints) {
  const ai = settings.ai || {};
  const raw = await chat(ai, estimatorMessages(text, hints));
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
  ], { json: false });
  return {
    ok: true,
    ms: Date.now() - started,
    sample: String(raw || '').slice(0, 120),
    model: ai.model || '(server default)'
  };
}

// ---- weekly coach line (B2): one supportive sentence from the week's aggregates ----
const WEEK_COACH_PROMPT = `You are a supportive, concise nutrition coach. Given a person's weekly totals, reply with ONE short, friendly, factual sentence (about 12-22 words) describing the week and any change from last week. Be encouraging and specific. Never judge, shame, diagnose, or give medical advice. No hashtags, no quotation marks. Output only the sentence.`;

async function weekInsight(settings, agg) {
  const ai = settings.ai || {};
  const g = agg || {};
  const goalTxt = g.goal ? `${g.goal} kcal/day` : 'none set';
  const trend = g.prevTotal ? `${g.trendPct <= 0 ? 'down' : 'up'} ${Math.abs(g.trendPct)}% from last week` : 'no prior week to compare';
  const user = `This week the person logged ${g.loggedDays} day(s): total ${g.total} kcal, daily average ${g.avg} kcal. Average per day — carbs ${g.carbs} g, sugar ${g.sugar} g, protein ${g.protein} g, fat ${g.fat} g. Trend: ${trend}. Daily goal: ${goalTxt}. Write the one-sentence summary.`;
  const raw = await chat(ai, [
    { role: 'system', content: WEEK_COACH_PROMPT },
    { role: 'user', content: user }
  ], { json: false });
  return String(raw || '').trim().replace(/^["']+|["']+$/g, '').replace(/\s+/g, ' ').slice(0, 220);
}

// ---- transport ----

async function chat(ai, messages, opts) {
  const wantJson = !opts || opts.json !== false; // estimates force JSON; the coach line is plain text
  const mode = ai.mode === 'ollama' ? 'ollama' : 'openai';
  const base = String(ai.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('No AI server URL configured. Open Settings and set the base URL.');

  if (mode === 'ollama') {
    const body = { model: ai.model || undefined, messages, stream: false, options: { temperature: 0 } };
    if (wantJson) body.format = 'json';
    const res = await request(ai, base + '/api/chat', body);
    if (!ok(res)) throw httpError(res);
    return extractContent(parse(res.text), mode);
  }

  // OpenAI-compatible. Try with strict JSON mode; if the server rejects that
  // parameter (some local gateways 4xx on response_format), retry without it.
  const path = base + '/v1/chat/completions';
  const body0 = { model: ai.model || undefined, messages, stream: false, temperature: 0 };
  const first = wantJson ? { ...body0, response_format: { type: 'json_object' } } : body0;
  let res = await request(ai, path, first);
  if (wantJson && !ok(res) && res.status >= 400 && res.status < 500) {
    const res2 = await request(ai, path, body0);
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

  // Calorie range. Use the model's low/high when sane; otherwise derive a band
  // from the confidence level so we always show honest uncertainty.
  const band = conf === 'high' ? 0.08 : conf === 'low' ? 0.28 : 0.16;
  let lo = p.calories_low != null ? Math.round(num(p.calories_low)) : Math.round(total.calories * (1 - band));
  let hi = p.calories_high != null ? Math.round(num(p.calories_high)) : Math.round(total.calories * (1 + band));
  if (lo > total.calories) lo = Math.round(total.calories * (1 - band));
  if (hi < total.calories) hi = Math.round(total.calories * (1 + band));
  lo = Math.max(0, Math.min(lo, total.calories));
  hi = Math.max(hi, total.calories);

  return { ...total, calories_low: lo, calories_high: hi, items, confidence: conf, notes: String(p.notes || '').slice(0, 400) };
}

function round1(n) { return Math.round(n * 10) / 10; }

// ---- ask-your-data (B3): answer a question over the user's own log ----
const ASK_PROMPT = `You answer questions about the user's OWN food log. Use ONLY the data provided after the question. Be concise — one or two sentences — and include the relevant numbers. If the data doesn't contain enough to answer, say you don't have enough logged data for that. Never give medical, diet, or health advice; just report what's in the log.`;

async function answerQuestion(settings, question, dataText) {
  const ai = settings.ai || {};
  const raw = await chat(ai, [
    { role: 'system', content: ASK_PROMPT },
    { role: 'user', content: `Question: ${question}\n\nMy food log (one entry per line):\n${dataText}` }
  ], { json: false });
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

module.exports = { estimate, testConnection, weekInsight, answerQuestion };
