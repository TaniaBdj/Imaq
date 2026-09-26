/**
 * SyntheticSensorProvider — stands in for the physical tank monitors.
 *
 * It produces the SAME canonical payload an ESP32 gateway will send and pushes
 * it through the SAME ingestion path (validation → sensor_readings). Nothing
 * downstream knows the data is synthetic. Every 5 minutes, per assigned device:
 *   - tank level falls with the household's configured daily use (day/night profile)
 *   - water poured in by a confirmed delivery raises the level (hardware emulation:
 *     in the field the level sensor simply measures the fill)
 *   - water-quality values repeat the device's last values (a failed sensor stays failed)
 * Devices listed in settings.synthetic_offline_devices stay silent (monitor offline).
 */
import { ingestReading } from './ingest.mjs';
import { makeSensorPayload } from '../js/sensor-data.js';
import { levelFromDistance, distanceFromLevel } from '../js/core/tank.js';

export const SYNTHETIC_STEP_MS = 5 * 60_000;
const hourWeight = (h) => (h >= 7 && h < 22 ? 0.9 / 15 : 0.1 / 9);
const MAX_CATCH_UP_MS = 24 * 3600_000;

export function createSyntheticSensors({ db, clock = () => Date.now() }) {
  let running = null;

  async function devices() {
    const { rows } = await db.query(
      `SELECT d.id, d.household_id, d.battery_percent, h.tank_height_cm, h.tank_capacity_l, h.configured_daily_use_l, h.water_baseline,
              (SELECT row_to_json(r) FROM (SELECT recorded_at, distance_cm, turbidity, conductivity, temperature, battery_percent
                                             FROM sensor_readings WHERE sensor_device_id = d.id ORDER BY recorded_at DESC LIMIT 1) r) AS last
         FROM sensor_devices d JOIN households h ON h.id = d.household_id
        WHERE d.household_id IS NOT NULL AND d.status <> 'SERVICE_REQUIRED' AND NOT h.archived`);
    const off = await db.query(`SELECT value FROM settings WHERE key = 'synthetic_offline_devices'`);
    const offline = new Set(off.rows[0] ? off.rows[0].value : []);
    return rows.filter((d) => !offline.has(d.id));
  }

  async function stepDevice(d, now, extraPoints = []) {
    const height = Number(d.tank_height_cm);
    const cap = Number(d.tank_capacity_l);
    const daily = Number(d.configured_daily_use_l);
    const base = d.water_baseline || { turbidity: 0.42, conductivity: 86, temperature: 14.2 };
    // A newly installed synthetic monitor starts from an explicit synthetic level.
    const last = d.last
      ? { ts: Date.parse(d.last.recorded_at), level: levelFromDistance(Number(d.last.distance_cm), height), turbidity: d.last.turbidity, conductivity: d.last.conductivity, temperature: d.last.temperature, battery: d.last.battery_percent }
      : { ts: now - SYNTHETIC_STEP_MS, level: 50, turbidity: base.turbidity, conductivity: base.conductivity, temperature: base.temperature, battery: Number(d.battery_percent) || 100 };
    if (last.level === null) return 0;
    const start = Math.max(last.ts, now - MAX_CATCH_UP_MS);
    const { rows: dels } = await db.query(
      `SELECT litres, delivered_at FROM deliveries WHERE household_id = $1 AND delivered_at > $2 AND delivered_at <= $3`,
      [d.household_id, new Date(last.ts).toISOString(), new Date(now).toISOString()]);
    const points = [];
    for (let t = start + SYNTHETIC_STEP_MS; t <= now; t += SYNTHETIC_STEP_MS) points.push({ t, add: 0 });
    for (const x of dels) points.push({ t: Date.parse(x.delivered_at) + 1000, add: Number(x.litres) });
    for (const x of extraPoints) points.push(x);
    points.sort((a, b) => a.t - b.t);
    let level = last.level;
    let prev = last.ts;
    let count = 0;
    for (const p of points) {
      if (p.t <= prev || p.t > now + 1000) continue;
      const mid = new Date((prev + p.t) / 2).getHours();
      level -= (daily * hourWeight(mid) * ((p.t - prev) / 3600_000) * 100) / cap;
      if (p.add) level += (p.add / cap) * 100;
      level = Math.max(0, Math.min(100, level));
      prev = p.t;
      await ingestReading(db, makeSensorPayload({
        deviceId: d.id, ts: p.t, distanceCm: distanceFromLevel(level, height),
        turbidity: last.turbidity, conductivity: last.conductivity, temperature: last.temperature,
        batteryPercent: last.battery,
      }), { now: Math.max(now, p.t) });
      count += 1;
    }
    return count;
  }

  return {
    /** Emit any readings due up to now. Serialised so ticks never overlap. */
    async tick() {
      if (running) return running;
      running = (async () => {
        const now = clock();
        let n = 0;
        for (const d of await devices()) n += await stepDevice(d, now);
        return n;
      })().finally(() => (running = null));
      return running;
    },
    /** Hardware emulation hook: after a confirmed delivery the level sensor reports the fill. */
    async afterDelivery(householdId) {
      await (running || Promise.resolve());
      const now = clock();
      for (const d of await devices()) if (d.household_id === householdId) await stepDevice(d, now + 1000);
    },
  };
}
