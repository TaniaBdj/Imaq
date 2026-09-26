/**
 * Selectors — derive the shared operational picture from the API state.
 * Pure: same inputs → same outputs. Used identically by all three role UIs.
 *
 *   sensor distance ─► tank level ─► litres ─► consumption ─► days remaining
 *   water values    ─► detection engine (unchanged) ─► NORMAL / CHECK / ACTION / SYSTEM CHECK
 *   + deliveries, low-water reports, trucks ─► priority ─► routes
 */
import { analyze } from '../analysis.js';
import { STATUS, PARAM } from '../detection.js';
import { levelFromDistance, litresFromLevel, estimateConsumption, daysRemaining } from '../core/tank.js';
import { priorityOf, litresToFill } from './priority.js';
import { planRoutes } from './routes.js';

const DAY = 86_400_000;
export const SENSOR_ONLINE_MS = 30 * 60_000;
export const SENSOR_STALE_MS = 2 * 3600_000; // silent > 2 h → OFFLINE

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Effective monitor status. Manual states (service, unassigned) win; otherwise by last contact. */
export function sensorStatus(sensor, now) {
  if (!sensor) return 'NOT_INSTALLED';
  if (!sensor.householdId) return 'UNASSIGNED';
  if (sensor.status === 'SERVICE_REQUIRED') return 'SERVICE_REQUIRED';
  if (!Number.isFinite(sensor.lastSeen)) return 'OFFLINE';
  const age = now - sensor.lastSeen;
  return age <= SENSOR_ONLINE_MS ? 'ONLINE' : age <= SENSOR_STALE_MS ? 'STALE' : 'OFFLINE';
}

const EMPTY = { households: [], trucks: [], sensors: [], readings: {}, deliveries: [], lowWaterReports: [], alerts: [], settings: {} };

