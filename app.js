/* Wren — private cycle tracker
 * All data lives in localStorage on this device only.
 * If a passcode is set, the whole data blob is encrypted with AES-GCM
 * using a key derived from the passcode (PBKDF2). No plaintext copy of
 * locked data is ever written to disk.
 */

const STORAGE_PLAIN = 'wrenData';
const STORAGE_ENC = 'wrenDataEnc';
const DAY = 86400000;
const LUTEAL_DAYS = 14; // fixed luteal phase estimate used in predictions

let state = null;        // in-memory app state (decrypted)
let sessionKey = null;   // CryptoKey while unlocked, only in memory
let calendarCursor = new Date(); calendarCursor.setDate(1);
let activeLogDate = null;
let activeLogRange = null; // {start, end} when logging a dragged range instead of one day
let logSelection = { flow: 'none', mood: null, symptoms: new Set() };
let rangeSelectMode = false;
let isDragSelecting = false;
let dragStartISO = null;
let dragCurrentISO = null;

/* ---------------- utils ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const toISO = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const fromISO = (s) => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, n) => { const nd = new Date(d); nd.setDate(nd.getDate()+n); return nd; };
const daysBetween = (a, b) => Math.round((b - a) / DAY);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add('hidden'), 2200);
}

/* ---------------- default state ---------------- */
function defaultState() {
  return {
    version: 1,
    onboarded: false,
    settings: { avgCycleLength: DEFAULT_CYCLE_LENGTH, avgPeriodLength: DEFAULT_PERIOD_LENGTH, anchorDate: null, trackMood: true },
    logs: {} // 'YYYY-MM-DD' -> { flow, mood, symptoms: [], notes, estimated? }
  };
}

const PAST_CYCLES_TO_PROJECT = 6; // how many earlier cycles to auto-fill from one date
const DEFAULT_CYCLE_LENGTH = 28;  // used only until real logged cycles can predict it
const DEFAULT_PERIOD_LENGTH = 5;  // same

/* ---------------- crypto (only used if a passcode is set) ---------------- */
async function deriveKey(passcode, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  return { key, saltB64: bytesToB64(salt) };
}
function bytesToB64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function b64ToBytes(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }

async function encryptAndStore(passcode, dataObj) {
  const { key, saltB64 } = await deriveKey(passcode, null);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(dataObj)));
  localStorage.setItem(STORAGE_ENC, JSON.stringify({
    salt: saltB64, iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ciphertext))
  }));
  localStorage.removeItem(STORAGE_PLAIN);
  sessionKey = key;
}

async function tryDecrypt(passcode) {
  const raw = localStorage.getItem(STORAGE_ENC);
  if (!raw) return null;
  const { salt, iv, data } = JSON.parse(raw);
  const { key } = await deriveKey(passcode, salt);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(iv) }, key, b64ToBytes(data)
    );
    sessionKey = key;
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    return null; // wrong passcode
  }
}

async function saveState() {
  if (localStorage.getItem(STORAGE_ENC) && sessionKey) {
    // re-encrypt with the same in-memory key (avoid re-deriving from passcode each save)
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, enc.encode(JSON.stringify(state)));
    const rawExisting = JSON.parse(localStorage.getItem(STORAGE_ENC));
    localStorage.setItem(STORAGE_ENC, JSON.stringify({
      salt: rawExisting.salt, iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ciphertext))
    }));
  } else {
    localStorage.setItem(STORAGE_PLAIN, JSON.stringify(state));
  }
}

/* ---------------- cycle math ---------------- */
function derivePeriods() {
  // Group consecutive dates with a logged flow (not 'none') into period entries.
  const days = Object.keys(state.logs)
    .filter(d => state.logs[d].flow && state.logs[d].flow !== 'none')
    .sort();
  const periods = [];
  let cur = null;
  for (const d of days) {
    if (!cur) { cur = { start: d, end: d }; continue; }
    const prevDate = fromISO(cur.end);
    const thisDate = fromISO(d);
    if (daysBetween(prevDate, thisDate) === 1) {
      cur.end = d;
    } else {
      periods.push(cur);
      cur = { start: d, end: d };
    }
  }
  if (cur) periods.push(cur);
  // A period counts as "estimated" only if every day in it was auto-projected
  // and never touched — if the user edits even one day, it's real data.
  periods.forEach(p => {
    let d = fromISO(p.start);
    const end = fromISO(p.end);
    let allEstimated = true;
    while (d <= end) {
      if (!state.logs[toISO(d)] || !state.logs[toISO(d)].estimated) { allEstimated = false; break; }
      d = addDays(d, 1);
    }
    p.estimated = allEstimated;
  });
  return periods; // ascending by start
}

