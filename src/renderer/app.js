'use strict';

/* ============================================================
   Cricket Calorie Tracker — renderer logic
   Talks to main only through window.api (see preload).
   ============================================================ */

const state = {
  view: 'day',
  date: localDate(new Date()),
  settings: null,
  profiles: [],
  activeProfileId: null,
  profile: null,
  editingId: null,          // entry being edited (null when adding)
  editingProfileId: null,   // profile being created/edited (null when creating)
  pickedColor: null,
  editReestimated: false,
  lastEstimate: null
};

const PALETTE = ['#4ea1ff', '#7c5cff', '#37d67a', '#ffb020', '#ff6b9d', '#f6a23c', '#b98cff', '#ff5c6c'];
const MACRO_CAP = { carbs: 300, sugar: 90, protein: 150, fat: 100 };

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadSettings();
  await loadProfiles();
  wireEvents();
  wireProfileEvents();
  initUpdates();
  if (!state.activeProfileId) {
    applyTheme('auto');
    showProfileGate();
  } else {
    hydrateActive();
    renderProfileChip();
    await refresh();
  }
  loadAppInfo();
}

/* ---------------- settings ---------------- */
async function loadSettings() {
  const res = await window.api.settings.get();
  state.settings = res.ok ? res.data : { ai: {}, dailyGoal: null, theme: 'auto' };
  applyTheme(state.settings.theme || 'auto');
}
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
async function loadAppInfo() {
  const res = await window.api.app.info();
  if (res.ok) {
    $('#dataPath').textContent = 'Data file: ' + res.data.dataPath;
    $('#appVersion').textContent = 'v' + res.data.version;
    const gv = $('#gateVersion'); if (gv) gv.textContent = 'Version ' + res.data.version;
  }
}

