'use strict';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

/**
 * Storage layer for Cricket Calorie Tracker.
 *
 * Files under app.getPath('userData'):
 *   global.json            per-machine: AI connection + DPAPI-encrypted token + profile registry
 *   profiles/p_<id>.json   one Store per user profile (entries + goal + theme + identity)
 *
 * Three classes:
 *   Store          — a single profile's data (entries + per-profile settings)
 *   GlobalStore    — machine-wide AI settings, encrypted token, profile registry
 *   ProfileManager — composes the two, routes calls to the active profile, handles
 *                    first-run migration of the legacy single-file data.json
 *
 * Token handling (security): the plaintext token NEVER persists and NEVER crosses
 * IPC. getSettings() returns { ai:{…, apiKeySet:boolean} }; getSettingsForLLM()
 * (main-process only) returns the decrypted token for the network call.
 */

// Per-profile settings (AI settings are global, not here).
const DEFAULT_SETTINGS = { dailyGoal: null, theme: 'auto' };

// Machine-wide settings. Fresh-install AI defaults target the public server so a
// new (Eric) install works after he pastes the token; BJ overrides to the LAN.
const DEFAULT_GLOBAL = {
  schemaVersion: 2,
  migratedLegacy: false,
  ai: {
    mode: 'ollama',                        // server only allows Ollama-native /api/chat
    baseUrl: 'https://ai.wrenchandram.com',// public hostname (Caddy + real cert)
    model: 'qwen2.5:7b',
    allowInsecureTLS: false,               // real public cert; BJ flips on for LAN self-signed
    timeoutMs: 180000                      // WAN + possible cold model load
    // token is stored as apiKeyEnc / apiKeyPlain, never as apiKey
  },
  activeProfileId: null,
  profiles: []
};

const PALETTE = ['#4ea1ff', '#7c5cff', '#37d67a', '#ffb020', '#ff6b9d', '#f6a23c', '#b98cff', '#ff5c6c'];

// ---------------------------------------------------------------------------
// shared atomic writer
// ---------------------------------------------------------------------------
function writeJSONAtomic(filePath, obj) {
  const json = JSON.stringify(obj, null, 2);
  const tmp = filePath + '.tmp', bak = filePath + '.bak';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, json, 'utf8');
  try { if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bak); } catch (_) { /* best effort */ }
  fs.renameSync(tmp, filePath);
}

