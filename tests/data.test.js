import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JsonSensorProvider } from '../js/providers/json-provider.js';
import { normalizeReading, normalizeReadings } from '../js/sensor-data.js';
import { analyze } from '../js/analysis.js';
import { STATUS } from '../js/detection.js';
import { buildAll } from '../tools/generate-data.mjs';
import { fsFetch, makeClock, NOW, ROOT } from './helpers.js';

const ANCHOR = NOW - 2 * 60_000;

async function connect(opts = {}) {
  const clock = opts.clock || makeClock();
  const p = new JsonSensorProvider({ baseUrl: 'data/', fetchImpl: fsFetch(opts.overrides), clock, waterAddedFeed: opts.feed });
  await p.connect();
  p.setAnchor(ANCHOR);
  return { p, clock };
}
const statusOf = (p, id, now = NOW) => analyze(p.getRecentReadings(id, now), p.getHousehold(id).baseline, { now }).current.status;
const readingsFile = async () => JSON.parse(await readFile(new URL('data/readings.json', ROOT), 'utf8'));

test('1. JSON data loads correctly', async () => {
  const { p } = await connect();
  assert.equal(p.getHouseholdIds().length, 12);
  const h = p.getHousehold('H-031');
  assert.equal(h.assignedTruck, 'T2');
  assert.equal(h.tankCapacityLitres, 1500);
  assert.equal(h.occupants, 4);
  assert.equal(h.vulnerability, 'elder');
  assert.equal(h.deliveryIntervalDays, 4);
  assert.equal(p.rejected, 0);
  assert.deepEqual(p.getConnection('H-012'), { deviceId: 'IMQ-0012', transport: 'recorded-data' });
});

test('2. latest reading is the newest one, replayed at the anchor', async () => {
  const { p } = await connect();
  const latest = p.getLatestReading('H-012');
  const all = p.getRecentReadings('H-012');
  assert.equal(latest.timestamp, Math.max(...all.map((r) => r.timestamp)));
  assert.equal(latest.timestamp, ANCHOR);
  assert.equal(latest.tankLevel, 78.2);
});

test('3. readings are chronologically sorted even if the file is shuffled', async () => {
  const file = await readingsFile();
  const list = [...file.households['H-012']].reverse();
  [list[3], list[50]] = [list[50], list[3]];
  file.households['H-012'] = list;
  const { p } = await connect({ overrides: { 'data/readings.json': file } });
  const ts = p.getRecentReadings('H-012').map((r) => r.timestamp);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  assert.equal(p.getLatestReading('H-012').tankLevel, 78.2);
});

test('4. malformed readings fail safely (never NORMAL)', async () => {
  const file = await readingsFile();
  const list = file.households['H-012'];
  list[list.length - 1].turbidity = 'abc';
  list.splice(10, 0, null, 42, 'garbage', { timestamp: 'not a date', turbidity: 0.4 });
  const { p } = await connect({ overrides: { 'data/readings.json': file } });
  assert.equal(p.rejected, 4);
  assert.equal(p.getLatestReading('H-012').turbidity, null);
  assert.equal(statusOf(p, 'H-012'), STATUS.SYSTEM_CHECK);
});

test('5. missing readings / missing files fail safely', async () => {
  const file = await readingsFile();
  file.households['H-012'] = [];
  const { p } = await connect({ overrides: { 'data/readings.json': file } });
  assert.equal(p.getLatestReading('H-012'), null);
  assert.equal(statusOf(p, 'H-012'), STATUS.SYSTEM_CHECK);
  const broken = new JsonSensorProvider({ baseUrl: 'data/', fetchImpl: fsFetch({ 'data/readings.json': 404 }), clock: makeClock() });
  await assert.rejects(broken.connect());
  assert.equal(normalizeReading({ timestamp: '2026-09-26T10:00:00', turbidity: 0.4 }).tankLevel, null);
});