/* ---------------- profiles ---------------- */
async function loadProfiles() {
  const res = await window.api.profiles.list();
  if (res.ok) { state.profiles = res.data.profiles || []; state.activeProfileId = res.data.activeProfileId || null; }
}
function hydrateActive() {
  state.profile = state.profiles.find(p => p.id === state.activeProfileId) || null;
}
function paintAvatar(el, profile) {
  if (!profile) return;
  el.textContent = profile.avatar || (profile.name || '?').trim().charAt(0).toUpperCase();
  el.style.background = profile.color || 'var(--accent)';
}
function renderProfileChip() {
  if (!state.profile) return;
  paintAvatar($('#profileAvatar'), state.profile);
  $('#profileName').textContent = state.profile.name;
}
function wireProfileEvents() {
  $('#profileChip').addEventListener('click', (e) => { e.stopPropagation(); toggleProfileMenu(); });
  document.addEventListener('click', () => $('#profileMenu').classList.add('hidden'));
  $('#profileMenu').addEventListener('click', (e) => e.stopPropagation());
  $('#gateCreateBtn').addEventListener('click', () => openProfileEdit(null));
  $('#saveProfileBtn').addEventListener('click', saveProfileEdit);
  $('#manageAddBtn').addEventListener('click', () => openProfileEdit(null));
}
function toggleProfileMenu() {
  const menu = $('#profileMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  buildProfileMenu();
  menu.classList.remove('hidden');
}
function buildProfileMenu() {
  const menu = $('#profileMenu');
  menu.innerHTML = '';
  for (const p of state.profiles) {
    const item = document.createElement('div');
    item.className = 'pm-item' + (p.id === state.activeProfileId ? ' active' : '');
    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, p);
    const nm = document.createElement('span'); nm.textContent = p.name;
    item.appendChild(av); item.appendChild(nm);
    if (p.id === state.activeProfileId) { const c = document.createElement('span'); c.className = 'pm-check'; c.textContent = '✓'; item.appendChild(c); }
    else item.addEventListener('click', () => switchProfile(p.id));
    menu.appendChild(item);
  }
  const sep = document.createElement('div'); sep.className = 'pm-sep'; menu.appendChild(sep);
  const add = document.createElement('div'); add.className = 'pm-action'; add.textContent = '＋ Add a profile';
  add.addEventListener('click', () => { $('#profileMenu').classList.add('hidden'); openProfileEdit(null); });
  const mng = document.createElement('div'); mng.className = 'pm-action'; mng.textContent = '⚙ Manage profiles';
  mng.addEventListener('click', () => { $('#profileMenu').classList.add('hidden'); openManage(); });
  menu.appendChild(add); menu.appendChild(mng);
}
function showProfileGate() {
  const wrap = $('#gateProfiles');
  wrap.innerHTML = '';
  for (const p of state.profiles) {
    const b = document.createElement('button');
    b.className = 'gate-profile';
    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, p);
    const nm = document.createElement('span'); nm.textContent = p.name;
    b.appendChild(av); b.appendChild(nm);
    b.addEventListener('click', () => switchProfile(p.id));
    wrap.appendChild(b);
  }
  $('#profileGate').classList.remove('hidden');
}
async function switchProfile(id) {
  const res = await window.api.profiles.switch(id);
  if (!res.ok) { toast(res.error, 'err'); return; }
  state.activeProfileId = id;
  await loadProfiles();
  hydrateActive();
  await loadSettings();
  renderProfileChip();
  $('#profileMenu').classList.add('hidden');
  $('#profileGate').classList.add('hidden');
  closeModal('profilesModal'); // if switching from the Manage list, close it so the switch is visible
  await refresh();
}
function openProfileEdit(id) {
  state.editingProfileId = id;
  const p = id ? state.profiles.find(x => x.id === id) : null;
  $('#profileEditTitle').textContent = id ? 'Edit profile' : 'Create a profile';
  $('#profileNameInput').value = p ? p.name : '';
  $('#profileAvatarInput').value = p ? (p.avatar || '') : '';
  state.pickedColor = p ? p.color : PALETTE[state.profiles.length % PALETTE.length];
  renderSwatches();
  closeModal('profilesModal');
  showModal('profileEditModal');
  setTimeout(() => $('#profileNameInput').focus(), 50);
}
function renderSwatches() {
  const wrap = $('#colorSwatches'); wrap.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === state.pickedColor ? ' sel' : '');
    b.style.background = c;
    b.type = 'button';
    b.addEventListener('click', () => { state.pickedColor = c; renderSwatches(); });
    wrap.appendChild(b);
  }
}
async function saveProfileEdit() {
  const name = $('#profileNameInput').value.trim();
  const avatar = $('#profileAvatarInput').value.trim();
  if (!name) { toast('Please enter a name', 'err'); return; }
  let res;
  if (state.editingProfileId) {
    res = await window.api.profiles.update(state.editingProfileId, { name, color: state.pickedColor, avatar });
  } else {
    res = await window.api.profiles.create(name, state.pickedColor, avatar);
  }
  if (!res.ok) { toast(res.error, 'err'); return; }
  closeModal('profileEditModal');
  await loadProfiles();
  if (state.editingProfileId) {
    hydrateActive(); renderProfileChip();
    openManage(); // return to the Manage list this edit was launched from
    toast('Profile updated', 'ok');
  } else {
    // create() switched to the new profile in main
    state.activeProfileId = res.data.profile.id;
    hydrateActive();
    await loadSettings();
    renderProfileChip();
    $('#profileGate').classList.add('hidden');
    await refresh();
    toast(`Profile "${res.data.profile.name}" created`, 'ok');
  }
}
function openManage() {
  renderManageList();
  showModal('profilesModal');
}
function renderManageList() {
  const list = $('#manageList'); list.innerHTML = '';
  for (const p of state.profiles) {
    const li = document.createElement('li'); li.className = 'manage-item';
    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, p);
    const nm = document.createElement('span'); nm.className = 'm-name'; nm.textContent = p.name;
    li.appendChild(av); li.appendChild(nm);
    if (p.id === state.activeProfileId) { const b = document.createElement('span'); b.className = 'm-active'; b.textContent = 'active'; li.appendChild(b); }
    else { const sw = document.createElement('button'); sw.title = 'Switch to'; sw.textContent = '→'; sw.addEventListener('click', () => switchProfile(p.id)); li.appendChild(sw); }
    const ed = document.createElement('button'); ed.title = 'Edit'; ed.textContent = '✎'; ed.addEventListener('click', () => openProfileEdit(p.id)); li.appendChild(ed);
    const del = document.createElement('button'); del.title = 'Delete'; del.textContent = '🗑'; del.addEventListener('click', () => deleteProfile(p)); li.appendChild(del);
    list.appendChild(li);
  }
}
async function deleteProfile(p) {
  if (!confirm(`Delete profile "${p.name}"? Its entries are archived on disk, not permanently erased.`)) return;
  const res = await window.api.profiles.remove(p.id);
  if (!res.ok) { toast(res.error, 'err'); return; }
  await loadProfiles();
  if (!state.activeProfileId) { // deleted the last profile
    state.profile = null;
    closeModal('profilesModal');
    showProfileGate();
    return;
  }
  hydrateActive(); renderProfileChip(); renderManageList();
  await loadSettings(); applyTheme(state.settings.theme || 'auto');
  await refresh();
  toast('Profile deleted', 'ok');
}