// ===========================================================================
// Store — one profile's data
// ===========================================================================
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.bakPath = filePath + '.bak';
    this.data = { version: 1, profile: null, settings: clone(DEFAULT_SETTINGS), entries: [], hints: [], hintsRev: 0 };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = this._migrate(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      } else if (fs.existsSync(this.bakPath)) {
        this.data = this._migrate(JSON.parse(fs.readFileSync(this.bakPath, 'utf8')));
        this._save();
      } else {
        this._save();
      }
    } catch (err) {
      try {
        if (fs.existsSync(this.bakPath)) {
          this.data = this._migrate(JSON.parse(fs.readFileSync(this.bakPath, 'utf8')));
          return;
        }
      } catch (_) { /* fall through */ }
      try {
        if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, this.filePath + '.corrupt-' + Date.now());
      } catch (_) { /* ignore */ }
      this.data = { version: 1, profile: null, settings: clone(DEFAULT_SETTINGS), entries: [], hints: [], hintsRev: 0 };
      this._save();
    }
  }

  _migrate(parsed) {
    const data = parsed && typeof parsed === 'object' ? parsed : {};
    data.version = 1;
    data.entries = Array.isArray(data.entries) ? data.entries.map(normalizeEntry) : [];
    data.settings = deepMerge(clone(DEFAULT_SETTINGS), data.settings || {});
    if (data.settings.ai) delete data.settings.ai; // AI settings are global now
    data.hints = Array.isArray(data.hints) ? data.hints : [];   // per-profile personalization (B1)
    data.hintsRev = Number(data.hintsRev) || 0;
    // data.profile (identity block) preserved if present
    return data;
  }

  _save() { writeJSONAtomic(this.filePath, this.data); }

  // per-profile settings
  getSettings() { return { dailyGoal: this.data.settings.dailyGoal ?? null, theme: this.data.settings.theme || 'auto' }; }
  setSettings(patch) {
    const p = { ...(patch || {}) };
    delete p.ai;
    this.data.settings = deepMerge(this.data.settings, p);
    this._save();
    return this.getSettings();
  }

  // entries
  getEntries() { return clone(this.data.entries); }
  entriesForDate(date) {
    return clone(this.data.entries.filter(e => e.date === date)).sort((a, b) => (a.datetime < b.datetime ? -1 : 1));
  }
  entriesInRange(startDate, endDate) {
    return clone(this.data.entries.filter(e => e.date >= startDate && e.date <= endDate)).sort((a, b) => (a.datetime < b.datetime ? -1 : 1));
  }
  addEntry(entry) {
    const e = normalizeEntry(entry);
    this.data.entries.push(e);
    this._save();
    return clone(e);
  }
  updateEntry(entry) {
    const idx = this.data.entries.findIndex(e => e.id === entry.id);
    if (idx === -1) return null;
    this.data.entries[idx] = normalizeEntry({ ...this.data.entries[idx], ...entry });
    this._save();
    return clone(this.data.entries[idx]);
  }
  deleteEntry(id) {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter(e => e.id !== id);
    this._save();
    return before !== this.data.entries.length;
  }

  // ---- per-profile personalization hints (B1: the app learns this user's foods) ----
  getHints() { return clone(this.data.hints || []); }
  getHintsRev() { return this.data.hintsRev || 0; }
  addHints(list) {
    if (!Array.isArray(list) || !list.length) return { rev: this.getHintsRev(), count: (this.data.hints || []).length };
    let hints = Array.isArray(this.data.hints) ? this.data.hints : [];
    for (const h of list) {
      const key = String(h && h.key || '').toLowerCase().trim().slice(0, 60);
      const line = String(h && h.line || '').trim().slice(0, 160);
      if (!key || !line) continue;
      hints = hints.filter(x => x.key !== key); // one hint per food; the newest wins
      hints.unshift({ key, line, ts: nowISO() });
    }
    this.data.hints = hints.slice(0, 24);
    this.data.hintsRev = (this.data.hintsRev || 0) + 1;
    this._save();
    return { rev: this.data.hintsRev, count: this.data.hints.length };
  }

  // backup / restore (token never included)
  exportJSON() {
    const c = clone(this.data);
    if (c.settings && c.settings.ai) delete c.settings.ai;
    return JSON.stringify(c, null, 2);
  }
  importJSON(text) {
    const keepProfile = this.data.profile;
    this.data = this._migrate(JSON.parse(text));
    if (keepProfile) this.data.profile = keepProfile; // an import can't change which profile this file is
    this._save();
    return { entries: this.data.entries.length };
  }
}

// ===========================================================================
// GlobalStore — machine-wide AI settings, encrypted token, profile registry
// ===========================================================================
class GlobalStore {
  constructor(fp) {
    this.filePath = fp;
    this.bakPath = fp + '.bak';
    this.data = clone(DEFAULT_GLOBAL);
    this._load();
  }

  _load() {
    for (const f of [this.filePath, this.bakPath]) {
      try {
        if (fs.existsSync(f)) {
          this.data = deepMerge(clone(DEFAULT_GLOBAL), JSON.parse(fs.readFileSync(f, 'utf8')));
          if (!Array.isArray(this.data.profiles)) this.data.profiles = [];
          this.data.schemaVersion = 2;
          if (this._migrateToken()) this._save();
          return;
        }
      } catch (_) { /* try backup */ }
    }
    this._save();
  }

  _save() { writeJSONAtomic(this.filePath, this.data); }

