'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persistent estimate cache keyed by normalized text (+ mode/model/prompt version).
 * Two wins: repeat foods ("a coffee") return INSTANTLY instead of a ~40s model
 * call, and the same phrase always yields the same numbers — so the weekly trend
 * the app is built around isn't corrupted by LLM non-determinism.
 *
 * Bump CACHE_VERSION whenever the estimator prompt/shape changes so stale-shaped
 * results are naturally invalidated.
 */
const CACHE_VERSION = 'p2'; // p2 = adds calorie range + confidence

class EstimateCache {
  constructor(filePath, cap = 3000) {
    this.filePath = filePath;
    this.cap = cap;
    this.map = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const obj = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (obj && Array.isArray(obj.entries)) for (const [k, v] of obj.entries) this.map.set(k, v);
      }
    } catch (_) { /* corrupt/absent -> start empty */ }
  }

  _save() {
    try {
      const entries = [...this.map.entries()].slice(-this.cap);
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (_) { /* best effort */ }
  }

  static keyFor(ai, text) {
    const norm = String(text || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '');
    return `${CACHE_VERSION}|${ai.mode || 'ollama'}|${ai.model || ''}|${norm}`;
  }

  get(ai, text) {
    const v = this.map.get(EstimateCache.keyFor(ai, text));
    return v ? JSON.parse(JSON.stringify(v)) : null;
  }

  set(ai, text, estimate) {
    const key = EstimateCache.keyFor(ai, text);
    this.map.delete(key);            // move-to-end for simple LRU eviction
    this.map.set(key, estimate);
    if (this.map.size > this.cap) { const oldest = this.map.keys().next().value; this.map.delete(oldest); }
    this._save();
  }
}

module.exports = { EstimateCache };
