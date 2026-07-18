'use strict';
/* DEV-ONLY mock of the Electron window.api for browser preview of the multi-user
   UI. Not shipped (filtered from the build). Backed by localStorage. */
(function () {
  const KEY = 'cricket_preview_v4';
  const ld = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ld(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1); const yd = ld(y);
  const iso = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

  const seed = {
    global: {
      ai: { mode: 'ollama', baseUrl: 'https://ai.wrenchandram.com', model: 'qwen2.5:7b', allowInsecureTLS: false, timeoutMs: 180000, apiKeySet: true },
      activeProfileId: null,
      profiles: [
        { id: 'p_bj', name: 'BJ', color: '#4ea1ff', avatar: '', createdAt: '', updatedAt: '' },
        { id: 'p_eric', name: 'Eric', color: '#37d67a', avatar: '🦗', createdAt: '', updatedAt: '' }
      ]
    },
    data: {
      p_bj: {
        settings: { dailyGoal: 2000, theme: 'auto' },
        entries: [
          { id: 'a', datetime: iso(8, 15), date: today, text: '3 oreos and a coffee with milk', calories: 190, carbs_g: 28, sugar_g: 20, protein_g: 3, fat_g: 8, estimateStatus: 'done', notes: 'Assumed standard Oreos and an 8oz coffee.', items: [{ name: 'Oreo', qty: 3, calories: 135, carbs_g: 21, sugar_g: 16, protein_g: 1.5, fat_g: 6 }, { name: 'Coffee with milk', qty: 1, calories: 55, carbs_g: 7, sugar_g: 4, protein_g: 1.5, fat_g: 2 }] },
          { id: 'b', datetime: iso(12, 30), date: today, text: 'turkey sandwich', calories: 320, carbs_g: 38, sugar_g: 5, protein_g: 26, fat_g: 9, estimateStatus: 'done', items: [{ name: 'Turkey sandwich', qty: 1, calories: 320 }] },
          { id: 'c', datetime: iso(19, 0), date: yd, text: 'spaghetti bolognese, large bowl', calories: 720, carbs_g: 90, sugar_g: 12, protein_g: 32, fat_g: 24, estimateStatus: 'done', items: [] }
        ]
      },
      p_eric: { settings: { dailyGoal: 1800, theme: 'auto' }, entries: [] }
    }
  };

  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || seed; } catch (_) { return seed; } }
  function write(d) { localStorage.setItem(KEY, JSON.stringify(d)); }
  if (!localStorage.getItem(KEY)) write(seed);
  const ok = (data) => Promise.resolve({ ok: true, data });
  const active = (d) => d.data[d.global.activeProfileId];

  window.api = {
    settings: {
      get: () => { const d = read(); const p = active(d); return ok({ ai: d.global.ai, dailyGoal: p ? p.settings.dailyGoal : null, theme: p ? p.settings.theme : 'auto' }); },
      set: (patch) => { const d = read(); if (patch.ai) { Object.assign(d.global.ai, patch.ai); if ('apiKey' in patch.ai) { d.global.ai.apiKeySet = patch.ai.apiKey !== ''; delete d.global.ai.apiKey; } } const p = active(d); if (p) { if ('dailyGoal' in patch) p.settings.dailyGoal = patch.dailyGoal; if ('theme' in patch) p.settings.theme = patch.theme; } write(d); return window.api.settings.get(); }
    },
    profiles: {
      list: () => { const d = read(); return ok({ profiles: d.global.profiles, activeProfileId: d.global.activeProfileId }); },
      create: (name, color, avatar) => { const d = read(); const id = 'p_' + Math.floor(performance.now()).toString(36); const meta = { id, name, color, avatar: avatar || '', createdAt: '', updatedAt: '' }; d.global.profiles.push(meta); d.data[id] = { settings: { dailyGoal: null, theme: 'auto' }, entries: [] }; d.global.activeProfileId = id; write(d); return ok({ profile: meta, settings: { ai: d.global.ai, dailyGoal: null, theme: 'auto' } }); },
      rename: (id, name) => window.api.profiles.update(id, { name }),
      update: (id, patch) => { const d = read(); const p = d.global.profiles.find(x => x.id === id); if (p) Object.assign(p, patch); write(d); return ok(p); },
      remove: (id) => { const d = read(); d.global.profiles = d.global.profiles.filter(x => x.id !== id); delete d.data[id]; if (d.global.activeProfileId === id) d.global.activeProfileId = d.global.profiles[0] ? d.global.profiles[0].id : null; write(d); return ok({ profiles: d.global.profiles, activeProfileId: d.global.activeProfileId }); },
      switch: (id) => { const d = read(); d.global.activeProfileId = id; write(d); return ok({ profile: d.global.profiles.find(x => x.id === id), settings: window.api.settings }); }
    },
    entries: {
      forDate: (date) => { const d = read(); const p = active(d); return ok((p ? p.entries : []).filter(e => e.date === date).sort((a, b) => a.datetime < b.datetime ? -1 : 1)); },
      inRange: (s, e) => { const d = read(); const p = active(d); return ok((p ? p.entries : []).filter(x => x.date >= s && x.date <= e)); },
      add: (entry) => { const d = read(); const p = active(d); entry.id = 'x' + Math.floor(performance.now()); entry.items = entry.items || []; p.entries.push(entry); write(d); return ok(entry); },
      update: (entry) => { const d = read(); const p = active(d); const i = p.entries.findIndex(x => x.id === entry.id); if (i >= 0) p.entries[i] = { ...p.entries[i], ...entry }; write(d); return ok(p.entries[i]); },
      remove: (id) => { const d = read(); const p = active(d); p.entries = p.entries.filter(x => x.id !== id); write(d); return ok(true); }
    },
    ai: {
      estimate: (text) => new Promise(r => setTimeout(() => r({ ok: true, data: fakeEstimate(text) }), 900)),
      estimateEntry: (profileId, entryId, text) => new Promise(r => setTimeout(() => {
        const d = read(); const p = d.data[profileId]; const i = p ? p.entries.findIndex(x => x.id === entryId) : -1;
        const est = fakeEstimate(text);
        if (i >= 0) { p.entries[i] = { ...p.entries[i], ...est, estimateStatus: 'done' }; write(d); }
        r({ ok: true, data: i >= 0 ? p.entries[i] : null });
      }, 2200)),
      test: () => new Promise(r => setTimeout(() => r({ ok: true, data: { ms: 240, model: 'qwen2.5:7b' } }), 500))
    },
    hints: { add: (list) => ok({ rev: 1, count: (list || []).length }), list: () => ok([]) },
    data: { export: () => ok({ canceled: true }), import: () => ok({ canceled: true }) },
    updates: { getState: () => ok({ status: 'not-available', currentVersion: '1.0.0' }), check: () => ok({ status: 'not-available' }), install: () => ok(false), onStatus: () => () => {} },
    app: { info: () => ok({ version: '1.0.0 (preview)', dataPath: '(browser preview — localStorage)', activeProfileId: read().global.activeProfileId }) }
  };

  function fakeEstimate(text) {
    const parts = String(text).split(/\s*(?:,| and )\s*/i).filter(Boolean);
    const items = parts.map(part => {
      const m = part.match(/^(\d+)\s+(.*)$/);
      const qty = m ? Math.max(1, parseInt(m[1], 10)) : 1;
      const name = (m ? m[2] : part).replace(/^(a|an|some|the)\s+/i, '').trim().slice(0, 40) || 'item';
      const per = 40 + (name.length * 7) % 120;
      const cal = per * qty;
      return { name: name.charAt(0).toUpperCase() + name.slice(1), qty, calories: cal, carbs_g: Math.round(cal * 0.11 * 10) / 10, sugar_g: Math.round(cal * 0.05 * 10) / 10, protein_g: Math.round(cal * 0.05 * 10) / 10, fat_g: Math.round(cal * 0.04 * 10) / 10 };
    });
    const sum = (k) => items.reduce((a, it) => a + (it[k] || 0), 0);
    const cal = sum('calories');
    return { calories: cal, calories_low: Math.round(cal * 0.84), calories_high: Math.round(cal * 1.16), carbs_g: Math.round(sum('carbs_g') * 10) / 10, sugar_g: Math.round(sum('sugar_g') * 10) / 10, protein_g: Math.round(sum('protein_g') * 10) / 10, fat_g: Math.round(sum('fat_g') * 10) / 10, items, confidence: 'medium', notes: 'Mock estimate for browser preview.' };
  }
})();
