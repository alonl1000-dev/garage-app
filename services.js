// Outside services. Each one fails soft: on any error it returns null and the app falls back to manual entry.

// Ministry of Transport open vehicle registry (private and commercial vehicles) on data.gov.il.
const GOV_URL = 'https://data.gov.il/api/3/action/datastore_search';
const GOV_RESOURCE = '053cea08-09bc-40ec-8f7a-156f0677aff3';

import * as cloud from './cloud.js';

async function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

/** Plate -> { makeCode, makeName, modelCode, modelName, tradeName, year, fuel, trim } or null. */
export async function lookupPlate(plate) {
  // through the cloud when connected (data.gov.il does not allow calls from other sites)
  if (cloud.isCloud()) { try { return await cloud.plateLookupCloud(plate); } catch { return null; } }
  try {
    const url = `${GOV_URL}?resource_id=${GOV_RESOURCE}&filters=${encodeURIComponent(JSON.stringify({ mispar_rechev: Number(plate) }))}&limit=1`;
    const res = await withTimeout(fetch(url), 6000);
    if (!res.ok) return null;
    const rec = (await res.json())?.result?.records?.[0];
    if (!rec) return null;
    return {
      makeCode: rec.tozeret_cd, makeName: rec.tozeret_nm,
      modelCode: rec.degem_cd, modelName: rec.degem_nm,
      tradeName: rec.kinuy_mishari, year: rec.shnat_yitzur,
      fuel: rec.sug_delek_nm, trim: rec.ramat_gimur,
    };
  } catch {
    return null;
  }
}

/**
 * Read a photo: kind = 'plate' -> { plate }, 'odometer' -> { km }.
 * Runs on the cloud backend with Claude's vision model (the API key stays on the server).
 */
export async function recognize(dataUrl, kind) {
  if (!cloud.isCloud() || !dataUrl) return null;
  try {
    return await withTimeout(cloud.recognizeCloud(kind, dataUrl), 20000);
  } catch {
    return null;
  }
}
