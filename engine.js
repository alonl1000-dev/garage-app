// Recommendation engine: pure functions, no DOM, so they run in the app and in Node tests.

export const HOUR_PRICE = 160; // ₪ per labor hour, from the receipts

/** "120+135" -> [120, 135]; "כללי" -> [] */
export function serviceNumbers(service) {
  return String(service)
    .split('+')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

export function kitsForModel(kits, make, model) {
  return kits.filter((k) => k.make === String(make) && k.model === String(model));
}

/**
 * Pick the kit for a car by mileage (services are in thousands of km).
 * Returns { best, alternatives, general, reason }.
 * Rule: the closest service to the odometer; on a tie the higher one.
 * A combined kit ("120+135") counts at each of its numbers.
 */
export function recommendKit(kits, make, model, km) {
  const own = kitsForModel(kits, make, model);
  const general = own.find((k) => serviceNumbers(k.service).length === 0) || null;
  const numbered = own.filter((k) => serviceNumbers(k.service).length > 0);
  if (!numbered.length) {
    return { best: general, alternatives: [], general, reason: general ? 'general' : 'no-kits' };
  }
  if (km == null || !Number.isFinite(km) || km <= 0) {
    const sorted = [...numbered].sort((a, b) => serviceNumbers(a.service)[0] - serviceNumbers(b.service)[0]);
    return { best: null, alternatives: sorted.slice(0, 3), general, reason: 'no-km' };
  }
  const t = km / 1000;
  const dist = (k) => Math.min(...serviceNumbers(k.service).map((n) => Math.abs(n - t)));
  const top = (k) => Math.max(...serviceNumbers(k.service));
  const ranked = [...numbered].sort((a, b) => dist(a) - dist(b) || top(b) - top(a));
  const best = ranked[0];
  const bestNums = serviceNumbers(best.service);
  // Far past the last kit (e.g. 210k km on a car whose kits end at 120): still offer it, but say so.
  const reason = Math.min(...bestNums.map((n) => Math.abs(n - t))) > 10 ? 'far' : 'km';
  const alternatives = ranked
    .slice(1)
    .sort((a, b) => serviceNumbers(a.service)[0] - serviceNumbers(b.service)[0])
    .filter((k) => Math.abs(serviceNumbers(k.service)[0] - bestNums[0]) <= 30)
    .slice(0, 2);
  return { best, alternatives, general, reason };
}

export function linePrice(line) {
  if (line.type === 'job') return line.price ?? Math.round(line.qty * HOUR_PRICE);
  return line.price == null ? null : Math.round(line.price * line.qty);
}

/** Price estimate for a list of lines; unknown prices are counted, not guessed. */
export function estimate(lines) {
  let total = 0, hours = 0, unpriced = 0;
  for (const l of lines) {
    if (l.type === 'job') hours += l.hours ?? l.qty ?? 0;
    const p = linePrice(l);
    if (p == null) unpriced++;
    else total += p;
  }
  return { total: Math.round(total), hours: Math.round(hours * 10) / 10, unpriced };
}

/** Common extra jobs for this model from past cards, leaving out the plain service entries. */
export function suggestAddOns(modelInfo, limit = 4) {
  if (!modelInfo?.topJobs) return [];
  const seen = new Set();
  const out = [];
  for (const j of modelInfo.topJobs) {
    // "טיפול 60+בד בלמים" -> the part after the service, "בד בלמים"
    const parts = j.text.split('+').map((s) => s.trim()).filter((s) => !/^טיפול(\s+\d+)?$/.test(s));
    for (const p of parts) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

const STOP = new Set(['של', 'את', 'עם', 'יש', 'לא', 'גם', 'על', 'כל', 'רק', 'זה', 'הוא', 'היא', 'מה', 'אחרי', 'בזמן']);
const PREFIX = /^[והבלמש]/;

function tokens(text) {
  return String(text)
    .replace(/["'״׳.,!?()\-/+]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// spoken words -> the words used in job names
const SYN = { 'מלפנים': 'קדמי', 'מקדימה': 'קדמי', 'קדימה': 'קדמי', 'מאחור': 'אחורי', 'אחורה': 'אחורי',
  'בלימה': 'בלמים', 'ברקס': 'בלמים', 'ברקסים': 'בלמים', 'מהבלמים': 'בלמים', 'רעשים': 'רעש', 'נורה': 'נורת', 'מיזוג': 'מזגן' };

function stem(w) {
  w = SYN[w] ?? w;
  // strip one Hebrew prefix letter (ו, ה, ב, ל, מ, ש) when the rest is still a word
  return w.length > 3 && PREFIX.test(w) ? w.slice(1) : w;
}

/**
 * Offline fallback for matching a complaint to jobs (the Claude API does this better when online).
 * Scores jobs by shared word stems, weighted toward jobs done often.
 */
export function matchComplaint(jobs, complaint, limit = 3) {
  const q = new Set(tokens(complaint).map(stem));
  if (!q.size) return [];
  const scored = [];
  for (const j of jobs) {
    const words = new Set(tokens(`${j.desc} ${j.category}`).map(stem));
    let hit = 0;
    for (const w of q) {
      for (const v of words) {
        if (v === w || (w.length >= 3 && (v.startsWith(w) || w.startsWith(v)) && Math.min(v.length, w.length) >= 3)) {
          hit++;
          break;
        }
      }
    }
    if (hit) scored.push({ job: j, score: hit + Math.log10(1 + j.count) / 10 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.job);
}

/** Israeli plates: 7 or 8 digits. Returns digits only, or null. */
export function normalizePlate(text) {
  const d = String(text ?? '').replace(/\D/g, '');
  return d.length === 7 || d.length === 8 ? d : null;
}

export function formatPlate(d) {
  if (d.length === 7) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  if (d.length === 8) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  return d;
}

/** Search models by free text (description, make name, or code). */
export function searchModels(models, query, limit = 12) {
  const q = String(query).trim().toLowerCase();
  if (!q) return models.slice(0, limit);
  const parts = q.split(/\s+/);
  return models
    .filter((m) => {
      const hay = `${m.desc} ${m.makeName} ${m.make}-${m.model}`.toLowerCase();
      return parts.every((p) => hay.includes(p));
    })
    .slice(0, limit);
}