/* ---------------- event wiring ---------------- */
function wireEvents() {
  $$('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#prevBtn').addEventListener('click', () => shiftDate(-1));
  $('#nextBtn').addEventListener('click', () => shiftDate(1));
  $('#todayBtn').addEventListener('click', () => { state.date = localDate(new Date()); $('#datePicker').value = state.date; refresh(); });
  $('#datePicker').addEventListener('change', (e) => { if (e.target.value) { state.date = e.target.value; refresh(); } });

  $('#fab').addEventListener('click', () => openEntryModal(null));
  $('#btnSettings').addEventListener('click', openSettings);

  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  $$('.modal-backdrop').forEach(bd => bd.addEventListener('click', (e) => { if (e.target === bd) closeModal(bd.id); }));

  $('#reestimateBtn').addEventListener('click', reestimate);
  $('#saveEntryBtn').addEventListener('click', saveEntry);

  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#testBtn').addEventListener('click', testConnection);
  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', importData);
  $('#setTheme').addEventListener('change', (e) => applyTheme(e.target.value));
  $('#setApiKey').addEventListener('input', (e) => { e.target.dataset.dirty = '1'; });

  $('#checkUpdatesBtn').addEventListener('click', checkUpdates);
  $('#updateInstallBtn').addEventListener('click', () => window.api.updates.install());
  $('#updateDismissBtn').addEventListener('click', () => $('#updateBanner').classList.add('hidden'));

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach(m => closeModal(m.id)); });
}

/* ---------------- view + date ---------------- */
function setView(view) {
  state.view = view;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $('#dayView').classList.toggle('hidden', view !== 'day');
  $('#weekView').classList.toggle('hidden', view !== 'week');
  refresh();
}
function shiftDate(delta) {
  const d = parseLocalDate(state.date);
  d.setDate(d.getDate() + delta * (state.view === 'week' ? 7 : 1));
  state.date = localDate(d);
  $('#datePicker').value = state.date;
  refresh();
}
async function refresh() {
  if (!state.activeProfileId) return;
  $('#datePicker').value = state.date;
  if (state.view === 'day') await renderDay();
  else await renderWeek();
}