function cycleStats() {
  const periods = derivePeriods();
  const { avgCycleLength: defCycle, avgPeriodLength: defPeriod } = state.settings;

  // Real menstrual cycles don't run shorter than ~15 days or longer than ~60.
  // A gap outside that range is almost always a data-entry slip (e.g. testing
  // drag-select with two close-together taps) rather than a real cycle, so it's
  // excluded from the average instead of dragging the prediction off course.
  const MIN_PLAUSIBLE_CYCLE = 15;
  const MAX_PLAUSIBLE_CYCLE = 60;

  let avgCycleLength = defCycle;
  if (periods.length >= 2) {
    const recentStarts = periods.slice(-8).map(p => fromISO(p.start));
    const diffs = [];
    for (let i = 1; i < recentStarts.length; i++) {
      const gap = daysBetween(recentStarts[i-1], recentStarts[i]);
      if (gap >= MIN_PLAUSIBLE_CYCLE && gap <= MAX_PLAUSIBLE_CYCLE) diffs.push(gap);
    }
    if (diffs.length) avgCycleLength = Math.round(diffs.reduce((a,b)=>a+b,0) / diffs.length);
  }

  let avgPeriodLength = defPeriod;
  const lengths = periods.slice(-8)
    .map(p => daysBetween(fromISO(p.start), fromISO(p.end)) + 1)
    .filter(len => len >= 1 && len <= 14); // implausible period lengths excluded the same way
  if (lengths.length) avgPeriodLength = Math.round(lengths.reduce((a,b)=>a+b,0) / lengths.length);

  const anchor = periods.length ? fromISO(periods[periods.length-1].start)
                                 : (state.settings.anchorDate ? fromISO(state.settings.anchorDate) : new Date());

  const nextPeriodStart = addDays(anchor, avgCycleLength);
  const ovulationDate = addDays(nextPeriodStart, -LUTEAL_DAYS);
  const fertileStart = addDays(ovulationDate, -5);
  const fertileEnd = addDays(ovulationDate, 1);

  return { periods, avgCycleLength, avgPeriodLength, anchor, nextPeriodStart, ovulationDate, fertileStart, fertileEnd };
}

function phaseForDate(date, cyc) {
  const iso = toISO(date);
  const actual = cyc.periods.find(p => iso >= p.start && iso <= p.end);
  if (actual) return 'period';

  let diff = daysBetween(cyc.anchor, date) % cyc.avgCycleLength;
  if (diff < 0) diff += cyc.avgCycleLength;
  const dayInCycle = diff + 1;

  if (dayInCycle <= cyc.avgPeriodLength) return date >= cyc.anchor ? 'period' : 'predicted';
  const ovulationDay = cyc.avgCycleLength - LUTEAL_DAYS;
  if (dayInCycle >= ovulationDay - 5 && dayInCycle <= ovulationDay + 1) return 'fertile';
  return 'none';
}

function phaseLabel(date, cyc) {
  const iso = toISO(date);
  const actual = cyc.periods.find(p => iso >= p.start && iso <= p.end);

  let diff = daysBetween(cyc.anchor, date) % cyc.avgCycleLength;
  if (diff < 0) diff += cyc.avgCycleLength;
  const dayInCycle = diff + 1;

  if (actual) return { label: 'Menstrual phase', dayInCycle };

  const ovulationDay = cyc.avgCycleLength - LUTEAL_DAYS;
  let label;
  if (dayInCycle <= cyc.avgPeriodLength) label = 'Menstrual phase';
  else if (dayInCycle < ovulationDay - 5) label = 'Follicular phase';
  else if (dayInCycle <= ovulationDay + 1) label = 'Fertile window';
  else label = 'Luteal phase';
  return { label, dayInCycle };
}

/* ---------------- rendering ---------------- */
function renderAll() {
  renderHome();
  renderCalendar();
  renderInsights();
  renderSettingsValues();
}

