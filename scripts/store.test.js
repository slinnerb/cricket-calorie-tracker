'use strict';
/* Store/GlobalStore/ProfileManager unit test. Runs under Electron so the real
   DPAPI-backed safeStorage token encryption is exercised.
   Run: npm run test:store   (electron scripts/store.test.js) */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ProfileManager, Store } = require('../src/main/store');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } };
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cricket-st-'));
const seedLegacy = (dir, obj) => fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(obj), 'utf8');
const readGlobal = (dir) => fs.readFileSync(path.join(dir, 'global.json'), 'utf8');

function run() {
  const encAvail = (() => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } })();
  console.log('safeStorage encryption available:', encAvail);

  // 1) Legacy migration ------------------------------------------------------
  {
    const dir = fresh();
    seedLegacy(dir, {
      version: 1,
      settings: { ai: { mode: 'ollama', baseUrl: 'https://10.0.0.54:11435', model: 'qwen2.5:7b', apiKey: 'SECRET-TOKEN-123', allowInsecureTLS: true }, dailyGoal: 2100, theme: 'dark' },
      entries: [
        { id: 'e1', date: '2026-07-17', datetime: '2026-07-17T08:00:00.000Z', text: 'toast', calories: 120 },
        { id: 'e2', date: '2026-07-18', datetime: '2026-07-18T09:00:00.000Z', text: 'eggs', calories: 180 }
      ]
    });
    const m = new ProfileManager(dir);
    const list = m.listProfiles();
    ok(list.profiles.length === 1 && list.profiles[0].name === 'BJ', 'migration creates one "BJ" profile');
    ok(m.getActiveProfileId() === list.profiles[0].id, 'migrated profile is active');
    ok(m.entriesForDate('2026-07-17').length === 1 && m.entriesForDate('2026-07-18').length === 1, 'entries migrated intact');
    ok(m.getSettings().dailyGoal === 2100 && m.getSettings().theme === 'dark', 'per-profile goal+theme migrated');
    ok(m.getSettings().ai.baseUrl === 'https://10.0.0.54:11435', "BJ's LAN AI url lifted to global");
    ok(m.getSettings().ai.apiKeySet === true, 'apiKeySet true after migration');
    ok(m.getSettings().ai.apiKey === undefined, 'redacted settings carry no apiKey');
    ok(m.getSettingsForLLM().ai.apiKey === 'SECRET-TOKEN-123', 'getSettingsForLLM decrypts the token');
    if (encAvail) ok(!readGlobal(dir).includes('SECRET-TOKEN-123'), 'token not stored in plaintext in global.json');
    ok(fs.readdirSync(dir).some(f => /^data\.json\.migrated-/.test(f)), 'legacy data.json archived');
    ok(!fs.existsSync(path.join(dir, 'data.json')), 'legacy data.json no longer present');

    // 2) Idempotency: re-open + a stale data.json must not re-migrate
    seedLegacy(dir, { version: 1, settings: {}, entries: [{ id: 'x', date: '2026-01-01', text: 'stale', calories: 5 }] });
    const m2 = new ProfileManager(dir);
    ok(m2.listProfiles().profiles.length === 1, 'idempotent: no duplicate profile on re-open with stale data.json');
  }

  // 3) Registry rebuild from profile files -----------------------------------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    m.createProfile({ name: 'Eric', color: '#37d67a' });
    m.createProfile({ name: 'Cricket' });
    // wipe the registry, keep the profile files
    fs.unlinkSync(path.join(dir, 'global.json'));
    try { fs.unlinkSync(path.join(dir, 'global.json.bak')); } catch (_) {}
    const m2 = new ProfileManager(dir);
    const names = m2.listProfiles().profiles.map(p => p.name).sort();
    ok(names.length === 2 && names[0] === 'Cricket' && names[1] === 'Eric', 'registry rebuilt from identity blocks with names preserved');
  }

  // 4) Compose/route + timeout survival --------------------------------------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    m.createProfile({ name: 'BJ' });
    m.setSettings({ ai: { baseUrl: 'https://lan.example' } });
    m.setSettings({ dailyGoal: 1800, theme: 'light' });
    const s = m.getSettings();
    ok(s.ai.baseUrl === 'https://lan.example', 'ai patch writes global');
    ok(s.dailyGoal === 1800 && s.theme === 'light', 'goal/theme write active profile');
    ok(s.ai.timeoutMs === 180000, 'timeoutMs preserved via deepMerge');
    ok(s.ai.model === 'qwen2.5:7b', 'untouched ai defaults preserved');
  }

  // 5) Isolation between profiles --------------------------------------------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    const a = m.createProfile({ name: 'A' }).profile.id;
    m.addEntry({ text: 'apple', date: '2026-07-18', calories: 95 });
    const b = m.createProfile({ name: 'B' }).profile.id;
    m.addEntry({ text: 'burger', date: '2026-07-18', calories: 600 });
    m.switchProfile(a);
    const aEntries = m.entriesForDate('2026-07-18');
    m.switchProfile(b);
    const bEntries = m.entriesForDate('2026-07-18');
    ok(aEntries.length === 1 && aEntries[0].text === 'apple', 'profile A sees only its entry');
    ok(bEntries.length === 1 && bEntries[0].text === 'burger', 'profile B sees only its entry');
  }

  // 6) Delete active archives + reselects -------------------------------------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    const a = m.createProfile({ name: 'A' }).profile.id;
    m.createProfile({ name: 'B' });
    m.switchProfile(a);
    m.deleteProfile(a);
    ok(m.listProfiles().profiles.length === 1, 'delete removes profile from registry');
    ok(m.getActiveProfileId() && m.getActiveProfileId() !== a, 'delete reselects another profile');
    ok(fs.readdirSync(path.join(dir, 'profiles')).some(f => /\.deleted-/.test(f)), 'deleted profile file archived, not unlinked');
  }

  // 7) Async estimate applied to the correct profile --------------------------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    const a = m.createProfile({ name: 'A' }).profile.id;
    const e = m.addEntry({ text: '3 oreos and a coffee', date: '2026-07-18', estimateStatus: 'pending' });
    ok(e.estimateStatus === 'pending' && e.calories === 0, 'pending entry starts at 0 kcal');
    const b = m.createProfile({ name: 'B' }).profile.id; // switch away mid-estimate
    const updated = m.applyEstimateToProfile(a, e.id, {
      calories: 140, estimateStatus: 'done',
      items: [{ name: 'Oreo', qty: 3, calories: 135 }, { name: 'Coffee', qty: 1, calories: 5 }]
    });
    ok(updated && updated.calories === 140 && updated.estimateStatus === 'done', 'applyEstimateToProfile updates the entry');
    ok(updated.items.length === 2 && updated.items[0].qty === 3, 'item quantities preserved');
    m.switchProfile(a);
    ok(m.entriesForDate('2026-07-18')[0].calories === 140, 'estimate landed in profile A despite active being B');
    m.switchProfile(b);
    ok(m.entriesForDate('2026-07-18').length === 0, 'profile B not cross-written');
  }

  // 8) Export strips token; import keeps profile id ---------------------------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    const a = m.createProfile({ name: 'A' }).profile.id;
    m.setSettings({ ai: { apiKey: 'EXPORT-SECRET' } });
    m.addEntry({ text: 'apple', date: '2026-07-18', calories: 95 });
    const dump = m.exportJSON();
    ok(!dump.includes('EXPORT-SECRET') && !dump.includes('apiKey'), 'export contains no token material');
    m.importJSON(dump);
    ok(m.getActiveProfileId() === a, 'import preserves the active profile id');
    ok(m.entriesForDate('2026-07-18').length === 1, 'import restores entries');
  }

  // 9) A stale estimate on a no-longer-pending entry is dropped ---------------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    const a = m.createProfile({ name: 'A' }).profile.id;
    const e = m.addEntry({ text: 'x', date: '2026-07-18', estimateStatus: 'pending' });
    m.applyEstimateToProfile(a, e.id, { calories: 100, estimateStatus: 'done' });          // first estimate lands
    const dropped = m.applyEstimateToProfile(a, e.id, { calories: 999, estimateStatus: 'done' }); // stale second one
    ok(dropped === null, 'stale estimate on a non-pending entry is dropped');
    ok(m.entriesForDate('2026-07-18')[0].calories === 100, 'entry keeps its first value, not the stale 999');
  }

  // 10) Crash-safe migration: a re-run does not duplicate the BJ profile ------
  {
    const dir = fresh();
    seedLegacy(dir, { version: 1, settings: { dailyGoal: 1500 }, entries: [{ id: 'e1', date: '2026-07-18', text: 'a', calories: 10 }] });
    new ProfileManager(dir); // first (complete) migration
    // Simulate a crash mid-migration: legacy file back on disk + sentinel cleared,
    // but the BJ profile already exists.
    seedLegacy(dir, { version: 1, settings: { dailyGoal: 1500 }, entries: [{ id: 'e1', date: '2026-07-18', text: 'a', calories: 10 }] });
    const gp = path.join(dir, 'global.json');
    const g = JSON.parse(fs.readFileSync(gp, 'utf8')); g.migratedLegacy = false; fs.writeFileSync(gp, JSON.stringify(g));
    const m2 = new ProfileManager(dir);
    ok(m2.listProfiles().profiles.filter(p => p.name === 'BJ').length === 1, 'crash re-run does not duplicate the BJ profile');
    ok(!fs.existsSync(path.join(dir, 'data.json')), 'crash re-run archives the stray legacy data.json');
  }

  // 11) A malformed activeProfileId degrades to the gate (no crash) -----------
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    m.createProfile({ name: 'A' });
    const gp = path.join(dir, 'global.json');
    const g = JSON.parse(fs.readFileSync(gp, 'utf8')); g.activeProfileId = '../evil'; fs.writeFileSync(gp, JSON.stringify(g));
    let m2 = null, threw = false;
    try { m2 = new ProfileManager(dir); } catch (_) { threw = true; }
    ok(!threw && m2, 'construction does not throw on a malformed activeProfileId');
    ok(m2.getActiveProfileId() === null, 'malformed active id degrades to the gate');
  }

  // 12) Per-profile hints (B1): add, dedupe, rev bump, per-profile isolation -----
  {
    const dir = fresh();
    const m = new ProfileManager(dir);
    const a = m.createProfile({ name: 'A' }).profile.id;
    ok(m.getHintsFor(a).rev === 0 && m.getHintsFor(a).lines.length === 0, 'new profile has no hints');
    const r1 = m.addActiveHints([{ key: 'latte', line: 'a "latte" is about 190 kcal for me' }]);
    ok(r1.rev === 1 && m.getHintsFor(a).lines.length === 1, 'adding a hint bumps rev and stores it');
    m.addActiveHints([{ key: 'Latte', line: 'a "latte" is about 210 kcal for me' }]); // same food (case-insensitive)
    const h = m.getHintsFor(a);
    ok(h.lines.length === 1 && h.lines[0].includes('210'), 'same food replaces the prior hint (newest wins)');
    ok(h.rev === 2, 'rev increments on each change');
    const b = m.createProfile({ name: 'B' }).profile.id;
    ok(m.getHintsFor(b).lines.length === 0, 'hints do not leak across profiles');
    ok(m.getHintsFor(a).lines.length === 1, "profile A's hints intact after switching to B");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => { try { run(); } catch (e) { console.log('THREW:', e && e.stack || e); app.exit(2); } });