/* ---------------- DAY view ---------------- */
async function renderDay() {
  const res = await window.api.entries.forDate(state.date);
  const entries = res.ok ? res.data : [];
  const totals = sumEntries(entries);

  $('#dayCalories').textContent = totals.calories.toLocaleString();
  const rEl = $('#dayRange');
  const showRange = totals.calories > 0 && totals.calories_low < totals.calories && (totals.calories_high - totals.calories_low) >= 20;
  if (rEl) {
    rEl.textContent = showRange ? `likely ${totals.calories_low.toLocaleString()}–${totals.calories_high.toLocaleString()} kcal` : '';
    rEl.classList.toggle('hidden', !showRange);
  }
  $('#dayDateLabel').textContent = formatFullDate(state.date);
  setMacro('Carbs', totals.carbs_g, MACRO_CAP.carbs);
  setMacro('Sugar', totals.sugar_g, MACRO_CAP.sugar);
  setMacro('Protein', totals.protein_g, MACRO_CAP.protein);
  setMacro('Fat', totals.fat_g, MACRO_CAP.fat);
  renderGoal(totals.calories);

  const list = $('#entryList'); list.innerHTML = '';
  const pend = entries.filter(e => e.estimateStatus === 'pending').length;
  $('#entryCount').textContent = entries.length ? `${entries.length} item${entries.length > 1 ? 's' : ''}${pend ? ` · ${pend} estimating…` : ''}` : '';
  $('#dayEmpty').classList.toggle('hidden', entries.length > 0);
  for (const e of entries) list.appendChild(entryRow(e));
}
function setMacro(name, grams, cap) {
  $('#m' + name).textContent = fmtG(grams);
  $('#bar' + name).style.width = Math.max(0, Math.min(100, (grams / cap) * 100)) + '%';
}
function renderGoal(calories) {
  const goal = state.settings && state.settings.dailyGoal;
  const wrap = $('#dayGoalWrap');
  if (!goal || goal <= 0) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const fill = $('#dayGoalFill');
  fill.style.width = Math.min(100, (calories / goal) * 100) + '%';
  const over = calories > goal, near = calories > goal * 0.9;
  fill.style.background = over ? 'var(--bad)' : near ? 'var(--warn)' : 'var(--good)';
  const diff = Math.abs(goal - calories).toLocaleString();
  $('#dayGoalLabel').textContent = over
    ? `${calories.toLocaleString()} / ${goal.toLocaleString()} kcal · ${diff} over goal`
    : `${calories.toLocaleString()} / ${goal.toLocaleString()} kcal · ${diff} left`;
}
function entryRow(e) {
  const li = document.createElement('li');
  li.className = 'entry';
  const macros = `C ${fmtG(e.carbs_g)} · S ${fmtG(e.sugar_g)} · P ${fmtG(e.protein_g)} · F ${fmtG(e.fat_g)}`;
  const conf = (e.estimateStatus === 'done' && e.confidence) ? ` <span class="conf-pill ${e.confidence}" title="AI confidence in this estimate">${e.confidence}</span>` : '';
  const badge = e.estimateStatus === 'done' ? `<span class="badge-est">AI</span>${conf}` : '';

  const main = document.createElement('div'); main.className = 'e-main';
  const showMacros = (e.estimateStatus === 'done' || e.estimateStatus === 'manual');
  main.innerHTML = `<div class="e-text">${escapeHtml(e.text)}${badge}</div>` + (showMacros ? `<div class="e-macros">${macros}</div>` : '');
  if (e.items && e.items.length && showMacros) main.appendChild(itemList(e.items));

  const time = document.createElement('div'); time.className = 'e-time'; time.textContent = formatTime(e.datetime);
  const right = calCell(e);
  const actions = document.createElement('div'); actions.className = 'e-actions';
  if (e.estimateStatus === 'done' || e.estimateStatus === 'manual') {
    actions.appendChild(mkBtn('⧉', 'Log this again', () => duplicateEntry(e)));
  }
  actions.appendChild(mkBtn('✎', 'Edit', () => openEntryModal(e)));
  actions.appendChild(mkBtn('🗑', 'Delete', () => deleteEntry(e)));

  li.appendChild(time); li.appendChild(main); li.appendChild(right); li.appendChild(actions);
  return li;
}
function calCell(e) {
  const cell = document.createElement('div');
  if (e.estimateStatus === 'pending') {
    cell.className = 'e-cal pending';
    cell.innerHTML = `<span class="spinner"></span> estimating…`;
  } else if (e.estimateStatus === 'error') {
    cell.className = 'e-cal error';
    cell.innerHTML = `⚠ failed `;
    cell.appendChild(mkClass('button', 'e-retry', 'retry', () => retryEstimate(e)));
  } else {
    cell.className = 'e-cal';
    cell.innerHTML = `${e.calories.toLocaleString()}<small> kcal</small>`;
  }
  return cell;
}
function itemList(items) {
  const ul = document.createElement('ul'); ul.className = 'e-items-list';
  for (const it of items) {
    const li = document.createElement('li'); li.className = 'e-item-line';
    const perUnit = it.qty > 1 ? Math.round(it.calories / it.qty) : null;
    const left = document.createElement('span');
    left.innerHTML = `<span class="ei-name">${escapeHtml(it.name)}</span>`
      + (it.qty > 1 ? ` <span class="ei-qty">×${it.qty}</span> <span class="ei-each">· ~${perUnit} kcal each</span>` : '');
    const right = document.createElement('span'); right.className = 'ei-total'; right.textContent = `${Math.round(it.calories)} kcal`;
    li.appendChild(left); li.appendChild(right); ul.appendChild(li);
  }
  return ul;
}
function mkBtn(txt, title, fn) { return mkClass('button', '', txt, fn, title); }
function mkClass(tag, cls, txt, fn, title) {
  const el = document.createElement(tag); if (cls) el.className = cls; el.textContent = txt; if (title) el.title = title;
  el.addEventListener('click', fn); return el;
}
async function deleteEntry(e) {
  const res = await window.api.entries.remove(e.id);
  if (res.ok) { toast('Entry deleted', 'ok'); refresh(); } else toast('Could not delete: ' + res.error, 'err');
}
async function duplicateEntry(e) {
  // "Had this again": copy the entry onto the day being viewed, at the current time.
  const copy = {
    text: e.text, date: state.date, datetime: combineDateTime(state.date, nowTimeInput()),
    calories: e.calories, calories_low: e.calories_low, calories_high: e.calories_high,
    carbs_g: e.carbs_g, sugar_g: e.sugar_g, protein_g: e.protein_g, fat_g: e.fat_g,
    items: e.items, notes: e.notes, confidence: e.confidence,
    estimateStatus: e.estimateStatus === 'done' ? 'done' : 'manual'
  };
  const res = await window.api.entries.add(copy);
  if (res.ok) { toast('Logged again', 'ok'); refresh(); } else toast('Could not add: ' + res.error, 'err');
}
async function retryEstimate(e) {
  const pid = state.activeProfileId;
  await window.api.entries.update({ id: e.id, estimateStatus: 'pending', estimateError: '' });
  refresh();
  fireEstimate(pid, e);
}