  // ---- token: encrypted at rest (DPAPI via safeStorage) ----
  _encAvailable() { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } }

  _writeToken(raw) {
    const ai = this.data.ai;
    if ('apiKey' in ai) delete ai.apiKey;
    const v = raw == null ? '' : String(raw);
    if (v === '') { delete ai.apiKeyEnc; delete ai.apiKeyPlain; return; }
    if (this._encAvailable()) {
      try { ai.apiKeyEnc = safeStorage.encryptString(v).toString('base64'); delete ai.apiKeyPlain; return; }
      catch (e) { console.warn('[global] token encrypt failed, storing plaintext fallback:', e && e.message); }
    }
    ai.apiKeyPlain = v; delete ai.apiKeyEnc;
  }
  _decryptToken() {
    const ai = this.data.ai || {};
    if (ai.apiKeyEnc) { try { return safeStorage.decryptString(Buffer.from(ai.apiKeyEnc, 'base64')); } catch (_) { return ''; } }
    return ai.apiKeyPlain ? String(ai.apiKeyPlain) : '';
  }
  _hasToken() { const ai = this.data.ai || {}; return !!(ai.apiKeyEnc || ai.apiKeyPlain); }
  _migrateToken() {
    const ai = this.data.ai; if (!ai) return false; let ch = false;
    if (typeof ai.apiKey === 'string' && ai.apiKey !== '') { this._writeToken(ai.apiKey); ch = true; }
    if ('apiKey' in ai) { delete ai.apiKey; ch = true; }
    if (ai.apiKeyPlain && this._encAvailable()) {
      try { ai.apiKeyEnc = safeStorage.encryptString(String(ai.apiKeyPlain)).toString('base64'); delete ai.apiKeyPlain; ch = true; } catch (_) { /* keep plaintext */ }
    }
    return ch;
  }

  // ---- ai (redacted for IPC vs decrypted for the LLM call) ----
  getAIRedacted() {
    const ai = clone(this.data.ai);
    delete ai.apiKey; delete ai.apiKeyEnc; delete ai.apiKeyPlain;
    ai.apiKeySet = this._hasToken();
    return ai;
  }
  getAIForLLM() {
    const ai = clone(this.data.ai);
    delete ai.apiKeyEnc; delete ai.apiKeyPlain;
    ai.apiKey = this._decryptToken();
    return ai;
  }
  setAI(patch) {
    patch = patch && typeof patch === 'object' ? { ...patch } : {};
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
      const raw = patch.apiKey; delete patch.apiKey;
      this.data.ai = deepMerge(this.data.ai, patch);
      this._writeToken(raw);
    } else {
      this.data.ai = deepMerge(this.data.ai, patch);
    }
    this._save();
    return this.getAIRedacted();
  }

  // ---- profile registry (a reconstructable cache of the profile identity blocks) ----
  getActiveProfileId() { return this.data.activeProfileId || null; }
  setActiveProfileId(id) { this.data.activeProfileId = id || null; this._save(); }
  listProfiles() { return clone(this.data.profiles); }
  getProfile(id) { const p = this.data.profiles.find(x => x.id === id); return p ? clone(p) : null; }
  findByName(n) { const s = String(n || '').toLowerCase(); return this.data.profiles.find(p => String(p.name || '').toLowerCase() === s) || null; }
  addProfileMeta(m) { this.data.profiles.push(m); this._save(); }
  updateProfileMeta(id, patch) { const p = this.data.profiles.find(x => x.id === id); if (!p) return null; Object.assign(p, patch, { updatedAt: nowISO() }); this._save(); return clone(p); }
  touchProfile(id) { const p = this.data.profiles.find(x => x.id === id); if (p) { p.updatedAt = nowISO(); this._save(); } }
  removeProfileMeta(id) { this.data.profiles = this.data.profiles.filter(x => x.id !== id); this._save(); }
  setMigrated() { this.data.migratedLegacy = true; this._save(); }
}

// ===========================================================================
// ProfileManager — composes GlobalStore + active Store, handles boot/migration
// ===========================================================================
class ProfileManager {
  constructor(dir) {
    this.userDataDir = dir;
    this.profilesDir = path.join(dir, 'profiles');
    this.global = new GlobalStore(path.join(dir, 'global.json'));
    this.active = null;
    this.activeId = null;
    this._bootstrap();
  }

  _bootstrap() {
    fs.mkdirSync(this.profilesDir, { recursive: true });
    this._rebuildRegistryIfNeeded();
    this._migrateLegacyIfNeeded();
    const a = this.global.getActiveProfileId();
    try {
      if (a && fs.existsSync(this._path(a))) this._open(a);
      else if (a) this.global.setActiveProfileId(null); // dangling -> show gate
    } catch (_) {
      // Corrupt/invalid stored id -> degrade to the profile gate, never crash startup.
      this.global.setActiveProfileId(null);
    }
  }