export function buildSnapshot({ data, now, checks = [] }) {
  const d = data || EMPTY;
  const settings = d.settings || {};
  const activeAlerts = d.alerts.filter((a) => a.active && a.audience === 'households').map((a) => ({ ...a, ts: a.createdAt }));
  // The detection engine understands official advisories.
  const advisories = activeAlerts.filter((a) => a.type === 'advisory').map((a) => ({ type: 'advisory', active: true, issuedAt: a.ts }));
  const todayStart = startOfDay(now);
  const households = d.households.filter((h) => !h.archived);
  const sensorByHousehold = Object.fromEntries(d.sensors.filter((s) => s.householdId).map((s) => [s.householdId, s]));
  const deliveries = d.deliveries.map((x) => ({ id: x.id, householdId: x.householdId, truckId: x.truckId, litres: x.litres, ts: x.deliveredAt, source: 'record' }));

  const base = {};
  for (const h of households) {
    const sensor = sensorByHousehold[h.id] || null;
    const meta = {
      id: h.id, displayName: h.displayName, occupants: h.residentsCount, tankCapacityLitres: h.tankCapacityL, tankHeightCm: h.tankHeightCm,
      estimatedDailyUseLitres: h.configuredDailyUseL, vulnerability: h.vulnerability, assignedTruck: h.assignedTruckId,
      deliveryIntervalDays: h.deliveryIntervalDays, baseline: h.baseline || {}, sensorDevice: sensor ? sensor.id : null,
    };
    const raw = sensor ? d.readings[sensor.id] || [] : [];
    // Sensor boundary → normalized readings. Impossible distance → null level → SYSTEM CHECK.
    const readings = raw.map(([ts, dist, turbidity, conductivity, temperature]) => ({
      timestamp: ts, turbidity, conductivity, temperature, tankLevel: levelFromDistance(dist, h.tankHeightCm),
    })).filter((r) => r.timestamp <= now + 5 * 60_000);
    const analysis = analyze(readings, meta.baseline, { alerts: advisories, now });
    const result = analysis.current;
    if (result.stale) {
      // Old values are not current conditions: show every measurement as unknown.
      for (const k of Object.keys(result.params)) result.params[k] = { ...result.params[k], state: PARAM.INVALID };
    }
    const latest = analysis.latest;
    // Tank level is only trusted from a fresh, valid reading. UNKNOWN is never 0.
    const levelKnown = latest && !result.stale && result.params.tankLevel.state !== PARAM.INVALID;
    const level = levelKnown ? latest.tankLevel : null;
    const litres = litresFromLevel(level, h.tankCapacityL);
    const consumption = estimateConsumption(readings.map((r) => ({ ts: r.timestamp, litres: litresFromLevel(r.tankLevel, h.tankCapacityL) })), h.configuredDailyUseL);
    const days = daysRemaining(litres, consumption.litresPerDay);
    const hDeliveries = deliveries.filter((x) => x.householdId === h.id).sort((a, b) => b.ts - a.ts);
    const lastDelivery = hDeliveries[0] || null;
    const dueTs = lastDelivery ? lastDelivery.ts + meta.deliveryIntervalDays * DAY : now;
    const openReport = d.lowWaterReports.find((r) => r.householdId === h.id && !r.resolvedAt);
    const monitor = sensorStatus(sensor, now);
    base[h.id] = {
      id: h.id, meta, sensor, monitor, readings, analysis, status: result.status, result, level, litres, consumption, days,
      lowWaterReported: !!h.lowWaterReported, lowWaterReportedAt: openReport ? openReport.createdAt : null,
      deliveries: hDeliveries, lastDelivery, dueTs, overdue: now - dueTs > 12 * 3600_000, servedToday: !!lastDelivery && lastDelivery.ts >= todayStart,
      estLitres: litresToFill(level, meta),
      // Monitor maintenance is tracked separately from water-supply priority.
      monitorAttention: monitor !== 'ONLINE' || result.status === STATUS.SYSTEM_CHECK,
    };
  }

  const trucks = d.trucks.filter((t) => !t.archived).map((t) => ({
    id: t.id, displayName: t.displayName, capacityLitres: t.capacityL, remainingLitres: t.currentWaterL, trip: t.trip,
    status: t.status === 'IN_SERVICE' ? 'OPERATING' : 'OUT_OF_SERVICE', statusChangedAt: t.statusChangedAt,
  }));
  const maxStops = settings.max_stops_per_truck_per_day || 6;
  const plan = (delayedIds) => {
    const hs = Object.values(base).map((h) => {
      const p = priorityOf({
        days: h.days, lowWaterReported: h.lowWaterReported, vulnerability: h.meta.vulnerability, delayed: delayedIds.has(h.id),
        overdue: h.overdue, daysUntilDue: (h.dueTs - now) / DAY,
      });
      return { id: h.id, assignedTruck: h.meta.assignedTruck, score: p.score, priorityLevel: p.level, priority: p, dueTs: h.dueTs, servedToday: h.servedToday };
    });
    return { hs, routes: planRoutes({ households: hs, trucks, now, maxStopsPerDay: maxStops }) };
  };
  // Two passes: truck availability (a delayed delivery) raises priority, then routes are planned.
  const first = plan(new Set());
  const delayed = new Set(Object.entries(first.routes.plan).filter(([, p]) => p.delayed).map(([id]) => id));
  const final = plan(delayed);

  const out = {};
  for (const h of final.hs) {
    const b = base[h.id];
    const lowWater = b.lowWaterReported || (typeof b.level === 'number' && b.level < 25) || (typeof b.days === 'number' && b.days <= 1);
    out[h.id] = {
      ...b, priority: h.priority, plan: final.routes.plan[h.id], lowWater,
      needsAttention: b.status !== STATUS.NORMAL || h.priority.level === 'HIGH' || lowWater || b.monitorAttention,
    };
  }

  const truckViews = trucks.map((t) => {
    const r = final.routes.routes[t.id] || { today: [], overflow: [], assigned: [] };
    const deliveredToday = deliveries.filter((x) => x.truckId === t.id && x.ts >= todayStart && x.ts <= now).sort((a, b) => b.ts - a.ts);
    return { ...t, today: r.today, overflow: r.overflow, assigned: r.assigned, deliveredToday };
  });

  // Operations log, derived from persisted records.
  const log = [
    ...deliveries.filter((x) => x.ts >= now - 2 * DAY).map((x) => ({ ts: x.ts, type: 'delivery', householdId: x.householdId, truckId: x.truckId, litres: x.litres })),
    ...d.lowWaterReports.map((r) => ({ ts: r.createdAt, type: 'low_water', householdId: r.householdId })),
    ...d.alerts.filter((a) => a.audience === 'households').flatMap((a) => [{ ts: a.createdAt, type: 'alert', alertType: a.type }, ...(a.endedAt ? [{ ts: a.endedAt, type: 'alert_end', alertType: a.type }] : [])]),
    ...trucks.filter((t) => t.statusChangedAt).map((t) => ({ ts: t.statusChangedAt, type: t.status === 'OPERATING' ? 'truck_up' : 'truck_down', truckId: t.id })),
    ...checks.map((c) => ({ ts: c.ts, type: 'check', householdId: c.householdId, recommendation: c.recommendation, local: true })),
  ].filter((x) => Number.isFinite(x.ts) && x.ts <= now).sort((a, b) => b.ts - a.ts);

  const list = Object.values(out);
  const sensors = d.sensors.map((s) => ({ ...s, effectiveStatus: sensorStatus(s, now) }));
  const known = list.filter((h) => typeof h.litres === 'number');
  return {
    now,
    households: out,
    archivedHouseholds: d.households.filter((h) => h.archived),
    archivedTrucks: d.trucks.filter((t) => t.archived),
    rawHouseholds: d.households,
    rawTrucks: d.trucks,
    trucks: truckViews,
    sensors,
    routes: final.routes,
    alerts: activeAlerts,
    allAlerts: d.alerts.filter((a) => a.audience === 'households').map((a) => ({ ...a, ts: a.createdAt })),
    opsAlerts: d.alerts.filter((a) => a.active && a.audience === 'municipality').map((a) => ({ ...a, ts: a.createdAt, affected: a.affected || [] })),
    deliveries,
    checks,
    log,
    kpis: {
      householdsMonitored: list.filter((h) => h.sensor).length,
      householdsTotal: list.length,
      trucksOperating: final.routes.operating.length,
      trucksTotal: trucks.length,
      needingAttention: list.filter((h) => h.needsAttention).length,
      highPriority: list.filter((h) => h.priority.level === 'HIGH').length,
      sensorsOnline: list.filter((h) => h.monitor === 'ONLINE').length,
      communityWaterLitres: known.reduce((s, h) => s + h.litres, 0),
      communityWaterKnown: known.length,
      activeAlerts: activeAlerts.length,
      villageWaterCubicMetres: settings.village_water_m3,
      villageWaterCapacityCubicMetres: settings.village_water_capacity_m3,
    },
  };
}