function renderHome() {
  const cyc = cycleStats();
  const today = new Date(); today.setHours(0,0,0,0);
  const { label, dayInCycle } = phaseLabel(today, cyc);

  $('#ringPhaseLabel').textContent = label;
  $('#ringDayLabel').textContent = `Day ${clamp(dayInCycle,1,999)} of ~${cyc.avgCycleLength}`;

  const daysToNext = daysBetween(today, cyc.nextPeriodStart);
  $('#ringSubLabel').textContent = daysToNext >= 0
    ? `${daysToNext === 0 ? 'Expected today' : daysToNext + ' day' + (daysToNext===1?'':'s') + ' to go'}`
    : `Period may be ${Math.abs(daysToNext)} day${Math.abs(daysToNext)===1?'':'s'} late`;

  $('#statNextPeriod').textContent = daysToNext >= 0 ? daysToNext : 'Late';
  const daysToFertile = daysBetween(today, cyc.fertileStart);
  $('#statFertile').textContent = daysToFertile <= 0 && daysBetween(today, cyc.fertileEnd) >= 0
    ? 'Now' : (daysToFertile > 0 ? `in ${daysToFertile}d` : '—');

  const frac = clamp(dayInCycle / cyc.avgCycleLength, 0, 1);
  const circumference = 653.5;
  const ring = $('#ringProgress');
  ring.style.strokeDashoffset = String(circumference * (1 - frac));
  ring.style.stroke = label === 'Menstrual phase' ? 'var(--berry)' : (label === 'Fertile window' ? 'var(--sage)' : 'var(--mauve)');

  const strip = $('#weekStrip');
  strip.innerHTML = '';
  const weekStart = addDays(today, -today.getDay());
  for (let i=0;i<7;i++) {
    const d = addDays(weekStart, i);
    const ph = phaseForDate(d, cyc);
    const el = document.createElement('div');
    el.className = 'week-day' + (toISO(d)===toISO(today) ? ' is-today' : '');
    const dotColor = ph === 'period' ? 'var(--berry)' : ph === 'fertile' ? 'var(--sage)' : ph === 'predicted' ? 'var(--mauve)' : 'var(--sand-deep)';
    el.innerHTML = `<span>${'SMTWTFS'[d.getDay()]}</span><span class="num">${d.getDate()}</span><span class="phase-dot" style="background:${dotColor}"></span>`;
    el.addEventListener('click', () => openLogModal(toISO(d)));
    strip.appendChild(el);
  }
}

function renderCalendar() {
  const cyc = cycleStats();
  const y = calendarCursor.getFullYear(), m = calendarCursor.getMonth();
  $('#monthLabel').textContent = calendarCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const grid = $('#calendarGrid');
  grid.innerHTML = '';
  const firstDay = new Date(y, m, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  for (let i=0;i<startOffset;i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-cell empty';
    grid.appendChild(empty);
  }
  for (let day=1; day<=daysInMonth; day++) {
    const d = new Date(y, m, day);
    const iso = toISO(d);
    const ph = phaseForDate(d, cyc);
    const cell = document.createElement('button');
    cell.className = 'cal-cell';
    cell.dataset.iso = iso;
    if (ph === 'period') {
      cell.classList.add('period');
      const actualPeriod = cyc.periods.find(p => iso >= p.start && iso <= p.end);
      if (actualPeriod && actualPeriod.estimated) cell.classList.add('estimated');
    }
    else if (ph === 'predicted') cell.classList.add('predicted');
    else if (ph === 'fertile') cell.classList.add('fertile');
    if (toISO(d) === toISO(today)) cell.classList.add('today');
    if (state.logs[iso]) cell.classList.add('logged');
    cell.textContent = day;
    cell.addEventListener('click', () => { if (!rangeSelectMode) openLogModal(iso); });
    grid.appendChild(cell);
  }
  grid.classList.toggle('select-mode', rangeSelectMode);
}

function renderInsights() {
  const cyc = cycleStats();
  $('#insAvgCycle').textContent = cyc.avgCycleLength + 'd';
  $('#insAvgPeriod').textContent = cyc.avgPeriodLength + 'd';

  const hist = $('#cycleHistory');
  hist.innerHTML = '';
  const periods = cyc.periods.slice().reverse();
  if (!periods.length) {
    hist.innerHTML = '<p class="muted small">No cycles logged yet.</p>';
  }
  periods.slice(0, 8).forEach((p, idx) => {
    const len = daysBetween(fromISO(p.start), fromISO(p.end)) + 1;
    const row = document.createElement('div');
    row.className = 'history-item';
    const startFmt = fromISO(p.start).toLocaleDateString(undefined, { month:'short', day:'numeric' });
    row.innerHTML = `<span>${startFmt}${p.estimated ? ' <span class="muted small">(estimated)</span>' : ''}</span><span class="len">${len}d period</span>`;
    hist.appendChild(row);
  });

  const freq = {};
  Object.values(state.logs).forEach(l => (l.symptoms||[]).forEach(s => freq[s] = (freq[s]||0)+1));
  const cloud = $('#symptomFreq');
  cloud.innerHTML = '';
  const entries = Object.entries(freq).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) cloud.innerHTML = '<p class="muted small">Log some days to see patterns here.</p>';
  entries.forEach(([sym, count]) => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = `${sym} · ${count}`;
    cloud.appendChild(pill);
  });
}

