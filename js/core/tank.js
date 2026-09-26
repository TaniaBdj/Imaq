/**
 * Tank calculations — pure, shared by browser, API and tests.
 *
 * PHYSICAL PROTOTYPE CONCEPT: a top-mounted distance sensor measures the gap
 * between the top of the tank and the water surface.
 *
 *   waterHeight  = tankHeightCm − distanceCm
 *   levelPercent = waterHeight / tankHeightCm × 100      (clamped 0–100)
 *   litres       = tankCapacityLitres × levelPercent / 100
 *
 * ASSUMPTION: volume changes approximately linearly with height (e.g. an upright
 * rectangular or cylindrical tank). Real installations — horizontal cylinders,
 * tapered or irregular tanks — need a tank-specific calibration table. This
 * formula is NOT valid for every tank geometry.
 *
 * UNKNOWN is not EMPTY: any missing/invalid input returns null, never 0.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Maximum plausible sensor overshoot beyond the tank height (cm) before a reading is rejected. */
export const DISTANCE_TOLERANCE_CM = 10;

/** @returns {number|null} level 0–100, or null if unknown */
export function levelFromDistance(distanceCm, tankHeightCm) {
  if (!isNum(distanceCm) || !isNum(tankHeightCm) || tankHeightCm <= 0) return null;
  if (distanceCm < 0 || distanceCm > tankHeightCm + DISTANCE_TOLERANCE_CM) return null; // impossible reading
  const pct = ((tankHeightCm - distanceCm) / tankHeightCm) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Inverse, used by the synthetic sensor to emit realistic distances. */
export function distanceFromLevel(levelPercent, tankHeightCm) {
  if (!isNum(levelPercent) || !isNum(tankHeightCm) || tankHeightCm <= 0) return null;
  const pct = Math.max(0, Math.min(100, levelPercent));
  return Math.round(tankHeightCm * (1 - pct / 100) * 10) / 10;
}

/** @returns {number|null} estimated litres, or null if unknown */
export function litresFromLevel(levelPercent, tankCapacityLitres) {
  if (!isNum(levelPercent) || !isNum(tankCapacityLitres) || tankCapacityLitres <= 0) return null;
  return (tankCapacityLitres * Math.max(0, Math.min(100, levelPercent))) / 100;
}

/**
 * Estimate daily use from level history. Only DECLINING segments count —
 * a rise (delivery) is never treated as negative consumption.
 *
 * @param {Array<{ts:number, litres:number|null}>} series oldest→newest
 * @param {number|null} configuredDailyUseLitres fallback
 * @param {{minHours?: number, riseToleranceL?: number}} [opts]
 * @returns {{litresPerDay: number|null, source: 'measured'|'configured'|'unknown', hours?: number}}
 */
export function estimateConsumption(series, configuredDailyUseLitres, { minHours = 12, riseToleranceL = 5 } = {}) {
  const fallback = isNum(configuredDailyUseLitres) && configuredDailyUseLitres > 0
    ? { litresPerDay: Math.round(configuredDailyUseLitres), source: 'configured' }
    : { litresPerDay: null, source: 'unknown' };
  const pts = (series || []).filter((p) => isNum(p.ts) && isNum(p.litres)).sort((a, b) => a.ts - b.ts);
  let used = 0;
  let ms = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].ts - pts[i - 1].ts;
    const d = pts[i - 1].litres - pts[i].litres;
    if (dt <= 0 || dt > 6 * 3600_000) continue; // gap in data: don't guess
    if (d < -riseToleranceL) continue; // a fill (delivery): excluded
    used += Math.max(0, d);
    ms += dt;
  }
  const hours = ms / 3600_000;
  if (hours < minHours || used <= 0) return fallback;
  // Round to 10 L/day: the data does not support more precision.
  return { litresPerDay: Math.max(10, Math.round((used / hours) * 24 / 10) * 10), source: 'measured', hours: Math.round(hours) };
}

/** @returns {number|null} days, or null if unknown (missing level or invalid use) */
export function daysRemaining(litres, litresPerDay) {
  if (!isNum(litres) || litres < 0 || !isNum(litresPerDay) || litresPerDay <= 0) return null;
  return litres / litresPerDay;
}

/**
 * Human bucket for days remaining (the UI translates it).
 *   null → {kind:'unknown'} · <1 → {kind:'lessThanOne'} · else {kind:'about', n}
 */
export function daysBucket(days) {
  if (!isNum(days)) return { kind: 'unknown' };
  if (days < 1) return { kind: 'lessThanOne' };
  return { kind: 'about', n: Math.round(days) };
}
