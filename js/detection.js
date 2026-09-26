/**
 * Imaq detection engine — pure, deterministic, no I/O.
 *
 * SCIENTIFIC SCOPE (read before changing anything here):
 *  - Turbidity, conductivity, temperature and tank level are INDICATORS.
 *    None of them detects bacteria, E. coli or any pathogen.
 *  - This engine only answers: "did measurable water conditions change
 *    compared with this household's normal (baseline) conditions?"
 *  - NORMAL means "no unusual change detected". It does NOT mean the water
 *    has been tested or certified.
 *  - Unknown is never normal: any missing, invalid or stale reading yields
 *    SYSTEM_CHECK (or ACTION if an official advisory is in effect).
 *
 * All thresholds below are PROTOTYPE THRESHOLDS chosen for a hackathon demo.
 * They are NOT validated public-health limits and require field validation
 * against laboratory measurements before any real deployment.
 */

export const STATUS = Object.freeze({
  NORMAL: 'NORMAL',
  CHECK: 'CHECK',
  ACTION: 'ACTION',
  SYSTEM_CHECK: 'SYSTEM_CHECK',
});

/** Parameter states, per sensor. */
export const PARAM = Object.freeze({
  NORMAL: 'normal',
  CHANGED: 'changed',
  MAJOR: 'major',
  INVALID: 'invalid',
});

export const SENSORS = Object.freeze(['turbidity', 'conductivity', 'temperature', 'tankLevel']);
export const QUALITY_SENSORS = Object.freeze(['turbidity', 'conductivity', 'temperature']);

/**
 * PROTOTYPE THRESHOLDS — require field validation. Not public-health limits.
 */
export const PROTOTYPE_THRESHOLDS = Object.freeze({
  turbidity: {
    // Absolute rise in NTU above the household baseline. Only increases count:
    // a rise can indicate sediment/biofilm disturbance or particles entering the tank.
    changedRise: 1.0,
    majorRise: 4.0,
    validRange: [0, 1000],
  },
  conductivity: {
    // Relative change (either direction) vs baseline, in µS/cm. A shift can
    // indicate a different source water or something entering the tank.
    changedFraction: 0.2,
    majorFraction: 0.5,
    validRange: [1, 5000],
  },
  temperature: {
    // Absolute difference in °C vs baseline. Temperature is context only:
    // warmer stored water can favour microbial regrowth, but temperature
    // alone is never treated as a MAJOR deviation.
    changedDelta: 8,
    validRange: [-5, 60],
  },
  tankLevel: {
    validRange: [0, 100], // percent
  },
  // A reading older than this is treated as missing (monitor offline/stuck).
  maxReadingAgeMinutes: 30,
  // Number of MAJOR deviations that escalate CHECK to ACTION.
  majorDeviationsForAction: 2,
  // Tank level rise (percentage points) between readings that counts as a delivery.
  deliveryRisePoints: 15,
});

/** A finite number inside [min, max]. Rejects null, undefined, NaN, Infinity, strings. */
export function isValidValue(value, range) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return value >= range[0] && value <= range[1];
}

function assessTurbidity(value, baseline, t) {
  const rise = value - baseline;
  if (rise >= t.majorRise) return PARAM.MAJOR;
  if (rise >= t.changedRise) return PARAM.CHANGED;
  return PARAM.NORMAL;
}

function assessConductivity(value, baseline, t) {
  const fraction = Math.abs(value - baseline) / baseline;
  if (fraction >= t.majorFraction) return PARAM.MAJOR;
  if (fraction >= t.changedFraction) return PARAM.CHANGED;
  return PARAM.NORMAL;
}

function assessTemperature(value, baseline, t) {
  return Math.abs(value - baseline) >= t.changedDelta ? PARAM.CHANGED : PARAM.NORMAL;
}

/**
 * Assess each sensor against the baseline.
 * @returns {{[k: string]: {value: any, baseline: any, state: string}}}
 */
export function assessParameters(reading, baseline, thresholds = PROTOTYPE_THRESHOLDS) {
  const r = reading || {};
  const b = baseline || {};
  const out = {};
  for (const key of SENSORS) {
    const t = thresholds[key];
    const value = r[key];
    const base = b[key];
    let state;
    if (!isValidValue(value, t.validRange)) {
      state = PARAM.INVALID;
    } else if (key === 'tankLevel') {
      state = PARAM.NORMAL; // level is not a quality indicator; only needs to be working
    } else if (!isValidValue(base, t.validRange)) {
      // Without a valid baseline we cannot say "no change" — unknown is not normal.
      state = PARAM.INVALID;
    } else if (key === 'turbidity') {
      state = assessTurbidity(value, base, t);
    } else if (key === 'conductivity') {
      state = assessConductivity(value, base, t);
    } else {
      state = assessTemperature(value, base, t);
    }
    out[key] = { value, baseline: base, state };
  }
  return out;
}