function renderSettingsValues() {
  $('#setCycleLen').value = state.settings.avgCycleLength;
  $('#setPeriodLen').value = state.settings.avgPeriodLength;
  $('#trackMoodToggle').checked = state.settings.trackMood !== false;
  $('#passcodeBtn').textContent = localStorage.getItem(STORAGE_ENC) ? 'Change / remove' : 'Set up';
}

/* ---------------- drag-to-select a range ---------------- */
function toggleRangeSelectMode() {
  rangeSelectMode = !rangeSelectMode;
  $('#rangeModeToggle').classList.toggle('active', rangeSelectMode);
  $('#rangeModeToggle').textContent = rangeSelectMode ? 'Cancel select' : 'Select range';
  $('#rangeModeHint').classList.toggle('hidden', !rangeSelectMode);
  renderCalendar();
}

function cellForPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.cal-cell:not(.empty)') : null;
}

function updateSelectionHighlight() {
  if (!dragStartISO || !dragCurrentISO) return;
  const lo = dragStartISO < dragCurrentISO ? dragStartISO : dragCurrentISO;
  const hi = dragStartISO < dragCurrentISO ? dragCurrentISO : dragStartISO;
  $$('#calendarGrid .cal-cell').forEach(cell => {
    const iso = cell.dataset.iso;
    cell.classList.toggle('selecting', !!iso && iso >= lo && iso <= hi);
  });
}

function onGridPointerDown(e) {
  if (!rangeSelectMode) return;
  const cell = cellForPoint(e.clientX, e.clientY);
  if (!cell) return;
  isDragSelecting = true;
  dragStartISO = cell.dataset.iso;
  dragCurrentISO = dragStartISO;
  updateSelectionHighlight();
}
function onGridPointerMove(e) {
  if (!isDragSelecting) return;
  const cell = cellForPoint(e.clientX, e.clientY);
  if (!cell) return;
  dragCurrentISO = cell.dataset.iso;
  updateSelectionHighlight();
  e.preventDefault();
}
function onGridPointerUp() {
  if (!isDragSelecting) return;
  isDragSelecting = false;
  const lo = dragStartISO < dragCurrentISO ? dragStartISO : dragCurrentISO;
  const hi = dragStartISO < dragCurrentISO ? dragCurrentISO : dragStartISO;
  openBulkLogModal(lo, hi);
}

