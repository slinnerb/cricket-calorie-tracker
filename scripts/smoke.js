'use strict';
/* Headless Electron smoke test of the REAL renderer <-> preload <-> IPC <-> store
   path with the multi-user ProfileManager backend. Exits non-zero on any failure
   or renderer console error. Run: npm run smoke */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ProfileManager } = require('../src/main/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cricket-smoke-'));
const manager = new ProfileManager(tmp);
// NOTE: intentionally NO pre-created profile — we exercise the first-run gate flow
// (gate -> create profile) which must render the modal ABOVE the gate.

const wrap = (fn) => async (_e, ...a) => {
  try { return { ok: true, data: await fn(...a) }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
};
ipcMain.handle('settings:get', wrap(async () => manager.getSettings()));
ipcMain.handle('settings:set', wrap(async (p) => manager.setSettings(p)));
ipcMain.handle('profiles:list', wrap(async () => manager.listProfiles()));
ipcMain.handle('profiles:create', wrap(async (i) => manager.createProfile(i)));
ipcMain.handle('profiles:rename', wrap(async ({ id, name }) => manager.renameProfile(id, name)));
ipcMain.handle('profiles:update', wrap(async ({ id, patch }) => manager.updateProfile(id, patch)));
ipcMain.handle('profiles:delete', wrap(async (id) => manager.deleteProfile(id)));
ipcMain.handle('profiles:switch', wrap(async (id) => manager.switchProfile(id)));
ipcMain.handle('entries:forDate', wrap(async (d) => manager.entriesForDate(d)));
ipcMain.handle('entries:inRange', wrap(async ({ start, end }) => manager.entriesInRange(start, end)));
ipcMain.handle('entries:add', wrap(async (e) => manager.addEntry(e)));
ipcMain.handle('entries:update', wrap(async (e) => manager.updateEntry(e)));
ipcMain.handle('entries:delete', wrap(async (id) => manager.deleteEntry(id)));
ipcMain.handle('ai:estimate', wrap(async () => { throw new Error('skipped in smoke'); }));
ipcMain.handle('ai:estimateEntry', async () => ({ ok: true, data: null }));
ipcMain.handle('ai:test', wrap(async () => ({ ok: true })));
ipcMain.handle('hints:add', wrap(async (list) => manager.addActiveHints(list)));
ipcMain.handle('hints:list', wrap(async () => manager.listActiveHints()));
ipcMain.handle('data:export', wrap(async () => ({ canceled: true })));
ipcMain.handle('data:import', wrap(async () => ({ canceled: true })));
ipcMain.handle('update:check', wrap(async () => ({ status: 'dev-disabled' })));
ipcMain.handle('update:install', wrap(async () => false));
ipcMain.handle('update:state', wrap(async () => ({ status: 'dev-disabled', currentVersion: app.getVersion() })));
ipcMain.handle('app:info', wrap(async () => ({ version: app.getVersion(), dataPath: tmp, activeProfileId: manager.getActiveProfileId() })));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });

  try {
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    const r = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      await wait(250); // let init() settle
      const out = { apiExists: typeof window.api === 'object' && window.api !== null };
      if (!out.apiExists) return out;
      out.namespaces = ['settings','profiles','entries','ai','data','updates','app'].every(k => window.api[k]);

      // --- first-run gate ---
      out.gateShown = !document.querySelector('#profileGate').classList.contains('hidden');
      out.gateShowsVersion = /\\d/.test(document.querySelector('#gateVersion').textContent);
      const gz = Number(getComputedStyle(document.querySelector('#profileGate')).zIndex);
      const mz = Number(getComputedStyle(document.querySelector('#entryModal')).zIndex);
      out.modalAboveGate = mz > gz;

      // --- create a profile THROUGH the gate (the path that was broken) ---
      document.querySelector('#gateCreateBtn').click();
      await wait(150);
      const em = document.querySelector('#profileEditModal');
      out.createModalVisible = !em.classList.contains('hidden');
      const ir = em.querySelector('.modal').getBoundingClientRect();
      const topEl = document.elementFromPoint(ir.left + ir.width / 2, ir.top + 30);
      out.createModalClickable = em.contains(topEl); // NOT occluded by the gate
      document.querySelector('#profileNameInput').value = 'Smoke';
      document.querySelector('#saveProfileBtn').click();
      await wait(350);
      out.enteredApp = document.querySelector('#profileGate').classList.contains('hidden');
      out.chipName = (document.querySelector('#profileName') || {}).textContent;

      // --- now in the app: settings redaction + entries + updates ---
      const st = await window.api.settings.get();
      out.tokenRedacted = st.ok && st.data.ai && st.data.ai.apiKey === undefined && st.data.ai.apiKeyEnc === undefined;
      out.aiDefaults = st.ok && st.data.ai.mode === 'ollama' && !!st.data.ai.baseUrl;
      const today = (() => { const d=new Date(); const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); })();
      const add = await window.api.entries.add({ text:'3 oreos and a coffee', date: today, datetime:new Date().toISOString(), estimateStatus:'pending', calories:0 });
      out.addPending = add.ok && add.data.estimateStatus === 'pending';
      const list = await window.api.entries.forDate(today);
      out.listOk = list.ok && list.data.length === 1;
      const up = await window.api.updates.getState();
      out.updatesOk = up.ok && up.data.status === 'dev-disabled';
      out.tabs = document.querySelectorAll('.tab').length === 2;
      return out;
    })()`);

    const checks = {
      'window.api exposed': r.apiExists,
      'all namespaces present': r.namespaces,
      'first-run gate shown': r.gateShown,
      'gate shows version number': r.gateShowsVersion,
      'modal z-index renders above gate': r.modalAboveGate,
      'create-profile modal visible': r.createModalVisible,
      'create-profile modal clickable over gate': r.createModalClickable,
      'creating a profile enters the app': r.enteredApp,
      'profile chip shows new profile': r.chipName === 'Smoke',
      'token redacted over IPC': r.tokenRedacted,
      'ollama AI defaults present': r.aiDefaults,
      'entries:add pending roundtrip': r.addPending,
      'entries:forDate returns entry': r.listOk,
      'updates state = dev-disabled': r.updatesOk,
      'tabs present': r.tabs,
      'no renderer console errors': consoleErrors.length === 0
    };
    let failed = 0;
    for (const [name, ok] of Object.entries(checks)) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; }
    if (consoleErrors.length) console.log('console errors: ' + JSON.stringify(consoleErrors));
    console.log(failed ? `\nSMOKE FAILED (${failed})` : '\nSMOKE OK');
    app.exit(failed ? 1 : 0);
  } catch (err) {
    console.log('SMOKE ERROR ' + (err && err.stack || err));
    app.exit(2);
  }
});
