/**
 * Analysis — pure functions that run normalized readings through the
 * detection engine. Knows nothing about where readings came from.
 */
import { evaluate, detectDelivery, isValidValue, STATUS, QUALITY_SENSORS, PROTOTYPE_THRESHOLDS } from './detection.js';

export function activeAdvisory(alerts) {
  return (alerts || []).some((a) => a.type === 'advisory' && a.active === true);
}

/**
 * Walk readings oldest→newest.
 *  - detects deliveries from tank-level rises
 *  - refreshes the household baseline after a delivery ONLY if the delivered
 *    water is not itself unusual (otherwise a bad delivery would become "normal")
 *  - records status transitions
 * Then evaluates the CURRENT status of the newest reading at time `now`
 * (this is where staleness and official advisories apply).
 *
 * @param {NormalizedReading[]} readings  sorted oldest→newest
 * @param {object} initialBaseline         {turbidity, conductivity, temperature}
 * @param {{alerts?: object[], now: number}} opts
 */
export function analyze(readings, initialBaseline, { alerts = [], now } = {}) {
  let baseline = { ...(initialBaseline || {}) };
  let prevLevel = null;
  let lastStatus = null;
  const events = [];
  const statusByTs = new Map();

  for (const r of readings || []) {
    if (detectDelivery(prevLevel, r.tankLevel)) {
      const check = evaluate(r, baseline, { now: r.timestamp });
      const baselineUpdated = check.status === STATUS.NORMAL;
      if (baselineUpdated) {
        const nb = {};
        for (const k of QUALITY_SENSORS) nb[k] = r[k];
        baseline = nb;
      }
      events.push({ ts: r.timestamp, type: 'delivery', from: prevLevel, to: r.tankLevel, baselineUpdated });
    }
    // Historical readings are judged at their own time (no staleness, no advisory).
    const res = evaluate(r, baseline, { now: r.timestamp });
    statusByTs.set(r.timestamp, res.status);
    if (res.status !== lastStatus) {
      if (lastStatus !== null) {
        events.push({ ts: r.timestamp, type: 'status', status: res.status, previous: lastStatus, changed: res.changed });
      }
      lastStatus = res.status;
    }
    if (isValidValue(r.tankLevel, PROTOTYPE_THRESHOLDS.tankLevel.validRange)) prevLevel = r.tankLevel;
  }

  for (const a of alerts || []) {
    if (a.type === 'advisory') events.push({ ts: a.issuedAt, type: 'alert', active: a.active, issuer: a.issuer });
  }
  events.sort((a, b) => b.ts - a.ts);

  const latest = readings && readings.length ? readings[readings.length - 1] : null;
  const current = evaluate(latest, baseline, { now, advisory: activeAdvisory(alerts) });
  const lastDelivery = events.find((e) => e.type === 'delivery') || null;

  return { current, baseline, events, latest, statusByTs, lastDelivery };
}
