import * as E from './engine.js';
import { lookupPlate, recognize } from './services.js';
import * as cloud from './cloud.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `₪${Math.round(n).toLocaleString('he-IL')}`;

// ---------- local storage (drafts always; intakes too in local mode)
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let DATA = { kits: [], models: [], jobs: [] };
const STEPS = ['plate', 'vehicle', 'km', 'service', 'complaint', 'summary'];
let draft = null;

let CLOUD = false;
let profile = null;
async function loadData() {
  const get = (f) => (CLOUD ? cloud.loadCatalogFile(f) : fetch(`data/${f}`).then((r) => r.json()));
  const [kits, models, jobs] = await Promise.all([get('kits.json'), get('models.json'), get('jobs.json')]);
  DATA = { kits, models, jobs };
}

function newDraft() {
  return {
    id: crypto.randomUUID?.() ?? String(Date.now()),
    createdAt: new Date().toISOString(),
    plate: '', platePhoto: null, gov: null, model: null,
    km: '', kmPhoto: null,
    kitCode: null, addOns: [], extraJobs: [], repairOnly: false,
    complaint: '', status: 'draft',
  };
}

// ---------- shell
function setHeader(title, showBack) {
  $('#title').textContent = title;
  $('#back').hidden = !showBack;
}
function setSteps(i) {
  const el = $('#steps');
  if (i == null) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = STEPS.map((_, j) => `<span class="${j <= i ? 'done' : ''}"></span>`).join('');
}
function setBar(html) { $('#bar').innerHTML = html; }
function view(html) { $('#view').innerHTML = html; window.scrollTo(0, 0); }

let stepIndex = null;
function go(step) {
  stepIndex = step == null ? null : STEPS.indexOf(step);
  setSteps(stepIndex);
  if (step !== null && unsubscribe) { unsubscribe(); unsubscribe = null; }
  ({ home, plate, vehicle, km, service, complaint, summary }[step ?? 'home'])();
}
$('#back').addEventListener('click', () => {
  if (stepIndex == null) return;
  if (stepIndex === 0) { if (confirmLeave()) go(null); } else go(STEPS[stepIndex - 1]);
});
function confirmLeave() { return true; } // drafts are kept, nothing is lost by leaving

