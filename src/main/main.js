'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { ProfileManager } = require('./store');
const { EstimateCache } = require('./estcache');
const llm = require('./llm');
const updater = require('./updater');

let manager;
let estCache;
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 800,
    minWidth: 760,
    minHeight: 580,
    backgroundColor: '#0f1115',
    title: 'Cricket Calorie Tracker',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  manager = new ProfileManager(app.getPath('userData'));
  estCache = new EstimateCache(path.join(app.getPath('userData'), 'estimate-cache.json'));
  registerIpc();
  createWindow();
  updater.initUpdater(mainWindow);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function registerIpc() {
  const wrap = (fn) => async (_evt, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  };

  // ---- settings (AI global + token redacted; goal/theme per profile) ----
  ipcMain.handle('settings:get', wrap(async () => manager.getSettings()));
  ipcMain.handle('settings:set', wrap(async (patch) => manager.setSettings(patch)));

  // ---- profiles ----
  ipcMain.handle('profiles:list', wrap(async () => manager.listProfiles()));
  ipcMain.handle('profiles:create', wrap(async (info) => manager.createProfile(info)));
  ipcMain.handle('profiles:rename', wrap(async ({ id, name }) => manager.renameProfile(id, name)));
  ipcMain.handle('profiles:update', wrap(async ({ id, patch }) => manager.updateProfile(id, patch)));
  ipcMain.handle('profiles:delete', wrap(async (id) => manager.deleteProfile(id)));
  ipcMain.handle('profiles:switch', wrap(async (id) => manager.switchProfile(id)));

  // ---- entries ----
  ipcMain.handle('entries:forDate', wrap(async (date) => manager.entriesForDate(date)));
  ipcMain.handle('entries:inRange', wrap(async ({ start, end }) => manager.entriesInRange(start, end)));
  ipcMain.handle('entries:add', wrap(async (entry) => manager.addEntry(entry)));
  ipcMain.handle('entries:update', wrap(async (entry) => manager.updateEntry(entry)));
  ipcMain.handle('entries:delete', wrap(async (id) => manager.deleteEntry(id)));

  // ---- AI ----
  // Synchronous estimate of arbitrary text (used by "re-estimate").
  ipcMain.handle('ai:estimate', wrap(async (text) => estimateText(text, manager.getActiveProfileId())));

  // One-sentence weekly coach line from the week's aggregates (B2).
  ipcMain.handle('ai:weekInsight', wrap(async (agg) => llm.weekInsight(manager.getSettingsForLLM(), agg)));

  // ---- personalization hints (B1) ----
  ipcMain.handle('hints:add', wrap(async (list) => manager.addActiveHints(list)));
  ipcMain.handle('hints:list', wrap(async () => manager.listActiveHints()));

  // Async estimate that applies its result to an existing (pending) entry in a
  // SPECIFIC profile. The renderer fires this without blocking Save; it resolves
  // to the updated entry (done or error) so the row can be patched in place.
  ipcMain.handle('ai:estimateEntry', async (_evt, { profileId, entryId, text }) => {
    try {
      const est = await estimateText(text, profileId);
      const updated = manager.applyEstimateToProfile(profileId, entryId, {
        calories: est.calories, calories_low: est.calories_low, calories_high: est.calories_high,
        carbs_g: est.carbs_g, sugar_g: est.sugar_g, protein_g: est.protein_g, fat_g: est.fat_g,
        items: est.items, notes: est.notes, confidence: est.confidence,
        estimateStatus: 'done', estimateError: ''
      });
      return { ok: true, data: updated };
    } catch (err) {
      const updated = manager.applyEstimateToProfile(profileId, entryId, {
        estimateStatus: 'error', estimateError: String(err && err.message || err)
      });
      return { ok: true, data: updated, estimateFailed: true };
    }
  });

  // Test connection. Token is host-bound in main: if the renderer didn't send a
  // fresh token, reuse the stored one only when the base host matches.
  ipcMain.handle('ai:test', wrap(async (overrideAi) => {
    const base = manager.getStoredAIForLLM();
    const ai = { ...base, ...(overrideAi || {}) };
    const sentKey = overrideAi && typeof overrideAi.apiKey === 'string' && overrideAi.apiKey !== '';
    // Reuse the stored token only when the full ORIGIN matches (scheme+host+port),
    // so an https->http downgrade to the same host can't transmit it in the clear.
    if (!sentKey) ai.apiKey = (safeOrigin(ai.baseUrl) === safeOrigin(base.baseUrl)) ? base.apiKey : '';
    return llm.testConnection({ ai });
  }));

  // ---- data backup ----
  ipcMain.handle('data:export', wrap(async () => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export backup',
      defaultPath: `cricket-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, manager.exportJSON(), 'utf8');
    return { canceled: false, path: res.filePath };
  }));
  ipcMain.handle('data:import', wrap(async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import backup', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const info = manager.importJSON(fs.readFileSync(res.filePaths[0], 'utf8'));
    return { canceled: false, ...info };
  }));

  // ---- updates ----
  ipcMain.handle('update:check', wrap(async () => updater.checkForUpdates()));
  ipcMain.handle('update:install', wrap(async () => updater.quitAndInstall()));
  ipcMain.handle('update:state', wrap(async () => updater.getState()));

  // ---- app info ----
  ipcMain.handle('app:info', wrap(async () => {
    const activeId = manager.getActiveProfileId();
    return {
      version: app.getVersion(),
      userDataPath: app.getPath('userData'),
      profilesDir: path.join(app.getPath('userData'), 'profiles'),
      activeProfileId: activeId,
      dataPath: activeId ? path.join(app.getPath('userData'), 'profiles', activeId + '.json') : '(no profile selected)'
    };
  }));
}

function safeOrigin(u) { try { return new URL(u).origin.toLowerCase(); } catch (_) { return ''; } }

// Estimate with a persistent normalized-text cache: repeat foods return instantly
// and identically (no per-call LLM drift), and the server is spared the work.
// The profile's personalization hints (B1) are injected into the prompt, and the
// cache is scoped to that profile + its hints revision.
async function estimateText(text, profileId) {
  const s = manager.getSettingsForLLM();
  const { lines, rev } = profileId ? manager.getHintsFor(profileId) : { lines: [], rev: 0 };
  const ns = profileId ? `${profileId}#${rev}` : '';
  const cached = estCache.get(s.ai, text, ns);
  if (cached) return cached;
  const est = await llm.estimate(s, text, lines);
  estCache.set(s.ai, text, est, ns);
  return est;
}
