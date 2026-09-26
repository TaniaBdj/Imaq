/**
 * Database + API + cross-role integration tests.
 * A real Imaq server (node:http) on embedded PostgreSQL (PGlite) — the same SQL
 * that runs on Railway. Roles act through the SAME ApiRepository/OperationalStore
 * the browser uses.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.mjs';
import { seedDatabase } from '../server/seed.mjs';
import { ApiRepository } from '../js/ops/api-repository.js';
import { createOperationalStore } from '../js/ops/store.js';
import { createStorage } from '../js/storage.js';
import { STATUS } from '../js/detection.js';
import { memoryBackend } from './helpers.js';

let server;
let base;
const ENV = { NODE_ENV: 'test', IMAQ_ADMIN_PIN: '2026' };

before(async () => {
  server = await startServer({ port: 0, env: ENV, quiet: true });
  base = `http://localhost:${server.port}/api/`;
});
after(async () => server && server.close());

const reset = () => seedDatabase(server.db);
async function role(pin = null) {
  const repo = new ApiRepository({ baseUrl: base, getAdminPin: () => pin });
  const ops = createOperationalStore({ repository: repo, storage: createStorage(memoryBackend()) });
  await ops.init();
  return ops;
}
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const admin = { 'X-Imaq-Admin-Pin': '2026' };

// ---------------- DATABASE ----------------
test('DB: schema initializes and seed succeeds (12 households, 3 trucks, 13 sensors, history)', async () => {
  const out = await reset();
  assert.deepEqual(out, { households: 12, trucks: 3, sensors: 13, readings: 1154 });
  const tables = (await server.db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map((r) => r.table_name);
  for (const t of ['alerts', 'deliveries', 'households', 'low_water_reports', 'sensor_devices', 'sensor_readings', 'settings', 'trucks', 'users']) assert.ok(tables.includes(t), t);
  const idx = (await server.db.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('sensor_readings','deliveries')`)).rows.map((r) => r.indexname);
  assert.ok(idx.includes('sensor_readings_device_time') && idx.includes('deliveries_household_time'));
  const again = await reset();
  assert.equal(again.readings, 1154, 'seed is repeatable (reset-demo)');
});

test('API: health, state shape, no secrets, server files not served', async () => {
  await reset();
  const h = await api('GET', 'health');
  assert.equal(h.status, 200);
  assert.ok(!JSON.stringify(h.json).includes('postgres://'));
  const s = await api('GET', 'state');
  assert.equal(s.json.households.length, 12);
  assert.ok(!('DATABASE_URL' in s.json));
  for (const path of ['server/db.mjs', 'package.json', '.env', 'data/readings.json', '../package.json']) {
    const r = await fetch(`http://localhost:${server.port}/${path}`);
    assert.equal(r.status, 404, path);
  }
  const bad = await fetch(base + 'deliveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.ok(!('stack' in body));
});

test('SNAPSHOT: tank %, litres, consumption and days derive from sensor distance + tank config', async () => {
  await reset();
  const ops = await role();
  const s = ops.snapshot();
  const h = s.households['H-031'];
  assert.equal(Math.round(h.level), 25);
  assert.equal(Math.round(h.litres), Math.round(1500 * h.level / 100));
  assert.ok(['measured', 'configured'].includes(h.consumption.source));
  assert.ok(Math.abs(h.days - h.litres / h.consumption.litresPerDay) < 1e-9);
  assert.equal(h.monitor, 'ONLINE');
  // Offline monitor: UNKNOWN, not zero; maintenance, not low water
  const off = s.households['H-044'];
  assert.equal(off.monitor, 'OFFLINE');
  assert.equal(off.level, null);
  assert.equal(off.litres, null);
  assert.equal(off.days, null);
  assert.equal(off.status, STATUS.SYSTEM_CHECK);
  assert.equal(off.lowWater, false, 'sensor failure is not low water');
  assert.ok(Object.values(off.result.params).every((p) => p.state === 'invalid'), 'stale values are never displayed as Normal');
  assert.ok(off.priority.reasons.includes('scheduleOnly'));
  assert.ok(off.monitorAttention);
  assert.equal(s.households['H-057'].status, STATUS.SYSTEM_CHECK, 'invalid turbidity → SYSTEM CHECK');
  assert.equal(s.households['H-024'].status, STATUS.CHECK);
  assert.equal(s.kpis.sensorsOnline, 11);
  assert.equal(s.kpis.communityWaterKnown, 11);
});

// ---------------- SENSOR INGESTION ----------------
test('SENSOR API: valid payload persists; invalid device/timestamp/distance/NaN rejected', async () => {
  await reset();
  const ts = new Date().toISOString();
  const ok = await api('POST', 'sensor-readings', { deviceId: 'IMQ-0031', timestamp: ts, tank: { distanceCm: 60 }, water: { turbidity: 0.4, conductivity: 86, temperature: 14 }, device: { batteryPercent: 83 } });
  assert.equal(ok.status, 200);
  const ops = await role();
  assert.equal(Math.round(ops.snapshot().households['H-031'].level), 50, '60 cm on a 120 cm tank = 50%');
  const cases = [
    [{ deviceId: 'NOPE', timestamp: ts, tank: { distanceCm: 60 } }, 404],
    [{ deviceId: 'IMQ-0031', timestamp: 'soon', tank: { distanceCm: 60 } }, 400],
    [{ deviceId: 'IMQ-0031', timestamp: ts, tank: {} }, 400],
    [{ deviceId: 'IMQ-0031', timestamp: ts, tank: { distanceCm: 'NaN' } }, 400],
    [{ deviceId: 'IMQ-0031', timestamp: ts, tank: { distanceCm: 400 } }, 422],
    [{ deviceId: 'IMQ-0031', timestamp: ts, tank: { distanceCm: 60 }, water: { turbidity: 'x' } }, 400],
    [{ deviceId: 'IMQ-0100', timestamp: ts, tank: { distanceCm: 60 } }, 409],
  ];
  for (const [payload, status] of cases) assert.equal((await api('POST', 'sensor-readings', payload)).status, status, JSON.stringify(payload));
  const n = (await server.db.query(`SELECT count(*)::int n FROM sensor_readings WHERE sensor_device_id = 'IMQ-0031' AND recorded_at >= $1`, [ts])).rows[0].n;
  assert.equal(n, 1, 'rejected payloads are not persisted');
});

test('SENSOR: a stale monitor becomes SYSTEM CHECK with unknown tank (never NORMAL)', async () => {
  await reset();
  await server.db.query(`UPDATE sensor_devices SET status = 'SERVICE_REQUIRED' WHERE id = 'IMQ-0012'`);
  await server.db.query(`DELETE FROM sensor_readings WHERE sensor_device_id = 'IMQ-0012' AND recorded_at > now() - interval '2 hours'`);
  const h = (await role()).snapshot().households['H-012'];
  assert.equal(h.status, STATUS.SYSTEM_CHECK);
  assert.equal(h.level, null);
  assert.equal(h.monitor, 'SERVICE_REQUIRED');
});

// ---------------- CRUD ----------------
test('CRUD: household add / edit / archive, admin PIN required', async () => {
  await reset();
  const body = { id: 'h-101', residentsCount: 3, tankCapacityL: 1800, tankHeightCm: 140, configuredDailyUseL: 180, vulnerability: 'infant', assignedTruckId: 'T1' };
  assert.equal((await api('POST', 'households', body)).status, 401, 'no PIN');
  assert.equal((await api('POST', 'households', body, { 'X-Imaq-Admin-Pin': 'nope' })).status, 401);
  assert.equal((await api('POST', 'households', { ...body, tankHeightCm: -1 }, admin)).status, 400, 'validation');
  const adminOps = await role('2026');
  await adminOps.saveHousehold(body, true);
  let h = adminOps.snapshot().households['H-101'];
  assert.ok(h, 'new household appears immediately');
  assert.equal(h.monitor, 'NOT_INSTALLED');
  assert.equal(h.level, null, 'no sensor → tank UNKNOWN (not fabricated)');
  assert.equal(h.status, STATUS.SYSTEM_CHECK);
  await assert.rejects(adminOps.saveHousehold(body, true), /already exists/);
  await adminOps.saveHousehold({ ...body, id: 'H-101', residentsCount: 5, assignedTruckId: 'T3' }, false);
  h = adminOps.snapshot().households['H-101'];
  assert.equal(h.meta.occupants, 5);
  assert.equal(h.plan.truckId, 'T3');
  await adminOps.archiveHousehold('H-101');
  assert.equal(adminOps.snapshot().households['H-101'], undefined);
  assert.equal(adminOps.snapshot().archivedHouseholds.length, 1);
});

test('CRUD: truck add / edit / out of service / back / archive; new truck available to drivers', async () => {
  await reset();
  const adminOps = await role('2026');
  await adminOps.saveTruck({ id: 't4', displayName: 'Truck T4', capacityL: 8000, currentWaterL: 8000 }, true);
  const driverOps = await role();
  assert.ok(driverOps.snapshot().trucks.find((t) => t.id === 'T4'), 'driver can select new truck');
  await adminOps.saveTruck({ id: 'T4', displayName: 'Truck T4', capacityL: 8000, currentWaterL: 5000, status: 'IN_SERVICE' }, false);
  assert.equal(adminOps.snapshot().trucks.find((t) => t.id === 'T4').remainingLitres, 5000);
  await assert.rejects(adminOps.saveTruck({ id: 'T4', capacityL: 8000, currentWaterL: 9000 }, false));
  await adminOps.reportTruckProblem('T4');
  assert.equal(adminOps.snapshot().trucks.find((t) => t.id === 'T4').status, 'OUT_OF_SERVICE');
  await adminOps.restoreTruck('T4');
  assert.equal(adminOps.snapshot().trucks.find((t) => t.id === 'T4').status, 'OPERATING');
  await adminOps.archiveTruck('T4');
  assert.equal(adminOps.snapshot().trucks.find((t) => t.id === 'T4'), undefined);
});

test('CRUD: sensor register / assign → household becomes monitored; reassign; mark for service', async () => {
  await reset();
  const adminOps = await role('2026');
  await adminOps.saveHousehold({ id: 'H-102', residentsCount: 4, tankCapacityL: 2000, tankHeightCm: 150, configuredDailyUseL: 240, assignedTruckId: 'T1' }, true);
  assert.equal(adminOps.snapshot().households['H-102'].monitor, 'NOT_INSTALLED');
  await adminOps.updateSensor('IMQ-0100', { householdId: 'H-102' }); // assign the spare
  let h = adminOps.snapshot().households['H-102'];
  assert.equal(h.sensor.id, 'IMQ-0100');
  assert.equal(h.monitor, 'ONLINE', 'synthetic monitor reports through the ingestion API');
  assert.equal(typeof h.level, 'number');
  await adminOps.registerSensor({ serialNumber: 'imq-0200' });
  assert.equal(adminOps.snapshot().sensors.find((s) => s.id === 'IMQ-0200').effectiveStatus, 'UNASSIGNED');
  await assert.rejects(adminOps.updateSensor('IMQ-0200', { householdId: 'H-102' }), /already has sensor/);
  await adminOps.updateSensor('IMQ-0100', { householdId: null });
  await adminOps.updateSensor('IMQ-0200', { householdId: 'H-102' });
  h = adminOps.snapshot().households['H-102'];
  assert.equal(h.sensor.id, 'IMQ-0200');
  await adminOps.updateSensor('IMQ-0200', { status: 'SERVICE_REQUIRED' });
  assert.equal(adminOps.snapshot().households['H-102'].monitor, 'SERVICE_REQUIRED');
});

// ---------------- CROSS ROLE ----------------
test('FLOW 1 — resident low-water report persists → admin sees HIGH priority → driver route reorders', async () => {
  await reset();
  const resident = await role();
  const driverBefore = resident.snapshot().trucks.find((t) => t.id === 'T2').today;
  assert.notEqual(driverBefore[0], 'H-031');
  await resident.reportLowWater('H-031');
  const rows = (await server.db.query(`SELECT * FROM low_water_reports WHERE household_id = 'H-031' AND resolved_at IS NULL`)).rows;
  assert.equal(rows.length, 1, 'persisted centrally');
  const adminOps = await role('2026');
  const h = adminOps.snapshot().households['H-031'];
  assert.equal(h.priority.level, 'HIGH');
  assert.ok(h.lowWaterReported && h.priority.reasons.includes('lowWater'));
  const driver = await role();
  assert.equal(driver.snapshot().trucks.find((t) => t.id === 'T2').today[0], 'H-031');
  await resident.reportLowWater('H-031');
  assert.equal((await server.db.query(`SELECT count(*)::int n FROM low_water_reports WHERE household_id = 'H-031'`)).rows[0].n, 1, 'idempotent');
});

test('FLOW 2 — driver delivery persists → truck water, report resolved, resident tank + history, admin updated', async () => {
  await reset();
  const resident = await role();
  await resident.reportLowWater('H-031');
  const driver = await role();
  const est = driver.snapshot().households['H-031'].estLitres;
  await driver.confirmDelivery({ householdId: 'H-031', truckId: 'T2', litres: est });
  const rec = (await server.db.query(`SELECT * FROM deliveries WHERE household_id = 'H-031' ORDER BY delivered_at DESC LIMIT 1`)).rows[0];
  assert.equal(rec.litres, est);
  assert.equal(rec.truck_id, 'T2');
  assert.equal((await server.db.query(`SELECT current_water_l FROM trucks WHERE id = 'T2'`)).rows[0].current_water_l, 6800 - est);
  await resident.refresh();
  const h = resident.snapshot().households['H-031'];
  assert.ok(h.level > 90, `tank ${h.level}`);
  assert.equal(h.lowWaterReported, false);
  assert.equal(h.lastDelivery.litres, est);
  assert.ok(h.analysis.events.some((e) => e.type === 'delivery'), 'monitor reading shows the fill');
  const adminOps = await role('2026');
  assert.notEqual(adminOps.snapshot().households['H-031'].priority.level, 'HIGH');
  assert.ok(adminOps.snapshot().log.some((l) => l.type === 'delivery' && l.householdId === 'H-031'));
  await assert.rejects(driver.confirmDelivery({ householdId: 'H-031', truckId: 'T2', litres: 999999 }));
});

test('FLOW 3 — truck breakdown → admin 2/3, ops alert, routes recalculated, household reassigned', async () => {
  await reset();
  const driver = await role();
  await driver.reportTruckProblem('T2');
  const adminOps = await role('2026');
  const s = adminOps.snapshot();
  assert.equal(s.kpis.trucksOperating, 2);
  assert.equal(s.opsAlerts.length, 1);
  assert.deepEqual([...s.opsAlerts[0].affected].sort(), ['H-012', 'H-031', 'H-037', 'H-063', 'H-085']);
  assert.equal(s.trucks.find((t) => t.id === 'T2').today.length, 0);
  const h012 = s.households['H-012'];
  assert.equal(h012.plan.reassigned, true);
  assert.ok(['T1', 'T3'].includes(h012.plan.truckId));
  await assert.rejects(driver.confirmDelivery({ householdId: 'H-031', truckId: 'T2', litres: 100 }), /out of service/);
  await driver.restoreTruck('T2');
  assert.equal((await role()).snapshot().households['H-012'].plan.truckId, 'T2');
});

test('FLOW 4 — admin alert persists → resident sees it; advisory → ACTION; all clear ends notices', async () => {
  await reset();
  const adminOps = await role('2026');
  await adminOps.createAlert({ type: 'delay', note: 'Road works' });
  const resident = await role();
  assert.deepEqual(resident.snapshot().alerts.map((a) => a.type), ['delay']);
  assert.equal(resident.snapshot().households['H-012'].status, STATUS.NORMAL, 'a delay notice is not a water-quality status');
  await adminOps.createAlert({ type: 'advisory' });
  await resident.refresh();
  assert.equal(resident.snapshot().households['H-012'].status, STATUS.ACTION);
  await adminOps.createAlert({ type: 'all_clear' });
  await resident.refresh();
  assert.deepEqual(resident.snapshot().alerts.map((a) => a.type), ['all_clear']);
  assert.equal(resident.snapshot().households['H-012'].status, STATUS.NORMAL);
  const resRepo = new ApiRepository({ baseUrl: base });
  await assert.rejects(resRepo.createAlert({ type: 'delay' }), /Municipality access required/);
});

test('REFILL: return to plant refills the truck from village water', async () => {
  await reset();
  const driver = await role();
  await driver.returnToPlant('T2');
  const s = driver.snapshot();
  assert.equal(s.trucks.find((t) => t.id === 'T2').remainingLitres, 10000);
  assert.equal(s.kpis.villageWaterCubicMetres, 316.8);
});

test('OFFLINE: the store keeps the last synced state read-only and reports it honestly', async () => {
  await reset();
  const backend = memoryBackend();
  const online = createOperationalStore({ repository: new ApiRepository({ baseUrl: base }), storage: createStorage(backend) });
  await online.init();
  const offlineRepo = new ApiRepository({ baseUrl: base, fetchImpl: async () => { throw new TypeError('network'); } });
  const offline = createOperationalStore({ repository: offlineRepo, storage: createStorage(backend) });
  await offline.init();
  assert.equal(offline.sync.online, false);
  assert.ok(offline.sync.lastSync);
  assert.equal(Object.keys(offline.snapshot().households).length, 12);
  await assert.rejects(offline.reportLowWater('H-031'), (e) => e.offline === true, 'actions are not faked offline');
});
