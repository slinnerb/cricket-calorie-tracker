# 🦗 Cricket — Calorie Tracker

A friendly Windows desktop app for logging everything you eat and drink during
the day — even "a bite of a pancake" — and getting an **AI-estimated** calorie
and macro (carbs, sugar, protein, fat) breakdown. Built so BJ and Eric can each
track their daily and weekly intake and bring it down, week by week.

## What it does

- **Multiple users on one PC.** Pick or create a profile (e.g. "Eric", "BJ") on
  first run and switch anytime from the top-right chip. Each profile has its own
  private database of entries, its own daily goal, and its own theme.
- **Log in plain English.** Type what you had ("3 oreos and a coffee", "a bite of
  pancake with syrup and butter"), hit **Save**, and it appears in the list
  **immediately** — the calorie number shows a spinner and fills in a moment later
  when the local AI finishes. No waiting on a loading screen.
- **Itemized with quantities.** The AI splits an entry into lines: *Oreo ×3 · ~45
  kcal each · 135 kcal*, then *Coffee · 55 kcal*, with the entry total summing them.
- **Day view:** total calories, macro bars, progress toward a daily goal, full
  entry list. **Week view:** a 7-day bar chart with your goal line, weekly total,
  daily average, macro averages, and the **trend vs. last week**.
- **Private.** All food data stays in a local file on the PC. Only the text you
  type is sent to *your own* AI server for estimation. The server token is
  encrypted at rest (Windows DPAPI) and never leaves the main process.
- **Auto-updates** from GitHub Releases (see `RELEASING.md`).

## Running it (development)

```bash
npm install
npm start          # launch the app
npm run smoke      # headless UI/IPC smoke test
npm run test:store # storage + migration + token-encryption unit tests
```

## Building the installer

```bash
npm run dist
```
Produces in `release/`: a **Setup .exe** (NSIS installer — the one that
auto-updates, give this to Eric) and a portable `.exe` (no auto-update).
See **`RELEASING.md`** for the full publish/auto-update flow.

## Connecting the AI (Settings ⚙️, shared per-PC)

The estimator talks to a local LLM over HTTP. The app ships pointed at
`https://ai.wrenchandram.com` in **Ollama** mode with model `qwen2.5:7b`; each
person pastes the **API token** once.

| Field | Value |
|-------|-------|
| **Format** | `Ollama native` (the server only allows `/api/chat`) |
| **Server base URL** | Eric: `https://ai.wrenchandram.com` · BJ on LAN: `https://10.0.0.54:11435` |
| **Model** | `qwen2.5:7b` |
| **API token** | the Bearer token (stored encrypted; leave blank to keep the saved one) |
| **Allow self-signed cert** | ON for the LAN (`10.0.0.54`, internal cert); OFF for the public URL (real cert) |

Click **Test connection** to confirm. See **`REMOTE_ACCESS.md`** to publish the
server so Eric can reach it from another state.

## Where your data lives (per PC)
`%APPDATA%\Cricket Calorie Tracker\`
- `global.json` — shared AI settings + encrypted token + the profile list
- `profiles\p_<id>.json` — one file per user profile (entries, goal, theme)

Use **Export backup…** / **Import backup…** in Settings to save or move a
profile's data. Deleting a profile archives its file (it's not truly erased).

## Project layout
```
src/main/     main.js (window+IPC), preload.js (safe bridge), store.js
              (profiles + global settings + encrypted token), llm.js (AI client),
              updater.js (GitHub auto-update)
src/renderer/ index.html, styles.css, app.js, charts.js  (vanilla, no framework)
scripts/      smoke.js, store.test.js, make-icon.js
RELEASING.md, REMOTE_ACCESS.md
```