/**
 * Main entry point.
 *
 * Priority (most cautious first):
 *   1. official advisory              -> ACTION
 *      (An advisory comes from the local authority, independent of sensors.
 *       If sensors are also failing we still show ACTION — never less cautious —
 *       and report the sensor fault in `reasons`.)
 *   2. sensor failure / stale reading -> SYSTEM_CHECK
 *   3. >= 2 major deviations          -> ACTION
 *   4. any meaningful deviation       -> CHECK
 *   5. otherwise                      -> NORMAL ("no unusual change detected")
 *
 * @param {object} reading   {timestamp, turbidity, conductivity, temperature, tankLevel}
 * @param {object} baseline  {turbidity, conductivity, temperature}
 * @param {object} [opts]    {advisory: boolean, now: number(ms), thresholds}
 */
export function evaluate(reading, baseline, opts = {}) {
  const thresholds = opts.thresholds || PROTOTYPE_THRESHOLDS;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const advisory = opts.advisory === true;

  const params = assessParameters(reading, baseline, thresholds);
  const reasons = [];

  const invalid = SENSORS.filter((k) => params[k].state === PARAM.INVALID);
  for (const k of invalid) reasons.push(`sensor_invalid:${k}`);

  const ts = reading && reading.timestamp;
  const tsValid = typeof ts === 'number' && Number.isFinite(ts);
  const stale = !tsValid || now - ts > thresholds.maxReadingAgeMinutes * 60_000 || ts - now > 5 * 60_000;
  if (stale) reasons.push('reading_stale');

  const sensorFault = invalid.length > 0 || stale;

  const major = QUALITY_SENSORS.filter((k) => params[k].state === PARAM.MAJOR);
  const changed = QUALITY_SENSORS.filter((k) => params[k].state === PARAM.CHANGED);

  let status;
  if (advisory) {
    reasons.unshift('official_advisory');
    status = STATUS.ACTION;
  } else if (sensorFault) {
    status = STATUS.SYSTEM_CHECK;
  } else if (major.length >= thresholds.majorDeviationsForAction) {
    reasons.push('multiple_major_deviations');
    status = STATUS.ACTION;
  } else if (major.length + changed.length > 0) {
    reasons.push('deviation_from_baseline');
    status = STATUS.CHECK;
  } else {
    status = STATUS.NORMAL;
  }

  // Defensive invariant: a sensor fault must never be reported as NORMAL or CHECK.
  if (sensorFault && (status === STATUS.NORMAL || status === STATUS.CHECK)) {
    status = STATUS.SYSTEM_CHECK;
  }

  return { status, reasons, params, advisory, stale, sensorFault, changed: [...major, ...changed] };
}

/** Detect a water delivery (tank fill) between two consecutive level readings. */
export function detectDelivery(previousLevel, newLevel, thresholds = PROTOTYPE_THRESHOLDS) {
  const range = thresholds.tankLevel.validRange;
  if (!isValidValue(previousLevel, range) || !isValidValue(newLevel, range)) return false;
  return newLevel - previousLevel >= thresholds.deliveryRisePoints;
}

/**
 * PROTOTYPE ASSUMPTIONS for the "water remaining" estimate. Tank sizes and
 * household use vary widely; these are placeholders, not survey data.
 */
export const TANK_ASSUMPTIONS = Object.freeze({
  capacityLitres: 1200,
  dailyUseLitres: 330,
});

/** Estimated days of water remaining (rounded), or null if unknown. */
export function estimateDaysRemaining(levelPercent, assumptions = TANK_ASSUMPTIONS) {
  if (!isValidValue(levelPercent, PROTOTYPE_THRESHOLDS.tankLevel.validRange)) return null;
  if (!(assumptions.dailyUseLitres > 0)) return null;
  const litres = (levelPercent / 100) * assumptions.capacityLitres;
  return Math.round(litres / assumptions.dailyUseLitres);
}

/**
 * Resident water check -> recommendation code. Pure.
 * Never certifies safety; the best outcome is "nothing unusual noticed".
 * @param {{appearance: 'no'|'cloudy'|'discoloured', smell: 'no'|'yes', chlorine: 'normal'|'low'|'not_tested'}} answers
 * @param {string} currentStatus  one of STATUS
 */
export function recommendFromCheck(answers, currentStatus) {
  const a = answers || {};
  const residentNoticed = a.appearance === 'cloudy' || a.appearance === 'discoloured' || a.smell === 'yes';
  const lowChlorine = a.chlorine === 'low';

  if (currentStatus === STATUS.ACTION) return 'follow_guidance';
  if (residentNoticed || lowChlorine) return 'contact_services';
  if (currentStatus === STATUS.CHECK) return 'keep_watching';
  if (currentStatus === STATUS.SYSTEM_CHECK) return 'monitor_service';
  return 'nothing_unusual';
}