/* ---------------- log modal ---------------- */
function openBulkLogModal(startISO, endISO) {
  activeLogRange = { start: startISO, end: endISO };
  activeLogDate = null;
  logSelection = { flow: 'medium', mood: null, symptoms: new Set() };
  $('#logNotes').value = '';

  const nDays = daysBetween(fromISO(startISO), fromISO(endISO)) + 1;
  const startFmt = fromISO(startISO).toLocaleDateString(undefined, { month:'short', day:'numeric' });
  const endFmt = fromISO(endISO).toLocaleDateString(undefined, { month:'short', day:'numeric' });
  $('#logModalDate').textContent = `Log ${nDays} day${nDays===1?'':'s'} (${startFmt}–${endFmt})`;
  $('#logModalRangeHint').classList.remove('hidden');

  $$('#flowChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.flow === logSelection.flow));
  $$('#moodChips .chip').forEach(c => c.classList.remove('selected'));
  $$('#symptomChips .chip').forEach(c => c.classList.remove('selected'));
  $('#moodField').classList.toggle('hidden', state.settings.trackMood === false);

  $('#logModal').classList.remove('hidden');
}

function openLogModal(iso) {
  activeLogDate = iso;
  activeLogRange = null;
  $('#logModalRangeHint').classList.add('hidden');
  const existing = state.logs[iso] || { flow: 'none', mood: null, symptoms: [], notes: '' };
  logSelection = { flow: existing.flow || 'none', mood: existing.mood || null, symptoms: new Set(existing.symptoms || []) };
  $('#logNotes').value = existing.notes || '';

  const d = fromISO(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  $('#logModalDate').textContent = toISO(d) === toISO(today) ? 'Log today' : d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });

  $$('#flowChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.flow === logSelection.flow));
  $$('#moodChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.mood === logSelection.mood));
  $$('#symptomChips .chip').forEach(c => c.classList.toggle('selected', logSelection.symptoms.has(c.dataset.symptom)));

  $('#moodField').classList.toggle('hidden', state.settings.trackMood === false);

  $('#logModal').classList.remove('hidden');
}
function closeLogModal() {
  $('#logModal').classList.add('hidden');
  activeLogDate = null;
  activeLogRange = null;
  $$('#calendarGrid .cal-cell').forEach(c => c.classList.remove('selecting'));
}

async function saveLog() {
  const notes = $('#logNotes').value.trim();
  const entry = { flow: logSelection.flow, mood: logSelection.mood, symptoms: Array.from(logSelection.symptoms), notes };
  const isEmpty = entry.flow === 'none' && !entry.mood && entry.symptoms.length === 0 && !entry.notes;

  if (activeLogRange) {
    let d = fromISO(activeLogRange.start);
    const end = fromISO(activeLogRange.end);
    while (d <= end) {
      const iso = toISO(d);
      if (isEmpty) delete state.logs[iso];
      else state.logs[iso] = { ...entry };
      d = addDays(d, 1);
    }
  } else {
    if (isEmpty) delete state.logs[activeLogDate];
    else state.logs[activeLogDate] = entry;
  }

  await saveState();
  closeLogModal();
  renderAll();
  toast('Saved');
}

/* ---------------- navigation ---------------- */
function switchView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
}

/* ---------------- onboarding ---------------- */
async function completeOnboarding() {
  const lastPeriod = $('#obLastPeriod').value;
  if (!lastPeriod) { toast('Pick a start date to continue'); return; }

  const cycleLen = DEFAULT_CYCLE_LENGTH;
  const periodLen = DEFAULT_PERIOD_LENGTH;

  state = defaultState();
  state.onboarded = true;
  state.settings = { avgCycleLength: cycleLen, avgPeriodLength: periodLen, anchorDate: lastPeriod, trackMood: true };
  const start = fromISO(lastPeriod);

  // The most recent period: a real, confirmed entry.
  for (let i=0;i<periodLen;i++) {
    state.logs[toISO(addDays(start,i))] = { flow: 'medium', mood: null, symptoms: [], notes: '' };
  }

  // Project earlier cycles backward using the default assumptions above, purely
  // so history/averages aren't empty on day one. As soon as the person logs a
  // couple of real periods, cycleStats() switches to averaging their *actual*
  // dates instead of these defaults — nobody has to state a cycle length by hand.
  for (let c=1; c<=PAST_CYCLES_TO_PROJECT; c++) {
    const cycleStart = addDays(start, -c*cycleLen);
    for (let i=0;i<periodLen;i++) {
      const iso = toISO(addDays(cycleStart,i));
      state.logs[iso] = { flow: 'medium', mood: null, symptoms: [], notes: '', estimated: true };
    }
  }

  await saveState();
  $('#onboarding').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderAll();
}

/* ---------------- passcode ---------------- */
function openPinModal() {
  $('#pinNew').value = ''; $('#pinConfirm').value = '';
  $('#pinError').classList.add('hidden');
  $('#pinRemove').classList.toggle('hidden', !localStorage.getItem(STORAGE_ENC));
  $('#pinModal').classList.remove('hidden');
}
function closePinModal() { $('#pinModal').classList.add('hidden'); }

async function savePin() {
  const a = $('#pinNew').value, b = $('#pinConfirm').value;
  if (a.length < 4 || a !== b) { $('#pinError').classList.remove('hidden'); return; }
  await encryptAndStore(a, state);
  closePinModal();
  renderSettingsValues();
  toast('Passcode set');
}
async function removePin() {
  localStorage.setItem(STORAGE_PLAIN, JSON.stringify(state));
  localStorage.removeItem(STORAGE_ENC);
  sessionKey = null;
  closePinModal();
  renderSettingsValues();
  toast('Passcode removed');
}

/* ---------------- export / import ---------------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `wren-export-${toISO(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.settings || !parsed.logs) throw new Error('bad file');
      state = parsed;
      await saveState();
      renderAll();
      toast('Data imported');
    } catch (e) { toast('That file could not be read'); }
  };
  reader.readAsText(file);
}

/* ---------------- boot ---------------- */
async function boot() {
  const hasEnc = !!localStorage.getItem(STORAGE_ENC);
  const hasPlain = !!localStorage.getItem(STORAGE_PLAIN);

  if (hasEnc) {
    $('#lockScreen').classList.remove('hidden');
    $('#lockSubmit').addEventListener('click', attemptUnlock);
    $('#lockInput').addEventListener('keydown', e => { if (e.key === 'Enter') attemptUnlock(); });
    return;
  }
  if (hasPlain) {
    state = JSON.parse(localStorage.getItem(STORAGE_PLAIN));
    startApp();
    return;
  }
  $('#onboarding').classList.remove('hidden');
}

async function attemptUnlock() {
  const val = $('#lockInput').value;
  const decrypted = await tryDecrypt(val);
  if (!decrypted) {
    $('#lockError').classList.remove('hidden');
    return;
  }
  state = decrypted;
  $('#lockScreen').classList.add('hidden');
  startApp();
}

function startApp() {
  $('#app').classList.remove('hidden');
  renderAll();
}

function wireEvents() {
  $('#obContinue').addEventListener('click', completeOnboarding);

  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#quickLogBtn').addEventListener('click', () => openLogModal(toISO(new Date())));
  $('#logModalClose').addEventListener('click', closeLogModal);
  $('#logSave').addEventListener('click', saveLog);

  $('#flowChips').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    logSelection.flow = c.dataset.flow;
    $$('#flowChips .chip').forEach(x => x.classList.toggle('selected', x===c));
  });
  $('#moodChips').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    logSelection.mood = logSelection.mood === c.dataset.mood ? null : c.dataset.mood;
    $$('#moodChips .chip').forEach(x => x.classList.toggle('selected', x.dataset.mood===logSelection.mood));
  });
  $('#symptomChips').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    const s = c.dataset.symptom;
    logSelection.symptoms.has(s) ? logSelection.symptoms.delete(s) : logSelection.symptoms.add(s);
    c.classList.toggle('selected');
  });

  $('#prevMonth').addEventListener('click', () => { calendarCursor.setMonth(calendarCursor.getMonth()-1); renderCalendar(); });
  $('#nextMonth').addEventListener('click', () => { calendarCursor.setMonth(calendarCursor.getMonth()+1); renderCalendar(); });

  $('#rangeModeToggle').addEventListener('click', toggleRangeSelectMode);
  const grid = $('#calendarGrid');
  grid.addEventListener('pointerdown', onGridPointerDown);
  grid.addEventListener('pointermove', onGridPointerMove);
  window.addEventListener('pointerup', onGridPointerUp);

  $('#passcodeBtn').addEventListener('click', openPinModal);
  $('#pinModalClose').addEventListener('click', closePinModal);
  $('#pinSave').addEventListener('click', savePin);
  $('#pinRemove').addEventListener('click', removePin);

  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importData(e.target.files[0]); });

  $('#setCycleLen').addEventListener('change', async e => { state.settings.avgCycleLength = parseInt(e.target.value,10)||28; await saveState(); renderAll(); });
  $('#setPeriodLen').addEventListener('change', async e => { state.settings.avgPeriodLength = parseInt(e.target.value,10)||5; await saveState(); renderAll(); });
  $('#trackMoodToggle').addEventListener('change', async e => { state.settings.trackMood = e.target.checked; await saveState(); });

  $('#deleteAllBtn').addEventListener('click', async () => {
    if (!confirm('Delete everything from this device? This cannot be undone.')) return;
    localStorage.removeItem(STORAGE_PLAIN);
    localStorage.removeItem(STORAGE_ENC);
    location.reload();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  boot();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