/* ---------------- WEEK view ---------------- */
async function renderWeek() {
  const { start, end, days } = weekRange(state.date);
  const res = await window.api.entries.inRange(start, end);
  const entries = res.ok ? res.data : [];
  const byDay = {};
  for (const d of days) byDay[d] = { calories: 0, carbs_g: 0, sugar_g: 0, protein_g: 0, fat_g: 0, count: 0 };
  for (const e of entries) { const b = byDay[e.date]; if (!b) continue; b.calories += e.calories; b.carbs_g += e.carbs_g; b.sugar_g += e.sugar_g; b.protein_g += e.protein_g; b.fat_g += e.fat_g; b.count++; }

  const values = days.map(d => byDay[d].calories);
  const labels = days.map(d => WEEKDAYS[parseLocalDate(d).getDay()]);
  const total = values.reduce((a, b) => a + b, 0);
  const loggedDays = days.filter(d => byDay[d].count > 0).length || 1;
  $('#weekTotal').textContent = total.toLocaleString();
  $('#weekAvg').textContent = Math.round(total / loggedDays).toLocaleString();
  $('#weekRangeLabel').textContent = `${formatShortDate(start)} – ${formatShortDate(end)}`;

  const mt = days.reduce((a, d) => { a.carbs_g += byDay[d].carbs_g; a.sugar_g += byDay[d].sugar_g; a.protein_g += byDay[d].protein_g; a.fat_g += byDay[d].fat_g; return a; }, { carbs_g: 0, sugar_g: 0, protein_g: 0, fat_g: 0 });
  $('#wmCarbs').textContent = fmtG(mt.carbs_g / loggedDays);
  $('#wmSugar').textContent = fmtG(mt.sugar_g / loggedDays);
  $('#wmProtein').textContent = fmtG(mt.protein_g / loggedDays);
  $('#wmFat').textContent = fmtG(mt.fat_g / loggedDays);

  const prev = weekRange(shiftDays(start, -1));
  const prevRes = await window.api.entries.inRange(prev.start, prev.end);
  const prevTotal = sumEntries(prevRes.ok ? prevRes.data : []).calories;
  renderTrend(total, prevTotal);

  const goal = state.settings && state.settings.dailyGoal ? state.settings.dailyGoal : 0;
  window.drawWeekChart($('#weekChart'), { labels, values, goal });

  const avg = Math.round(total / loggedDays);
  const trendPct = prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
  const agg = {
    loggedDays, total, avg,
    carbs: Math.round(mt.carbs_g / loggedDays), sugar: Math.round(mt.sugar_g / loggedDays),
    protein: Math.round(mt.protein_g / loggedDays), fat: Math.round(mt.fat_g / loggedDays),
    prevTotal, trendPct, goal
  };
  renderCoach(start, total, agg);   // B2
  renderRatchet(end, goal);          // B4
}
// B2: one supportive sentence about the week, from the LLM (cached per fingerprint).
async function renderCoach(start, total, agg) {
  const box = $('#weekCoach'), txt = $('#weekCoachText');
  if (!box) return;
  if (!(total > 0) || agg.loggedDays < 1) { box.classList.add('hidden'); return; }
  state.coachCache = state.coachCache || {};
  const fp = `${state.activeProfileId}|${start}|${total}|${agg.avg}|${agg.loggedDays}`;
  if (state.coachCache[fp]) { txt.textContent = state.coachCache[fp]; box.classList.remove('hidden', 'loading'); return; }
  txt.textContent = 'Looking at your week…'; box.classList.remove('hidden'); box.classList.add('loading');
  state.coachFp = fp;
  const res = await window.api.ai.weekInsight(agg);
  if (state.coachFp !== fp) return; // navigated away before it returned
  box.classList.remove('loading');
  if (res.ok && res.data) { state.coachCache[fp] = res.data; txt.textContent = res.data; box.classList.remove('hidden'); }
  else { box.classList.add('hidden'); }
}
// B4: suggest next week's goal ~4% below the trailing 28-day average intake.
async function renderRatchet(end, goal) {
  const box = $('#weekRatchet'); if (!box) return;
  const res = await window.api.entries.inRange(shiftDays(end, -27), end);
  const entries = res.ok ? res.data : [];
  const byDay = {};
  for (const e of entries) byDay[e.date] = (byDay[e.date] || 0) + e.calories;
  const loggedDays = Object.values(byDay).filter(v => v > 0).length;
  const totalWin = Object.values(byDay).reduce((a, b) => a + b, 0);
  const trailingAvg = loggedDays ? Math.round(totalWin / loggedDays) : 0;
  const FLOOR = 1400;
  const suggest = Math.max(FLOOR, Math.round((trailingAvg * 0.96) / 10) * 10);
  const worth = loggedDays >= 5 && trailingAvg > FLOOR + 50 && suggest < trailingAvg && (!goal || suggest < goal - 10);
  if (!worth) { box.classList.add('hidden'); return; }
  $('#ratchetText').innerHTML = `You're averaging <b>${trailingAvg.toLocaleString()}</b> kcal/day over your last ${loggedDays} logged days. Aim for <b>${suggest.toLocaleString()}</b> next week? <span class="muted">(~4% lower)</span>`;
  $('#ratchetBtn').onclick = async () => {
    const r = await window.api.settings.set({ dailyGoal: suggest });
    if (r.ok) { state.settings = r.data; toast(`Goal set to ${suggest.toLocaleString()} kcal/day`, 'ok'); refresh(); }
    else toast('Could not set goal: ' + r.error, 'err');
  };
  box.classList.remove('hidden');
}
function renderTrend(thisWeek, lastWeek) {
  const el = $('#weekTrend'); el.className = 'stat-num';
  if (!lastWeek) { el.textContent = '—'; return; }
  const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  if (pct === 0) { el.textContent = '±0%'; return; }
  const down = pct < 0;
  el.textContent = (down ? '▼ ' : '▲ ') + Math.abs(pct) + '%';
  el.classList.add(down ? 'trend-down' : 'trend-up');
}

