'use strict';

const { app } = require('electron');

/**
 * GitHub auto-update via electron-updater.
 *
 * Safe by construction:
 *  - no-ops in dev (unpackaged) and for the portable build (which can't self-update)
 *  - lazy-requires electron-updater so the app still runs if it isn't installed
 *  - every failure is caught and surfaced as state, never crashes the app
 *
 * Only the NSIS installer build self-updates. State is pushed to the renderer on
 * 'update:status' and is also readable via getState().
 */

let autoUpdater = null;
let win = null;
let started = false;
let checkTimer = null;

const state = {
  status: 'idle',        // idle | dev-disabled | unavailable | checking | available |
                         // not-available | downloading | downloaded | error
  currentVersion: '',
  newVersion: '',
  percent: 0,
  error: ''
};

function setState(patch) {
  Object.assign(state, patch);
  try { if (win && !win.isDestroyed()) win.webContents.send('update:status', getState()); } catch (_) { /* ignore */ }
}

function getState() { return { ...state }; }

function initUpdater(browserWindow) {
  win = browserWindow;
  state.currentVersion = safeVersion();

  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) {
    setState({ status: 'dev-disabled' });
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    setState({ status: 'unavailable', error: 'electron-updater not installed' });
    return;
  }

  // Optional file logging; ignore if electron-log isn't present.
  try {
    const log = require('electron-log');
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
  } catch (_) { /* no logger */ }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => setState({ status: 'downloading', newVersion: info && info.version || '', percent: 0 }));
  autoUpdater.on('update-not-available', () => setState({ status: 'not-available' }));
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    // 'downloaded' is terminal — stop the periodic checker so it can't overwrite
    // this ready-to-install state with a later 'checking'/'not-available'.
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    setState({ status: 'downloaded', newVersion: info && info.version || state.newVersion, percent: 100 });
  });
  autoUpdater.on('error', (err) => setState({ status: 'error', error: String(err && err.message || err) }));

  started = true;

  // First check shortly after launch, then every 6 hours. Never fatal.
  setTimeout(() => { checkForUpdates(); }, 8000);
  checkTimer = setInterval(() => { checkForUpdates(); }, 6 * 60 * 60 * 1000);
}

function checkForUpdates() {
  if (!autoUpdater || !started) return getState();
  if (state.status === 'downloaded') return getState(); // keep the ready update sticky
  try {
    const p = autoUpdater.checkForUpdates();
    if (p && typeof p.catch === 'function') p.catch((err) => setState({ status: 'error', error: String(err && err.message || err) }));
  } catch (err) {
    setState({ status: 'error', error: String(err && err.message || err) });
  }
  return getState();
}

function quitAndInstall() {
  if (!autoUpdater || state.status !== 'downloaded') return false;
  // isSilent=true, isForceRunAfter=true — matches oneClick NSIS silent update.
  setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch (_) { /* ignore */ } });
  return true;
}

function safeVersion() { try { return app.getVersion(); } catch (_) { return ''; } }

module.exports = { initUpdater, checkForUpdates, quitAndInstall, getState };