  // Reconstruct the registry from profile files' identity blocks (e.g. global.json lost).
  _rebuildRegistryIfNeeded() {
    if (this.global.listProfiles().length > 0) return;
    let files;
    try { files = fs.readdirSync(this.profilesDir).filter(f => /^p_[a-z0-9]+\.json$/i.test(f)); } catch (_) { return; }
    if (!files.length) return;
    let n = 0;
    for (const f of files) {
      const fp = path.join(this.profilesDir, f);
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); }
      catch (_) { try { parsed = JSON.parse(fs.readFileSync(fp + '.bak', 'utf8')); } catch (__) { continue; } }
      const id = (parsed.profile && parsed.profile.id) || f.replace(/\.json$/i, '');
      const meta = parsed.profile || {};
      this.global.addProfileMeta({
        id, name: meta.name || ('Recovered ' + (++n)), color: meta.color || PALETTE[n % PALETTE.length],
        avatar: meta.avatar || '', createdAt: meta.createdAt || nowISO(), updatedAt: meta.updatedAt || nowISO()
      });
    }
    this.global.setMigrated(); // a recovered registry means legacy was already handled
  }

  // One-time migration of the old single-file data.json into a "BJ" profile.
  _migrateLegacyIfNeeded() {
    if (this.global.data.migratedLegacy) return;
    const legacy = path.join(this.userDataDir, 'data.json');
    if (!fs.existsSync(legacy)) { this.global.setMigrated(); return; }
    // Crash-safety: if an interrupted prior run already created the BJ profile,
    // don't duplicate it — just finish the bookkeeping (idempotent re-run).
    const existingBJ = this.global.findByName('BJ');
    if (existingBJ) {
      if (!this.global.getActiveProfileId()) this.global.setActiveProfileId(existingBJ.id);
      this.global.setMigrated();
      try { fs.renameSync(legacy, legacy + '.migrated-' + Date.now()); } catch (_) { /* best effort */ }
      return;
    }
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')); }
    catch (_) { try { parsed = JSON.parse(fs.readFileSync(legacy + '.bak', 'utf8')); } catch (__) { return; } } // leave for retry
    const s = (parsed && parsed.settings) || {};
    const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    if (s.ai) this.global.setAI(s.ai); // lift + encrypt BJ's token, keep his LAN url
    const id = genProfileId(), now = nowISO();
    const meta = { id, name: 'BJ', color: PALETTE[0], avatar: '', createdAt: now, updatedAt: now };
    const st = new Store(this._path(id));
    st.data.profile = { id, name: 'BJ', color: PALETTE[0], avatar: '' };
    st.data.settings = { dailyGoal: s.dailyGoal ?? null, theme: s.theme || 'auto' };
    st.data.entries = entries.map(normalizeEntry);
    st._save();
    this.global.addProfileMeta(meta);
    this.global.setActiveProfileId(id);
    this.global.setMigrated();
    try { fs.renameSync(legacy, legacy + '.migrated-' + Date.now()); }
    catch (_) { console.warn('[migrate] could not archive legacy data.json'); }
  }

  _path(id) { return path.join(this.profilesDir, sanitizeProfileId(id) + '.json'); }
  _open(id) { this.active = new Store(this._path(id)); this.activeId = sanitizeProfileId(id); }
  _requireActive() { if (!this.active) throw new Error('No active profile. Pick or create a profile first.'); return this.active; }
  _writeIdentity(id, meta) {
    const identity = { id, name: meta.name, color: meta.color, avatar: meta.avatar || '' };
    if (id === this.activeId && this.active) { this.active.data.profile = identity; this.active._save(); }
    else { const st = new Store(this._path(id)); st.data.profile = identity; st._save(); }
  }

  // ---- composed settings (token redacted for IPC) ----
  getSettings() {
    const ai = this.global.getAIRedacted();
    if (this.active) { const s = this.active.getSettings(); return { ai, dailyGoal: s.dailyGoal ?? null, theme: s.theme || 'auto' }; }
    return { ai, dailyGoal: null, theme: 'auto' };
  }
  setSettings(patch) {
    patch = patch || {};
    if (patch.ai) this.global.setAI(patch.ai);
    if (this.active && ('dailyGoal' in patch || 'theme' in patch)) {
      const p = {};
      if ('dailyGoal' in patch) p.dailyGoal = patch.dailyGoal;
      if ('theme' in patch) p.theme = patch.theme;
      this.active.setSettings(p);
    }
    return this.getSettings();
  }
  getSettingsForLLM() { return { ai: this.global.getAIForLLM() }; }
  getStoredAIForLLM() { return this.global.getAIForLLM(); }

  // ---- profile lifecycle ----
  getActiveProfileId() { return this.global.getActiveProfileId(); }
  listProfiles() { return { profiles: this.global.listProfiles(), activeProfileId: this.global.getActiveProfileId() }; }

  createProfile({ name, color, avatar } = {}) {
    const nm = normName(name);
    if (!nm) throw new Error('Please enter a name.');
    if (this.global.findByName(nm)) throw new Error(`A profile named "${nm}" already exists.`);
    const id = genProfileId(), now = nowISO();
    const meta = {
      id, name: nm, color: sanitizeColor(color) || PALETTE[this.global.listProfiles().length % PALETTE.length],
      avatar: sanitizeAvatar(avatar), createdAt: now, updatedAt: now
    };
    const st = new Store(this._path(id));
    st.data.profile = { id, name: meta.name, color: meta.color, avatar: meta.avatar };
    st.data.settings = { dailyGoal: null, theme: 'auto' };
    st._save();
    this.global.addProfileMeta(meta);
    return this.switchProfile(id);
  }

  renameProfile(id, name) { return this.updateProfile(id, { name }); }

  updateProfile(id, patch) {
    id = sanitizeProfileId(id);
    const cur = this.global.getProfile(id);
    if (!cur) throw new Error('Profile not found.');
    const next = { ...cur };
    if ('name' in patch) {
      const nm = normName(patch.name);
      if (!nm) throw new Error('Please enter a name.');
      const clash = this.global.findByName(nm);
      if (clash && clash.id !== id) throw new Error(`A profile named "${nm}" already exists.`);
      next.name = nm;
    }
    if ('color' in patch) next.color = sanitizeColor(patch.color) || cur.color;
    if ('avatar' in patch) next.avatar = sanitizeAvatar(patch.avatar);
    const saved = this.global.updateProfileMeta(id, { name: next.name, color: next.color, avatar: next.avatar });
    this._writeIdentity(id, saved);
    return saved;
  }

  deleteProfile(id) {
    id = sanitizeProfileId(id);
    if (!this.global.getProfile(id)) throw new Error('Profile not found.');
    // Archive, never hard-delete.
    const fp = this._path(id);
    try { if (fs.existsSync(fp)) fs.renameSync(fp, fp + '.deleted-' + Date.now()); } catch (_) { /* best effort */ }
    if (id === this.activeId) { this.active = null; this.activeId = null; }
    this.global.removeProfileMeta(id);
    // Reselect the most-recently-used remaining profile, if any.
    const remaining = this.global.listProfiles().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (this.global.getActiveProfileId() === id || !this.global.getActiveProfileId()) {
      if (remaining.length) this.switchProfile(remaining[0].id);
      else this.global.setActiveProfileId(null);
    }
    return this.listProfiles();
  }

  switchProfile(id) {
    id = sanitizeProfileId(id);
    if (!this.global.getProfile(id)) throw new Error('Profile not found.');
    this._open(id);
    this.global.setActiveProfileId(id);
    this.global.touchProfile(id);
    return { profile: this.global.getProfile(id), settings: this.getSettings() };
  }

  // ---- entries (routed to active profile) ----
  entriesForDate(d) { return this._requireActive().entriesForDate(d); }
  entriesInRange(s, e) { return this._requireActive().entriesInRange(s, e); }
  addEntry(x) { return this._requireActive().addEntry(x); }
  updateEntry(x) { return this._requireActive().updateEntry(x); }
  deleteEntry(id) { return this._requireActive().deleteEntry(id); }
  exportJSON() { return this._requireActive().exportJSON(); }
  importJSON(t) { return this._requireActive().importJSON(t); }

  // Personalization hints for a SPECIFIC profile (used to calibrate its estimates).
  getHintsFor(profileId) {
    let id; try { id = sanitizeProfileId(profileId); } catch (_) { return { lines: [], rev: 0 }; }
    let store;
    if (id === this.activeId && this.active) store = this.active;
    else if (fs.existsSync(this._path(id))) store = new Store(this._path(id));
    else return { lines: [], rev: 0 };
    return { lines: store.getHints().map(h => h.line), rev: store.getHintsRev() };
  }
  addActiveHints(list) { return this._requireActive().addHints(list); }
  listActiveHints() { return this._requireActive().getHints(); }

  // Apply an async estimate result to a SPECIFIC profile (the one active when the
  // entry was created), so switching profiles mid-estimate can't cross-write.
  applyEstimateToProfile(profileId, entryId, patch) {
    let id;
    try { id = sanitizeProfileId(profileId); } catch (_) { return null; }
    let store;
    if (id === this.activeId && this.active) store = this.active;
    else if (fs.existsSync(this._path(id))) store = new Store(this._path(id));
    else return null;
    // Only apply to an entry that is STILL pending — if the user edited, re-estimated,
    // or deleted it while the estimate was in flight, drop this (stale) result.
    const cur = store.data.entries.find(e => e.id === entryId);
    if (!cur || cur.estimateStatus !== 'pending') return null;
    return store.updateEntry({ id: entryId, ...patch });
  }
}