/* ---------------- entry modal ---------------- */
function openEntryModal(entry) {
  state.editingId = entry ? entry.id : null;
  state.editingWasPending = !!(entry && entry.estimateStatus === 'pending');
  state.editReestimated = false;
  state.lastEstimate = null;
  state.editItems = [];
  $('#entryModalTitle').textContent = entry ? 'Edit entry' : 'Add something you ate or drank';
  $('#foodText').value = entry ? entry.text : '';
  $('#foodTime').value = entry ? toTimeInput(entry.datetime) : nowTimeInput();
  $('#reestimateStatus').textContent = '';
  const editing = !!entry;
  $('#editBlock').classList.toggle('hidden', !editing);
  $('#addHint').classList.toggle('hidden', editing);
  if (editing) {
    $('#fCalories').value = entry.calories;
    $('#fCarbs').value = entry.carbs_g; $('#fSugar').value = entry.sugar_g;
    $('#fProtein').value = entry.protein_g; $('#fFat').value = entry.fat_g;
    renderEstItems(entry.items || []); $('#estNotes').textContent = entry.notes || '';
  }
  showModal('entryModal');
  setTimeout(() => $('#foodText').focus(), 50);
}
function renderEstItems(items) {
  // Editable per-item calories (B1). Keeping the original value lets us detect a
  // correction and remember it for this profile.
  state.editItems = (items || []).map(it => ({ ...it, _orig: Math.round(it.calories || 0) }));
  const box = $('#estItems'); box.innerHTML = '';
  state.editItems.forEach((it, i) => {
    const row = document.createElement('div'); row.className = 'est-item edit';
    const label = document.createElement('span'); label.className = 'ei-label';
    label.innerHTML = `${escapeHtml(it.name)}${it.qty > 1 ? ` <span class="ei-qty">×${it.qty}</span>` : ''}`;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.step = '1'; input.className = 'ei-input';
    input.value = Math.round(it.calories || 0);
    input.setAttribute('aria-label', it.name + ' calories');
    input.addEventListener('input', () => onItemCaloriesChange(i, input.value));
    const unit = document.createElement('span'); unit.className = 'ei-unit'; unit.textContent = 'kcal';
    row.appendChild(label); row.appendChild(input); row.appendChild(unit);
    box.appendChild(row);
  });
}
function onItemCaloriesChange(i, val) {
  const it = state.editItems[i]; if (!it) return;
  const old = it.calories || 0;
  const next = Math.max(0, Math.round(Number(val) || 0));
  if (old > 0) { const f = next / old; it.carbs_g = round1((it.carbs_g || 0) * f); it.sugar_g = round1((it.sugar_g || 0) * f); it.protein_g = round1((it.protein_g || 0) * f); it.fat_g = round1((it.fat_g || 0) * f); }
  it.calories = next;
  resumItemTotals();
}
function resumItemTotals() {
  if (!state.editItems || !state.editItems.length) return;
  const sum = k => state.editItems.reduce((a, it) => a + (Number(it[k]) || 0), 0);
  $('#fCalories').value = Math.round(sum('calories'));
  $('#fCarbs').value = round1(sum('carbs_g')); $('#fSugar').value = round1(sum('sugar_g'));
  $('#fProtein').value = round1(sum('protein_g')); $('#fFat').value = round1(sum('fat_g'));
}
function round1(n) { return Math.round(n * 10) / 10; }
async function reestimate() {
  const text = $('#foodText').value.trim();
  if (!text) { toast('Type what you had first', 'err'); return; }
  const status = $('#reestimateStatus'); status.textContent = '✨ estimating…';
  $('#reestimateBtn').disabled = true;
  const res = await window.api.ai.estimate(text);
  $('#reestimateBtn').disabled = false;
  if (!res.ok) { status.textContent = '⚠ ' + res.error; return; }
  const est = res.data;
  state.lastEstimate = est; state.editReestimated = true;
  status.textContent = '';
  $('#fCalories').value = est.calories; $('#fCarbs').value = est.carbs_g; $('#fSugar').value = est.sugar_g;
  $('#fProtein').value = est.protein_g; $('#fFat').value = est.fat_g;
  renderEstItems(est.items || []); $('#estNotes').textContent = est.notes || '';
}
async function saveEntry() {
  const text = $('#foodText').value.trim();
  if (!text) { toast('Type what you had first', 'err'); return; }
  const datetime = combineDateTime(state.date, $('#foodTime').value);

  if (!state.editingId) {
    // ADD: save immediately as pending, then estimate asynchronously.
    // Capture the profile id BEFORE any await so a mid-await profile switch can't
    // misroute the estimate.
    const pid = state.activeProfileId;
    const res = await window.api.entries.add({ text, datetime, date: state.date, estimateStatus: 'pending', calories: 0 });
    if (!res.ok) { toast('Could not save: ' + res.error, 'err'); return; }
    closeModal('entryModal');
    await refresh();
    fireEstimate(pid, res.data);
    return;
  }

  // EDIT. Capture the profile id before any await (a re-fired estimate needs it).
  const pid = state.activeProfileId;
  const num = (id) => { const v = Number($('#' + id).value); return Number.isFinite(v) && v >= 0 ? v : 0; };
  // Status: re-estimated -> done. Still-estimating and not re-estimated -> keep
  // estimating (never silently pin a pending entry to a manual 0). Otherwise -> manual.
  const status = state.editReestimated ? 'done' : (state.editingWasPending ? 'pending' : 'manual');
  const entry = { id: state.editingId, text, datetime, date: state.date, estimateStatus: status };
  if (status === 'pending') {
    entry.calories = 0; entry.calories_low = 0; entry.calories_high = 0; entry.confidence = '';
    entry.carbs_g = 0; entry.sugar_g = 0; entry.protein_g = 0; entry.fat_g = 0;
    entry.items = []; entry.estimateError = '';
  } else {
    const itemsChanged = (state.editItems || []).some(it => it._orig != null && Math.abs((it.calories || 0) - it._orig) > 3);
    entry.calories = Math.round(num('fCalories')); entry.carbs_g = num('fCarbs'); entry.sugar_g = num('fSugar');
    entry.protein_g = num('fProtein'); entry.fat_g = num('fFat');
    entry.items = cleanItems(state.editItems);
    if (state.lastEstimate && state.editReestimated) entry.notes = state.lastEstimate.notes;
    if (state.editReestimated && !itemsChanged && state.lastEstimate) {
      entry.confidence = state.lastEstimate.confidence;
      entry.calories_low = state.lastEstimate.calories_low; entry.calories_high = state.lastEstimate.calories_high;
    } else {
      // manual or corrected: no AI confidence, range collapses to the entered value
      entry.confidence = ''; entry.calories_low = entry.calories; entry.calories_high = entry.calories;
    }
  }
  const res = await window.api.entries.update(entry);
  if (!res.ok) { toast('Could not save: ' + res.error, 'err'); return; }
  // B1: remember per-item corrections so future estimates for these foods improve.
  let learned = 0;
  if (state.editItems && state.editItems.length) {
    const hints = [];
    for (const it of state.editItems) {
      if (it._orig != null && Math.abs((it.calories || 0) - it._orig) > 3) {
        const per = it.qty > 1 ? Math.round(it.calories / it.qty) : Math.round(it.calories);
        hints.push({ key: it.name, line: `a "${it.name}" is about ${per} kcal for me` });
      }
    }
    if (hints.length) { window.api.hints.add(hints); learned = hints.length; }
  }
  closeModal('entryModal');
  toast(learned ? "Saved — I'll remember that for next time" : 'Saved', 'ok');
  await refresh();
  if (status === 'pending') fireEstimate(pid, res.data); // keep estimating the (possibly edited) text
}
function cleanItems(items) {
  return (items || []).map(it => ({
    name: it.name, qty: it.qty || 1, portion: it.portion || '',
    calories: Math.round(it.calories || 0),
    carbs_g: round1(it.carbs_g || 0), sugar_g: round1(it.sugar_g || 0), protein_g: round1(it.protein_g || 0), fat_g: round1(it.fat_g || 0)
  }));
}
async function fireEstimate(profileId, entry) {
  try {
    await window.api.ai.estimateEntry(profileId, entry.id, entry.text);
  } catch (_) { /* main catches; row will show error via store */ }
  if (state.activeProfileId === profileId) refresh();
}