test('6. detection engine receives normalized data', async () => {
  const { p } = await connect();
  for (const id of p.getHouseholdIds()) {
    for (const r of p.getRecentReadings(id)) {
      assert.deepEqual(Object.keys(r).sort(), ['conductivity', 'tankLevel', 'temperature', 'timestamp', 'turbidity']);
      assert.equal(typeof r.timestamp, 'number');
      for (const k of ['turbidity', 'conductivity', 'temperature', 'tankLevel']) assert.ok(typeof r[k] === 'number' || r[k] === null);
    }
  }
  assert.deepEqual(normalizeReading({ timestamp: 5, turbidity: NaN, conductivity: Infinity, temperature: '14', tankLevel: 50 }),
    { timestamp: 5, turbidity: null, conductivity: null, temperature: null, tankLevel: 50 });
  assert.equal(normalizeReadings('nope').readings.length, 0);
});

test('7. recorded delivery and historical anomaly are derived from the readings', async () => {
  const { p } = await connect();
  const a = analyze(p.getRecentReadings('H-012'), p.getHousehold('H-012').baseline, { now: NOW });
  const deliveries = a.events.filter((e) => e.type === 'delivery');
  assert.equal(deliveries.length, 1);
  assert.equal(Math.round(deliveries[0].to), 96);
  assert.equal(deliveries[0].baselineUpdated, true);
  const statuses = a.events.filter((e) => e.type === 'status').sort((x, y) => x.ts - y.ts);
  assert.deepEqual(statuses.map((e) => e.status), [STATUS.CHECK, STATUS.NORMAL]);
  assert.equal(a.current.status, STATUS.NORMAL);
});

test('each synthetic household produces its intended status', async () => {
  const { p } = await connect();
  const want = { 'H-012': 'NORMAL', 'H-024': 'CHECK', 'H-031': 'NORMAL', 'H-044': 'SYSTEM_CHECK', 'H-057': 'SYSTEM_CHECK' };
  for (const [id, s] of Object.entries(want)) assert.equal(statusOf(p, id), s, id);
});

test('hardware emulation: readings continue after the anchor, and added water raises the level', async () => {
  const deliveries = [];
  const { p } = await connect({ feed: (id) => deliveries.filter((d) => d.id === id) });
  const later = NOW + 60 * 60_000;
  const before = p.getLatestReading('H-031', later);
  assert.ok(later - before.timestamp < 5 * 60_000);
  assert.ok(before.tankLevel < 24.7);
  deliveries.push({ id: 'H-031', ts: later - 60_000, litres: 1100 });
  const after = p.getLatestReading('H-031', later);
  assert.ok(after.tankLevel > 95);
  // Offline monitor (H-044): no emulated readings → stale
  const off = p.getRecentReadings('H-044', later);
  assert.ok(later - off[off.length - 1].timestamp > 5 * 3600_000);
});

test('every data file is marked synthetic and makes no Inukjuak data claim', () => {
  for (const [name, obj] of Object.entries(buildAll())) {
    assert.equal(obj._meta.synthetic, true, name);
    assert.match(obj._meta.note, /SYNTHETIC/);
    assert.match(obj._meta.note, /No household water-quality data from Inukjuak/);
  }
});

test('data files are exactly reproducible from the deterministic generator', async () => {
  for (const [name, obj] of Object.entries(buildAll())) {
    const onDisk = JSON.parse(await readFile(new URL(`data/${name}`, ROOT), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(obj)), name);
  }
});

test('the app never uses Math.random at runtime', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
      if (e.isDirectory()) await walk(`${dir}${e.name}/`);
      else if (e.name.endsWith('.js')) files.push(`${dir}${e.name}`);
    }
  };
  await walk('js/');
  assert.ok(files.length > 8);
  for (const f of files) assert.ok(!(await readFile(new URL(f, ROOT), 'utf8')).includes('Math.random'), f);
});
