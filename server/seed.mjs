/**
 * Deterministic demo seed / reset: `npm run seed`.
 * Loads the SYNTHETIC JSON in data/ into PostgreSQL. Recorded times are rebased so
 * the newest reading is ~2 minutes old at seed time; tank levels are converted into
 * top-mounted-sensor distances using each tank's height.
 * DESTRUCTIVE: replaces all operational data. Never exposed through the web UI.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { migrate, createDb } from './db.mjs';
import { normalizeReadings, parseTimestamp } from '../js/sensor-data.js';
import { distanceFromLevel } from '../js/core/tank.js';

const DATA = new URL('../data/', import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, DATA), 'utf8'));
const ANCHOR_LAG_MS = 2 * 60_000;

async function insertMany(db, table, columns, rows, chunk = 150) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const values = part.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`);
    await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`, params);
  }
}

export async function seedDatabase(db, { now = Date.now() } = {}) {
  await migrate(db);
  const [hh, rd, dl, tr, se, mu] = await Promise.all(
    ['households.json', 'readings.json', 'deliveries.json', 'trucks.json', 'sensors.json', 'municipality.json'].map(load));
  const shift = now - ANCHOR_LAG_MS - parseTimestamp(rd._meta.recordingEnd);
  const at = (iso) => new Date(parseTimestamp(iso) + shift).toISOString();

  await db.exec(`TRUNCATE sensor_readings, deliveries, low_water_reports, alerts, users, sensor_devices, households, trucks, settings RESTART IDENTITY CASCADE`);

  await insertMany(db, 'trucks', ['id', 'display_name', 'capacity_l', 'current_water_l', 'status', 'trip'],
    tr.trucks.map((t) => [t.id, t.displayName, t.capacityLitres, t.remainingLitres, 'IN_SERVICE', t.trip]));
  await insertMany(db, 'households',
    ['id', 'display_name', 'residents_count', 'tank_capacity_l', 'tank_height_cm', 'configured_daily_use_l', 'vulnerability_flag', 'assigned_truck_id', 'delivery_interval_days', 'water_baseline'],
    hh.households.map((h) => [h.id, h.displayName, h.occupants, h.tankCapacityLitres, h.tankHeightCm, h.estimatedDailyUseLitres, h.vulnerability, h.assignedTruck, h.deliveryIntervalDays, JSON.stringify(h.baseline)]));

  const heights = Object.fromEntries(hh.households.map((h) => [h.id, h.tankHeightCm]));
  const lastSeen = {};
  const readingRows = [];
  for (const s of se.sensors) {
    if (!s.householdId) continue;
    const { readings } = normalizeReadings(rd.households[s.householdId]);
    for (const r of readings) {
      const ts = new Date(r.timestamp + shift).toISOString();
      readingRows.push([s.id, ts, distanceFromLevel(r.tankLevel, heights[s.householdId]), r.turbidity, r.conductivity, r.temperature, s.batteryPercent]);
      lastSeen[s.id] = ts;
    }
  }
  await insertMany(db, 'sensor_devices', ['id', 'serial_number', 'household_id', 'status', 'battery_percent', 'firmware_version', 'last_seen'],
    se.sensors.map((s) => [s.id, s.id, s.householdId, s.householdId ? 'ONLINE' : 'UNASSIGNED', s.batteryPercent, s.firmwareVersion, lastSeen[s.id] || null]));
  await insertMany(db, 'sensor_readings', ['sensor_device_id', 'recorded_at', 'distance_cm', 'turbidity', 'conductivity', 'temperature', 'battery_percent'], readingRows);
  await insertMany(db, 'deliveries', ['household_id', 'truck_id', 'litres', 'delivered_at'],
    dl.deliveries.map((d) => [d.householdId, d.truckId, d.litres, at(d.timestamp)]));

  // Monitor that stopped reporting 5 h before the end of the recording stays silent.
  const offline = se.sensors.filter((s) => s.householdId && Date.parse(lastSeen[s.id]) < now - 60 * 60_000).map((s) => s.id);
  const settings = {
    community: mu.community,
    village_water_m3: mu.villageWaterCubicMetres,
    village_water_capacity_m3: mu.villageWaterCapacityCubicMetres,
    max_stops_per_truck_per_day: mu.maxStopsPerTruckPerDay,
    seeded_at: new Date(now).toISOString(),
    synthetic_offline_devices: offline,
  };
  await insertMany(db, 'settings', ['key', 'value'], Object.entries(settings).map(([k, v]) => [k, JSON.stringify(v)]));

  // Prototype users (placeholder identities for future authentication).
  await insertMany(db, 'users', ['name', 'email', 'role', 'household_id', 'truck_id'], [
    ['Municipal operator (sample)', 'operator@imaq.example', 'admin', null, null],
    ...tr.trucks.map((t) => [`Driver ${t.id} (sample)`, `driver.${t.id.toLowerCase()}@imaq.example`, 'driver', null, t.id]),
    ...hh.households.map((h) => [`Resident ${h.id} (sample)`, `resident.${h.id.toLowerCase()}@imaq.example`, 'resident', h.id, null]),
  ]);
  return { households: hh.households.length, trucks: tr.trucks.length, sensors: se.sensors.length, readings: readingRows.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = await createDb();
  try {
    const out = await seedDatabase(db);
    console.log(`Seeded ${db.kind}:`, out);
  } finally {
    await db.close();
  }
}