/* ---------------- settings modal ---------------- */
function openSettings() {
  const s = state.settings || {}; const ai = s.ai || {};
  $('#setMode').value = ai.mode || 'ollama';
  $('#setBaseUrl').value = ai.baseUrl || '';
  $('#setModel').value = ai.model || '';
  $('#setInsecure').checked = !!ai.allowInsecureTLS;
  const k = $('#setApiKey'); k.value = ''; k.dataset.dirty = '';
  k.placeholder = ai.apiKeySet ? '•••••••• saved — leave blank to keep' : 'leave blank if none';
  $('#setGoal').value = s.dailyGoal || '';
  $('#setTheme').value = s.theme || 'auto';
  $('#testResult').textContent = ''; $('#testResult').className = 'test-result';
  showModal('settingsModal');
}
function collectSettings() {
  const k = $('#setApiKey');
  const ai = {
    mode: $('#setMode').value, baseUrl: $('#setBaseUrl').value.trim(), model: $('#setModel').value.trim(),
    allowInsecureTLS: $('#setInsecure').checked,
    timeoutMs: (state.settings && state.settings.ai && state.settings.ai.timeoutMs) || 180000
  };
  if (k.dataset.dirty) ai.apiKey = k.value; // '' clears, a value sets
  const goalRaw = $('#setGoal').value;
  return { ai, dailyGoal: goalRaw === '' ? null : Math.max(0, Math.round(Number(goalRaw) || 0)), theme: $('#setTheme').value };
}
async function saveSettings() {
  const res = await window.api.settings.set(collectSettings());
  if (res.ok) { state.settings = res.data; applyTheme(state.settings.theme); closeModal('settingsModal'); toast('Settings saved', 'ok'); refresh(); }
  else toast('Could not save settings: ' + res.error, 'err');
}
async function testConnection() {
  const el = $('#testResult'); el.className = 'test-result'; el.textContent = 'Testing…';
  const res = await window.api.ai.test(collectSettings().ai);
  if (res.ok) { el.className = 'test-result ok'; el.textContent = `✓ Connected in ${res.data.ms} ms · model: ${res.data.model}`; }
  else { el.className = 'test-result err'; el.textContent = '✗ ' + res.error; }
}
async function exportData() {
  const res = await window.api.data.export();
  if (res.ok && !res.data.canceled) toast('Backup saved', 'ok');
  else if (!res.ok) toast('Export failed: ' + res.error, 'err');
}
async function importData() {
  if (!confirm(`Import will REPLACE the data in the current profile "${state.profile ? state.profile.name : ''}". Continue?`)) return;
  const res = await window.api.data.import();
  if (res.ok && !res.data.canceled) { toast(`Imported ${res.data.entries} entries`, 'ok'); refresh(); }
  else if (!res.ok) toast('Import failed: ' + res.error, 'err');
}