// ---------------------------------------------------------------------------
// entry normalization
// ---------------------------------------------------------------------------
function normalizeEntry(entry) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0; };
  const status = ['pending', 'done', 'error', 'manual'].includes(entry.estimateStatus) ? entry.estimateStatus : 'done';
  return {
    id: entry.id || genId('e'),
    datetime: entry.datetime || nowISO(),
    date: entry.date || localDate(new Date(entry.datetime || Date.now())),
    text: String(entry.text || '').trim(),
    calories: Math.round(num(entry.calories)),
    calories_low: Math.round(num(entry.calories_low)),
    calories_high: Math.round(num(entry.calories_high)),
    carbs_g: num(entry.carbs_g),
    sugar_g: num(entry.sugar_g),
    protein_g: num(entry.protein_g),
    fat_g: num(entry.fat_g),
    items: Array.isArray(entry.items) ? entry.items.map(normalizeItem) : [],
    notes: String(entry.notes || ''),
    confidence: ['low', 'medium', 'high'].includes(entry.confidence) ? entry.confidence : '',
    estimateStatus: status,
    estimateError: entry.estimateError ? String(entry.estimateError).slice(0, 300) : ''
  };
}
function normalizeItem(it) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0; };
  const qty = Number(it.qty);
  return {
    name: String(it.name || '').slice(0, 120),
    portion: String(it.portion || ''),
    qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    calories: Math.round(num(it.calories)),
    carbs_g: num(it.carbs_g), sugar_g: num(it.sugar_g), protein_g: num(it.protein_g), fat_g: num(it.fat_g)
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
let _c = 0;
function counter() { _c = (_c + 1) % 1e6; return _c.toString(36); }
function genId(prefix) { return prefix + '_' + Math.abs(hashStr(String(process.hrtime.bigint()))).toString(36) + counter(); }
function genProfileId() { return genId('p').replace(/[^a-z0-9_]/gi, ''); }
function sanitizeProfileId(id) {
  const s = String(id || '');
  if (!/^p_[a-z0-9]+$/i.test(s)) throw new Error('Invalid profile id.');
  return s;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }
function normName(n) { return String(n == null ? '' : n).trim().slice(0, 40); }
function sanitizeColor(c) { const s = String(c || '').trim(); return /^#[0-9a-f]{6}$/i.test(s) ? s : ''; }
function sanitizeAvatar(a) { return String(a || '').trim().slice(0, 8); } // an emoji or a couple letters
function nowISO() { return new Date().toISOString(); }
function localDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], patch[k]);
    } else {
      out[k] = patch[k];
    }
  }
  return out;
}

module.exports = { Store, GlobalStore, ProfileManager, DEFAULT_SETTINGS, DEFAULT_GLOBAL, PALETTE, localDate };
