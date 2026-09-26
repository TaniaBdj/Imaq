/**
 * Delivery priority — deterministic operational decision support (not AI).
 *
 *   score = daysOfWaterRemaining
 *           − 2    if the household reported its low-water light
 *           − 0.5  if the household has a vulnerability flag (e.g. elder, infant)
 *           − 0.5  if its delivery is delayed (no truck / route full)
 *           − 0.5  if its scheduled delivery is overdue (by > 12 h)
 *
 * Lower score = more urgent.
 *
 * UNKNOWN IS NOT EMPTY: if the tank level is unknown (monitor problem), the
 * household is planned from its delivery schedule only (score = days until due + 1).
 * A sensor failure never raises water-supply priority; it is tracked separately
 * as monitor maintenance.
 *
 * All weights are PROTOTYPE values to be set with operators.
 */
export const PRIORITY_WEIGHTS = Object.freeze({
  lowWaterReport: 2,
  vulnerability: 0.5,
  delayed: 0.5,
  overdue: 0.5,
  highAtOrBelow: 0.5,
  mediumAtOrBelow: 2,
});

/**
 * @param {{days: number|null, lowWaterReported: boolean, vulnerability: string|null, delayed: boolean}} input
 * @returns {{score: number, level: 'HIGH'|'MEDIUM'|'LOW', reasons: string[]}}
 */
export function priorityOf({ days, lowWaterReported, vulnerability, delayed, overdue = false, daysUntilDue = null }, w = PRIORITY_WEIGHTS) {
  const reasons = [];
  let score;
  const known = typeof days === 'number' && Number.isFinite(days);
  if (known) {
    score = days;
    reasons.push('days');
  } else {
    score = Math.max(0, Number.isFinite(daysUntilDue) ? daysUntilDue : 0) + 1;
    reasons.push('scheduleOnly');
  }
  if (lowWaterReported) {
    score -= w.lowWaterReport;
    reasons.push('lowWater');
  }
  if (vulnerability) {
    score -= w.vulnerability;
    reasons.push('vulnerability');
  }
  if (delayed) {
    score -= w.delayed;
    reasons.push('delayed');
  }
  if (known && overdue) {
    score -= w.overdue;
    reasons.push('overdue');
  }
  const level = score <= w.highAtOrBelow ? 'HIGH' : score <= w.mediumAtOrBelow ? 'MEDIUM' : 'LOW';
  return { score: Math.round(score * 100) / 100, level, reasons };
}

/** Litres needed to fill the tank (rounded to 50 L), or null if unknown. */
export function litresToFill(levelPercent, household) {
  const cap = household && household.tankCapacityLitres;
  if (typeof levelPercent !== 'number' || !Number.isFinite(levelPercent) || !(cap > 0)) return null;
  return Math.max(0, Math.round(((100 - levelPercent) / 100) * cap / 50) * 50);
}