/* ---------------- updates ---------------- */
function initUpdates() {
  window.api.updates.getState().then(res => { if (res.ok) renderUpdateStatus(res.data); });
  window.api.updates.onStatus(renderUpdateStatus);
}
function renderUpdateStatus(s) {
  const line = $('#updateStatusLine');
  const map = {
    'idle': '', 'dev-disabled': 'Auto-update is off in development.', 'unavailable': 'Updater not available in this build.',
    'checking': 'Checking for updates…', 'not-available': 'You’re on the latest version.',
    'downloading': `Downloading update${s.percent ? ' ' + s.percent + '%' : ''}…`,
    'downloaded': `Update ${s.newVersion || ''} ready.`, 'error': 'Update check failed: ' + (s.error || '')
  };
  if (line) line.textContent = map[s.status] || '';
  const banner = $('#updateBanner');
  if (s.status === 'downloaded') { $('#updateBannerText').textContent = `Version ${s.newVersion || ''} is ready to install.`; banner.classList.remove('hidden'); }
}
async function checkUpdates() {
  $('#updateStatusLine').textContent = 'Checking for updates…';
  const res = await window.api.updates.check();
  if (res.ok) renderUpdateStatus(res.data);
}

/* ---------------- modal + toast ---------------- */
function showModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) {
  $('#' + id).classList.add('hidden');
  // Closing Settings without saving must not leave a live-previewed theme applied.
  if (id === 'settingsModal' && state.settings) applyTheme(state.settings.theme || 'auto');
}
let toastTimer = null;
function toast(msg, kind) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------------- pure helpers ---------------- */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function sumEntries(entries) {
  return entries.reduce((a, e) => {
    a.calories += e.calories;
    a.calories_low += (e.calories_low > 0 ? e.calories_low : e.calories);
    a.calories_high += (e.calories_high > 0 ? e.calories_high : e.calories);
    a.carbs_g += e.carbs_g; a.sugar_g += e.sugar_g; a.protein_g += e.protein_g; a.fat_g += e.fat_g; return a;
  }, { calories: 0, calories_low: 0, calories_high: 0, carbs_g: 0, sugar_g: 0, protein_g: 0, fat_g: 0 });
}
function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function parseLocalDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftDays(s, n) { const d = parseLocalDate(s); d.setDate(d.getDate() + n); return localDate(d); }
function weekRange(dateStr) {
  const d = parseLocalDate(dateStr); const dow = (d.getDay() + 6) % 7;
  const start = new Date(d); start.setDate(d.getDate() - dow);
  const days = []; for (let i = 0; i < 7; i++) { const x = new Date(start); x.setDate(start.getDate() + i); days.push(localDate(x)); }
  return { start: days[0], end: days[6], days };
}
function combineDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number); const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0).toISOString();
}
function nowTimeInput() { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function toTimeInput(iso) { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function formatTime(iso) { const d = new Date(iso); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0'); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${m} ${ap}`; }
function formatFullDate(s) { const d = parseLocalDate(s); return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
function formatShortDate(s) { const d = parseLocalDate(s); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; }
function fmtG(n) { const v = Math.round(n * 10) / 10; return (Number.isInteger(v) ? v : v.toFixed(1)) + ' g'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