// ---------- home
let unsubscribe = null;
const STATUS = {
  saving: ['wait', 'שומר בענן...'],
  queued: ['wait', 'ממתין למחשב'],
  processing: ['wait', 'נפתח בנשר...'],
  manual: ['wait', 'להקלדה ידנית בנשר'],
  failed: ['fail', 'נכשל'],
};
async function todayList() {
  const today = new Date().toDateString();
  if (!CLOUD) return store.get('intakes', []).filter((x) => new Date(x.createdAt).toDateString() === today).reverse();
  const pending = cloud.pendingIntakes().map((x) => ({ ...x, status: 'saving' }));
  let rows = [];
  try { rows = await cloud.todayIntakes(); } catch { /* offline: show what is waiting on the phone */ }
  return [...pending.filter((p) => !rows.some((r) => r.id === p.id)).reverse(), ...rows];
}
async function home() {
  setHeader('קבלת רכבים', false);
  $('#pc-status').hidden = false;
  const saved = store.get('draft', null);
  const render = async () => {
    const list = await todayList();
    if (stepIndex != null) return; // the user already moved on
    view(`
      <button class="big-btn" id="start">＋ קבלת רכב</button>
      ${saved ? `<button class="btn ghost" id="resume" style="width:100%;margin-top:10px">המשך קבלה שלא הסתיימה${saved.plate ? ` · ${esc(E.formatPlate(saved.plate))}` : ''}</button>` : ''}
      <h2 style="margin-top:22px">היום במוסך</h2>
      ${list.length ? list.map(card).join('') : '<div class="empty">עוד לא נקלטו רכבים היום</div>'}
      ${CLOUD ? `<p class="meta" style="text-align:center;margin-top:24px">${esc(profile?.full_name ?? '')} · <button class="linkish" id="logout">יציאה</button></p>` : ''}
    `);
    $('#start').onclick = () => { draft = newDraft(); store.set('draft', draft); go('plate'); };
    if ($('#resume')) $('#resume').onclick = () => { draft = saved; go(saved.model ? 'service' : 'plate'); };
    if ($('#logout')) $('#logout').onclick = async () => { await cloud.signOut(); location.reload(); };
    document.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await cloud.retry(b.dataset.retry); } catch (e) { b.textContent = 'רק מנהל יכול לנסות שוב'; return; }
      render();
    }));
  };
  setBar('');
  await render();
  if (CLOUD) {
    cloud.flushOutbox().then(() => stepIndex == null && render());
    refreshPcStatus();
    if (!unsubscribe) unsubscribe = cloud.subscribe(() => { if (stepIndex == null) { render(); refreshPcStatus(); } });
  }
}
function card(x) {
  const st = x.status === 'opened' ? ['done', `נפתח · כרטיס ${esc(x.nesherCard)}`] : STATUS[x.status] ?? ['wait', esc(x.status)];
  const kit = x.kitName ? `<bdi>${esc(x.kitName)}</bdi>` : x.repairOnly ? 'תיקון' : '';
  const canRetry = CLOUD && (x.status === 'failed' || x.status === 'manual') && profile?.role === 'manager';
  return `<div class="card"><div class="row spaced">
    <span class="plate">${esc(E.formatPlate(x.plate))}</span><span class="status ${st[0]}">${st[1]}</span></div>
    <div style="margin-top:8px"><b>${esc(x.modelDesc ?? '')}</b></div>
    <div class="meta">${kit}${x.km ? ` · <bdi>${Number(x.km).toLocaleString('he-IL')} ק"מ</bdi>` : ''} · ${new Date(x.createdAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</div>
    ${x.status === 'failed' && x.error ? `<div class="note">${esc(x.error)}</div>` : ''}
    ${canRetry ? `<button class="btn ghost" data-retry="${esc(x.id)}" style="margin-top:8px">נסה שוב לפתוח בנשר</button>` : ''}</div>`;
}
async function refreshPcStatus() {
  const pill = $('#pc-status');
  const st = await cloud.agentStatus();
  const map = {
    ok: ['ok', 'מחשב: מחובר'],
    warn: ['off', `מחשב: ${st.text ?? ''}`],
    off: ['off', 'מחשב: לא מחובר'],
    none: ['off', 'מחשב: עוד לא הותקן'],
    unknown: ['', 'מחשב: לא ידוע'],
  }[st.state];
  pill.className = `pill ${map[0]}`;
  pill.textContent = map[1];
}

// ---------- login (cloud mode)
function login(msg) {
  setHeader('כניסה', false);
  $('#pc-status').hidden = true;
  setSteps(null);
  view(`
    <h2>כניסה למערכת</h2><p class="sub">כל עובד נכנס עם המשתמש שלו.</p>
    <form id="lf">
      <label class="field"><span>אימייל</span><input class="input text ltr" id="em" type="email" autocomplete="username" required></label>
      <label class="field"><span>סיסמה</span><input class="input text ltr" id="pw" type="password" autocomplete="current-password" required></label>
      <div class="note" id="lerr" ${msg ? '' : 'hidden'}>${esc(msg ?? '')}</div>
    </form>`);
  setBar(`<button class="btn primary" id="lgo" type="submit" form="lf">כניסה</button>`);
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    $('#lgo').disabled = true;
    try { await cloud.signIn($('#em').value.trim(), $('#pw').value); start(); }
    catch { $('#lerr').hidden = false; $('#lerr').textContent = 'האימייל או הסיסמה לא נכונים.'; $('#lgo').disabled = false; }
  };
}

// ---------- photo helper
function photoBox(id, label, src) {
  return `<label class="photo" for="${id}">${src ? `<img src="${src}" alt="">` : `<span class="cam">📷</span><span>${label}</span>`}
    <input type="file" id="${id}" accept="image/*" capture="environment"></label>`;
}
function readPhoto(input) {
  return new Promise((res) => {
    const f = input.files?.[0];
    if (!f) return res(null);
    const img = new Image();
    img.onload = () => {
      // shrink to ~1280px so it stores and uploads fast
      const s = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.8));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  });
}
function save() { store.set('draft', draft); }
function bindPhoto(id, key, kind, note, apply) {
  const input = document.getElementById(id);
  input.onchange = async () => {
    draft[key] = await readPhoto(input); save();
    if (!draft[key]) return;
    const label = input.closest('.photo');
    label.querySelectorAll(':scope > :not(input)').forEach((n) => n.remove());
    const img = new Image(); img.src = draft[key]; img.alt = ''; label.prepend(img);
    note.hidden = false; note.textContent = 'מזהה מהתמונה...';
    const ok = apply(await recognize(draft[key], kind));
    note.textContent = ok ? 'זוהה מהתמונה. בדוק שהמספר נכון.' : 'זיהוי אוטומטי עוד לא מחובר. הקלד את המספר.';
  };
}

// ---------- step 1: plate
function plate() {
  setHeader('לוחית רישוי', true);
  view(`
    <h2>צלם את הלוחית</h2><p class="sub">המספר יזוהה מהתמונה. אפשר גם להקליד.</p>
    ${photoBox('pp', 'צילום לוחית', draft.platePhoto)}
    <label class="field"><span>מספר רישוי</span>
      <input class="input ltr" id="plateIn" inputmode="numeric" autocomplete="off" placeholder="12-345-67" value="${esc(draft.plate ? E.formatPlate(draft.plate) : '')}"></label>
    <div class="note" id="plateNote" hidden></div>
  `);
  setBar(`<button class="btn primary" id="next" disabled>המשך</button>`);
  const inp = $('#plateIn'), next = $('#next');
  const check = () => { next.disabled = !E.normalizePlate(inp.value); };
  inp.oninput = check; check();
  bindPhoto('pp', 'platePhoto', 'plate', $('#plateNote'), (r) => {
    if (!r?.plate) return false;
    inp.value = E.formatPlate(r.plate); check(); return true;
  });
  next.onclick = () => { draft.plate = E.normalizePlate(inp.value); save(); go('vehicle'); };
}

// ---------- step 2: vehicle
async function vehicle() {
  setHeader('הרכב', true);
  const known = CLOUD ? await cloud.getVehicle(draft.plate) : store.get('vehicles', {})[draft.plate];
  view(`<h2><span class="plate">${esc(E.formatPlate(draft.plate))}</span></h2><p class="sub">מחפש את הרכב...</p>`);
  setBar('');
  let match = known ? DATA.models.find((m) => m.make === known.make && m.model === known.model) : null;
  let gov = null;
  if (!match) {
    gov = await lookupPlate(draft.plate);
    draft.gov = gov; save();
    if (gov) {
      // Nesher's numeric make/model codes appear to be the Ministry of Transport codes; verify in phase 0.
      match = DATA.models.find((m) => m.make === String(gov.makeCode) && m.model === String(gov.modelCode));
    }
  }
  const candidates = match ? [match] : gov ? E.searchModels(DATA.models, gov.tradeName ?? '', 6) : [];
  const history = CLOUD ? await cloud.plateHistory(draft.plate) : store.get('intakes', []).filter((x) => x.plate === draft.plate).slice(-3).reverse();
  view(`
    <h2><span class="plate">${esc(E.formatPlate(draft.plate))}</span></h2>
    ${gov ? `<p class="sub">${esc([gov.makeName, gov.tradeName, gov.year, gov.fuel].filter(Boolean).join(' · '))}</p>` : known ? '<p class="sub">רכב מוכר מביקור קודם</p>' : '<p class="sub">לא נמצא במאגר. בחר דגם מהרשימה.</p>'}
    ${history.length ? `<div class="note">ביקורים קודמים: ${history.map((h) => `${new Date(h.createdAt).toLocaleDateString('he-IL')} ${esc(h.kitName ?? 'תיקון')}${h.km ? ` (${Number(h.km).toLocaleString('he-IL')} ק"מ)` : ''}`).join(' · ')}</div>` : ''}
    <div class="list" id="cands">${candidates.map(modelOpt).join('')}</div>
    <label class="field"><span>${candidates.length ? 'לא זה? חפש דגם' : 'חפש דגם'}</span>
      <input class="input text" id="q" placeholder="למשל: אלנטרה, NIRO, 481-429" autocomplete="off"></label>
    <div class="list" id="results"></div>
  `);
  const bind = (root) => root.querySelectorAll('.opt').forEach((b) => (b.onclick = () => pickModel(b.dataset.k)));
  bind($('#cands'));
  $('#q').oninput = (e) => { $('#results').innerHTML = E.searchModels(DATA.models, e.target.value, 10).map(modelOpt).join(''); bind($('#results')); };
}
function modelOpt(m) {
  const kits = E.kitsForModel(DATA.kits, m.make, m.model).length;
  return `<button class="opt" data-k="${esc(m.make)}|${esc(m.model)}"><b>${esc(m.desc)}</b>
    <small>${esc(m.makeName)} · קוד ${esc(m.make)}-${esc(m.model)} · ${kits ? `${kits} קיטים` : 'אין קיטים'}${m.entries ? ` · ${m.entries} כניסות השנה` : ''}</small></button>`;
}
function pickModel(k) {
  const [make, model] = k.split('|');
  const m = DATA.models.find((x) => x.make === make && x.model === model);
  draft.model = { make, model, desc: m?.desc ?? '' };
  if (CLOUD) cloud.rememberVehicle(draft.plate, { make, model, desc: m?.desc ?? '' }, draft.gov);
  else { const v = store.get('vehicles', {}); v[draft.plate] = { make, model }; store.set('vehicles', v); }
  save(); go('km');
}

// ---------- step 3: km
function km() {
  setHeader('קילומטראז\'', true);
  view(`
    <h2>צלם את לוח השעונים</h2><p class="sub">${esc(draft.model.desc)}</p>
    ${photoBox('kp', 'צילום שעונים', draft.kmPhoto)}
    <label class="field"><span>קילומטראז'</span>
      <input class="input ltr" id="kmIn" inputmode="numeric" placeholder="0" value="${esc(draft.km)}"></label>
    <div class="note" id="kmNote" hidden></div>
  `);
  setBar(`<button class="btn ghost" id="skip">דלג</button><button class="btn primary" id="next">המשך</button>`);
  const inp = $('#kmIn');
  inp.oninput = () => { inp.value = inp.value.replace(/\D/g, ''); };
  bindPhoto('kp', 'kmPhoto', 'odometer', $('#kmNote'), (r) => {
    if (!r?.km) return false;
    inp.value = r.km; return true;
  });
  $('#skip').onclick = () => { draft.km = ''; save(); go('service'); };
  $('#next').onclick = () => { draft.km = inp.value; save(); go('service'); };
}

// ---------- step 4: service
function service() {
  setHeader('מה עושים', true);
  const { make, model } = draft.model;
  const kmN = draft.km ? Number(draft.km) : null;
  const rec = E.recommendKit(DATA.kits, make, model, kmN);
  if (!draft.kitCode && rec.best && !draft.repairOnly) { draft.kitCode = rec.best.code; save(); }
  const own = E.kitsForModel(DATA.kits, make, model);
  const sel = DATA.kits.find((k) => k.code === draft.kitCode);
  const minfo = DATA.models.find((m) => m.make === make && m.model === model);
  const addOns = E.suggestAddOns(minfo);
  const why = { km: `לפי ${Number(kmN).toLocaleString('he-IL')} ק"מ`, far: 'הקיט הקרוב ביותר שיש, רחוק מהקילומטראז\'', general: 'קיט כללי לדגם', 'no-km': 'בלי קילומטראז\', בחר טיפול', 'no-kits': 'אין קיטים לדגם הזה' }[rec.reason];
  view(`
    <h2>${esc(draft.model.desc)}</h2><p class="sub">${esc(why)}</p>
    ${sel ? kitCard(sel, true) : ''}
    ${own.length ? `<div class="field"><span>טיפול אחר</span><div class="chips">${own
      .map((k) => `<button class="chip ${k.code === draft.kitCode ? 'on' : ''}" data-kit="${esc(k.code)}">${esc(k.service === 'כללי' ? 'כללי' : `טיפול ${k.service}`)}</button>`).join('')}</div></div>` : ''}
    ${addOns.length ? `<div class="field"><span>נפוץ בדגם הזה</span><div class="chips">${addOns
      .map((a) => `<button class="chip ${draft.addOns.includes(a) ? 'on' : ''}" data-add="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>` : ''}
    <button class="chip ${draft.repairOnly ? 'on' : ''}" id="repair" style="width:100%">תקלה / תיקון בלי טיפול</button>
  `);
  document.querySelectorAll('[data-kit]').forEach((b) => (b.onclick = () => { draft.kitCode = draft.kitCode === b.dataset.kit ? null : b.dataset.kit; draft.repairOnly = false; save(); service(); }));
  document.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => {
    const a = b.dataset.add; draft.addOns = draft.addOns.includes(a) ? draft.addOns.filter((x) => x !== a) : [...draft.addOns, a]; save(); service();
  }));
  $('#repair').onclick = () => { draft.repairOnly = !draft.repairOnly; if (draft.repairOnly) draft.kitCode = null; save(); service(); };
  setBar(`<button class="btn primary" id="next" ${draft.kitCode || draft.repairOnly || draft.addOns.length ? '' : 'disabled'}>המשך</button>`);
  $('#next').onclick = () => go('complaint');
}
function kitCard(k, picked) {
  const est = E.estimate(k.lines);
  return `<div class="card ${picked ? 'pick' : ''}"><div class="row spaced"><h3>${esc(k.name)}</h3><b>${money(est.total)}</b></div>
    <div class="meta">${k.lines.filter((l) => l.type === 'part').map((l) => esc(l.desc)).join(' · ')}</div>
    <div class="meta">${est.hours} שעות עבודה${est.unpriced ? ` · ${est.unpriced} פריטים בלי מחיר` : ''}</div></div>`;
}

// ---------- step 5: complaint
function complaint() {
  setHeader('תלונת לקוח', true);
  view(`
    <h2>מה הלקוח מספר?</h2><p class="sub">אפשר להקליט. ייכנס לשדה תלונת לקוח בנשר.</p>
    <div class="row"><textarea class="input grow" id="txt" placeholder="למשל: רעש מלפנים בבלימה">${esc(draft.complaint)}</textarea></div>
    <div class="row" style="margin-top:10px"><button class="btn ghost mic" id="mic" aria-label="הקלטה">🎤</button><span class="meta" id="micNote">לחץ ודבר</span></div>
    <div class="field"><span>עבודות מתאימות</span><div class="chips" id="sugg"></div></div>
  `);
  const txt = $('#txt');
  const renderSugg = () => {
    const found = E.matchComplaint(DATA.jobs, txt.value, 4);
    const chosen = draft.extraJobs;
    const all = [...chosen, ...found.filter((j) => !chosen.some((c) => c.desc === j.desc))];
    $('#sugg').innerHTML = all.length
      ? all.map((j) => `<button class="chip ${chosen.some((c) => c.desc === j.desc) ? 'on' : ''}" data-job="${esc(j.desc)}">${esc(j.desc)}${j.hours ? ` · ${j.hours} ש'` : ''}</button>`).join('')
      : '<span class="meta">יופיעו כאן לפי מה שנכתב</span>';
    $('#sugg').querySelectorAll('[data-job]').forEach((b) => (b.onclick = () => {
      const j = DATA.jobs.find((x) => x.desc === b.dataset.job) ?? chosen.find((x) => x.desc === b.dataset.job);
      draft.extraJobs = chosen.some((c) => c.desc === j.desc) ? chosen.filter((c) => c.desc !== j.desc) : [...chosen, j];
      save(); renderSugg();
    }));
  };
  txt.oninput = () => { draft.complaint = txt.value; save(); renderSugg(); };
  renderSugg();
  setupMic($('#mic'), $('#micNote'), (said) => { txt.value = (txt.value ? `${txt.value} ` : '') + said; txt.oninput(); });
  setBar(`<button class="btn primary" id="next">לסיכום</button>`);
  $('#next').onclick = () => go('summary');
}
function setupMic(btn, note, onText) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.disabled = true; note.textContent = 'הקלטה לא נתמכת בדפדפן הזה'; return; }
  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'he-IL'; rec.interimResults = false;
    rec.onresult = (e) => onText(Array.from(e.results).map((r) => r[0].transcript).join(' '));
    rec.onend = () => { rec = null; btn.classList.remove('rec'); note.textContent = 'לחץ ודבר'; };
    rec.onerror = () => { note.textContent = 'ההקלטה נכשלה, נסה שוב'; };
    btn.classList.add('rec'); note.textContent = 'מקשיב...'; rec.start();
  };
}

// ---------- step 6: summary
function draftLines() {
  const kit = DATA.kits.find((k) => k.code === draft.kitCode);
  const lines = kit ? kit.lines.map((l) => ({ ...l })) : [];
  for (const j of draft.extraJobs) lines.push({ type: 'job', sku: j.code || '', desc: j.desc, qty: j.hours ?? 1, hours: j.hours, price: j.price });
  for (const a of draft.addOns) lines.push({ type: 'note', desc: a, qty: 1, price: 0 });
  return { kit, lines };
}
function summary() {
  setHeader('סיכום', true);
  const { kit, lines } = draftLines();
  const est = E.estimate(lines.filter((l) => l.type !== 'note'));
  view(`
    <div class="row spaced"><span class="plate">${esc(E.formatPlate(draft.plate))}</span>
      <span class="meta">${draft.km ? `${Number(draft.km).toLocaleString('he-IL')} ק"מ` : 'בלי ק"מ'}</span></div>
    <h2 style="margin-top:10px">${esc(draft.model.desc)}</h2>
    <p class="sub"><bdi>${kit ? esc(kit.name) : 'תיקון'}</bdi>${draft.complaint ? ` · ${esc(draft.complaint)}` : ''}</p>
    <div class="card"><table class="lines">${lines.map((l) => {
      const p = l.type === 'note' ? null : E.linePrice(l);
      return `<tr><td>${esc(l.desc)}${l.type === 'note' ? ' <span class="meta">(לבדיקה)</span>' : ''}<div class="sku">${esc(l.sku)}${l.type !== 'note' ? ` · ${l.qty} ${esc(l.unit ?? (l.type === 'job' ? 'שעות' : ''))}` : ''}</div></td>
        <td class="num">${p == null ? (l.type === 'note' ? '' : '—') : money(p)}</td></tr>`;
    }).join('') || '<tr><td class="meta">אין שורות</td></tr>'}</table>
      <div class="total"><span>הערכה</span><span>${money(est.total)}</span></div>
      <div class="meta">${est.hours} שעות עבודה לפי 160 ₪ לשעה${est.unpriced ? ` · ${est.unpriced} פריטים בלי מחיר` : ''}</div></div>
    <div class="note">${CLOUD ? 'הכרטיס ייפתח בנשר דרך המחשב במוסך. אם אין קליטה, הקבלה נשמרת בטלפון ונשלחת כשהחיבור חוזר.' : 'גרסת ניסיון: הקבלה נשמרת רק בטלפון הזה.'}</div>
  `);
  setBar(`<button class="btn primary" id="send">פתח כרטיס בנשר</button>`);
  $('#send').onclick = () => {
    $('#send').disabled = true; // one tap, one card
    const intake = {
      id: draft.id, createdAt: draft.createdAt, plate: draft.plate, km: draft.km,
      make: draft.model.make, model: draft.model.model, modelDesc: draft.model.desc,
      kitCode: kit?.code ?? null, kitName: kit?.name ?? null, repairOnly: draft.repairOnly,
      complaint: draft.complaint, addOns: draft.addOns, lines, estimate: est, status: 'queued',
    };
    if (CLOUD) {
      cloud.queueIntake(intake, { plate: draft.platePhoto, odometer: draft.kmPhoto });
    } else {
      const all = store.get('intakes', []);
      if (!all.some((x) => x.id === intake.id)) { all.push(intake); store.set('intakes', all); }
    }
    store.set('draft', null); draft = null;
    go(null);
  };
}

// ---------- start
async function start() {
  try {
    CLOUD = await cloud.init();
    if (CLOUD && !(await cloud.session())) { await loadDataSafe(); return login(); }
    if (CLOUD) {
      profile = await cloud.myProfile();
      if (!profile) { await cloud.signOut(); return login('המשתמש עוד לא הוגדר במערכת. בקש ממנהל המוסך להגדיר אותו.'); }
    }
    await loadData();
    go(null);
  } catch {
    view('<div class="empty">לא הצלחתי לטעון את הנתונים. בדוק חיבור ונסה שוב.</div>');
  }
}
async function loadDataSafe() { try { await loadData(); } catch { /* loaded after login */ } }
start();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
