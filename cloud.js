// Cloud layer (Supabase). Without window.GARAGE_CONFIG the app stays in local mode and none of this runs.
// Contract: ../CONTRACT.md

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
const OUTBOX = 'outbox';
const VEH_CACHE = 'vehicles';

let sb = null;

const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

export const isCloud = () => Boolean(window.GARAGE_CONFIG?.supabaseUrl && window.GARAGE_CONFIG?.supabaseAnonKey);

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('script'));
    document.head.appendChild(s);
  });
}

export async function init() {
  if (!isCloud()) return false;
  if (!window.supabase) await loadScript(SUPABASE_JS);
  const { supabaseUrl, supabaseAnonKey } = window.GARAGE_CONFIG;
  sb = window.supabase.createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  window.addEventListener('online', () => flushOutbox());
  return true;
}

// ---------- auth
export async function session() {
  const { data } = await sb.auth.getSession();
  return data.session;
}
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}
export async function signInWithGoogle() {
  const redirectTo = location.origin + location.pathname;
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) throw new Error(error.message);
}
export async function signOut() { await sb.auth.signOut(); }
export async function myProfile() {
  const s = await session();
  if (!s) return null;
  const { data } = await sb.from('profiles').select('full_name, role').eq('id', s.user.id).maybeSingle();
  return data;
}

// ---------- catalog: from the cloud bucket when available (kept fresh by the nightly sync), else the bundled copy
export async function loadCatalogFile(name) {
  if (sb) {
    try {
      const { data, error } = await sb.storage.from('catalog').download(name);
      if (!error && data) return JSON.parse(await data.text());
    } catch { /* fall back */ }
  }
  return fetch(`data/${name}`).then((r) => r.json());
}

// ---------- vehicles
export async function getVehicle(plate) {
  const cached = local.get(VEH_CACHE, {})[plate];
  if (!sb) return cached ?? null;
  try {
    const { data } = await sb.from('vehicles').select('*').eq('plate', plate).maybeSingle();
    if (data) return { make: data.make_code, model: data.model_code, desc: data.model_desc };
  } catch { /* offline */ }
  return cached ?? null;
}
export async function rememberVehicle(plate, v, gov) {
  const all = local.get(VEH_CACHE, {}); all[plate] = v; local.set(VEH_CACHE, all);
  if (!sb) return;
  try {
    await sb.from('vehicles').upsert({ plate, make_code: v.make, model_code: v.model, model_desc: v.desc, gov: gov ?? null, updated_at: new Date().toISOString() });
  } catch { /* offline: the intake carries the same data */ }
}

// ---------- intakes: written to a local outbox first, then sent; nothing is lost without signal
export function queueIntake(intake, photos) {
  const box = local.get(OUTBOX, []);
  if (!box.some((x) => x.intake.id === intake.id)) box.push({ intake, photos });
  local.set(OUTBOX, box);
  return flushOutbox();
}
export const pendingIntakes = () => local.get(OUTBOX, []).map((x) => x.intake);

let flushing = null;
export function flushOutbox() {
  if (!sb || flushing) return flushing ?? Promise.resolve();
  flushing = (async () => {
    let box = local.get(OUTBOX, []);
    for (const item of [...box]) {
      try {
        const paths = [];
        for (const [kind, dataUrl] of Object.entries(item.photos ?? {})) {
          if (!dataUrl) continue;
          const path = `${item.intake.id}/${kind}.jpg`;
          const blob = await (await fetch(dataUrl)).blob();
          const { error } = await sb.storage.from('intake-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
          if (error) throw error;
          paths.push(path);
        }
        const row = toRow(item.intake, paths);
        // the id is the idempotency key: sending twice never makes a second card
        const { error } = await sb.from('intakes').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
        if (error) throw error;
        box = box.filter((x) => x.intake.id !== item.intake.id);
        local.set(OUTBOX, box);
      } catch {
        break; // still offline or not signed in; try again later
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
function toRow(x, photos) {
  return {
    id: x.id, created_at: x.createdAt, plate: x.plate, km: x.km ? Number(x.km) : null,
    make_code: x.make, model_code: x.model, model_desc: x.modelDesc,
    kit_code: x.kitCode, kit_name: x.kitName, repair_only: x.repairOnly,
    complaint: x.complaint || null, add_ons: x.addOns ?? [], lines: x.lines, estimate: x.estimate,
    photos, status: 'queued',
  };
}
function fromRow(r) {
  return {
    id: r.id, createdAt: r.created_at, plate: r.plate, km: r.km, make: r.make_code, model: r.model_code,
    modelDesc: r.model_desc, kitCode: r.kit_code, kitName: r.kit_name, repairOnly: r.repair_only,
    complaint: r.complaint, status: r.status, nesherCard: r.nesher_card, error: r.error,
  };
}

export async function todayIntakes() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const { data, error } = await sb.from('intakes').select('*').gte('created_at', start.toISOString()).order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}
export async function plateHistory(plate) {
  try {
    const { data } = await sb.from('intakes').select('*').eq('plate', plate).order('created_at', { ascending: false }).limit(3);
    return (data ?? []).map(fromRow);
  } catch { return []; }
}
export async function retry(intakeId) {
  const { error } = await sb.rpc('retry_task', { p_intake_id: intakeId });
  if (error) throw new Error(error.message);
}

// ---------- the garage PC's agent
export async function agentStatus() {
  try {
    const { data } = await sb.from('agent_heartbeat').select('*').order('last_seen', { ascending: false }).limit(1);
    const h = data?.[0];
    if (!h) return { state: 'none' };
    const fresh = Date.now() - new Date(h.last_seen).getTime() < 3 * 60 * 1000;
    if (!fresh) return { state: 'off', lastSeen: h.last_seen };
    if (!h.z_drive_ok) return { state: 'warn', text: 'כונן Z: לא מחובר' };
    if (!h.nesher_ok) return { state: 'warn', text: 'נשר סגור' };
    return { state: 'ok' };
  } catch { return { state: 'unknown' }; }
}

export function subscribe(onChange) {
  const ch = sb.channel('garage')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'intakes' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_heartbeat' }, onChange)
    .subscribe();
  return () => sb.removeChannel(ch);
}

// ---------- edge functions
export async function recognizeCloud(kind, image) {
  const { data, error } = await sb.functions.invoke('recognize', { body: { kind, image } });
  return error ? null : data;
}
export async function plateLookupCloud(plate) {
  const { data, error } = await sb.functions.invoke(`plate-lookup?plate=${encodeURIComponent(plate)}`, { method: 'GET' });
  return error || !data?.makeCode ? null : data;
}
