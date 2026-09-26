/**
 * Synthetic seed data (data/*.json) → normalization → analysis.
 * The seed is what `server/seed.mjs` loads into PostgreSQL; these tests check it
 * directly, evaluated at the end of the recording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { normalizeReading, normalizeReadings, parseTimestamp } from '../js/sensor-data.js';
import { analyze } from '../js/analysis.js';
import { STATUS } from '../js/detection.js';
import { buildAll } from '../tools/generate-data.mjs';
import { ROOT } from './helpers.js';

const load = async (name) => JSON.parse(await readFile(new URL(`data/${name}`, ROOT), 'utf8'));

async function seed() {
  const [hh, rd] = await Promise.all([load('households.json'), load('readings.json')]);
  const end = parseTimestamp(rd._meta.recordingEnd);
  const baseline = Object.fromEntries(hh.households.map((h) => [h.id, h.baseline]));
  const readings = (id) => normalizeReadings(rd.households[id]).readings;
  const statusOf = (id, list = readings(id)) => analyze(list, baseline[id], { now: end }).current.status;
  return { hh, rd, end, baseline, readings, statusOf };
}

test('seed: 12 households, each with a sensor and a 48 h reading history', async () => {
  const { hh, rd } = await seed();
  assert.equal(hh.households.length, 12);
  const h = hh.households.find((x) => x.id === 'H-031');
  assert.deepEqual([h.assignedTruck, h.tankCapacityLitres, h.occupants, h.vulnerability, h.deliveryIntervalDays], ['T2', 1500, 4, 'elder', 4]);
  for (const x of hh.households) assert.ok(rd.households[x.id].length > 80, x.id);
});

test('normalization: readings are sorted chronologically even if the input is shuffled', async () => {
  const { rd } = await seed();
  const list = [...rd.households['H-012']].reverse();
  [list[3], list[50]] = [list[50], list[3]];
  const ts = normalizeReadings(list).readings.map((r) => r.timestamp);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test('normalization: malformed entries are rejected and invalid values become null (never NORMAL)', async () => {
  const { rd, statusOf } = await seed();
  const list = structuredClone(rd.households['H-012']);
  list[list.length - 1].turbidity = 'abc';
  list.splice(10, 0, null, 42, 'garbage', { timestamp: 'not a date', turbidity: 0.4 });
  const { readings, rejected } = normalizeReadings(list);
  assert.equal(rejected, 4);
  assert.equal(readings[readings.length - 1].turbidity, null);
  assert.equal(statusOf('H-012', readings), STATUS.SYSTEM_CHECK);
  assert.equal(statusOf('H-012', []), STATUS.SYSTEM_CHECK, 'no readings → SYSTEM CHECK');
  assert.deepEqual(normalizeReading({ timestamp: 5, turbidity: NaN, conductivity: Infinity, temperature: '14', tankLevel: 50 }),
    { timestamp: 5, turbidity: null, conductivity: null, temperature: null, tankLevel: 50 });
  assert.equal(normalizeReading({ timestamp: '2026-09-26T10:00:00', turbidity: 0.4 }).tankLevel, null);
  assert.equal(normalizeReadings('nope').readings.length, 0);
});

test('analysis: the recorded delivery and the historical turbidity episode are derived from readings', async () => {
  const { readings, baseline, end } = await seed();
  const a = analyze(readings('H-012'), baseline['H-012'], { now: end });
  const deliveries = a.events.filter((e) => e.type === 'delivery');
  assert.equal(deliveries.length, 1);
  assert.equal(Math.round(deliveries[0].to), 96);
  assert.equal(deliveries[0].baselineUpdated, true);
  const statuses = a.events.filter((e) => e.type === 'status').sort((x, y) => x.ts - y.ts);
  assert.deepEqual(statuses.map((e) => e.status), [STATUS.CHECK, STATUS.NORMAL]);
  assert.equal(a.current.status, STATUS.NORMAL);
});

test('each synthetic household produces its intended status', async () => {
  const { statusOf } = await seed();
  const want = { 'H-012': 'NORMAL', 'H-024': 'CHECK', 'H-031': 'NORMAL', 'H-044': 'SYSTEM_CHECK', 'H-057': 'SYSTEM_CHECK' };
  for (const [id, s] of Object.entries(want)) assert.equal(statusOf(id), s, id);
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
    assert.deepEqual(await load(name), JSON.parse(JSON.stringify(obj)), name);
  }
});

test('the app never uses Math.random at runtime', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
      if (e.isDirectory()) await walk(`${dir}${e.name}/`);
      else if (/\.m?js$/.test(e.name)) files.push(`${dir}${e.name}`);
    }
  };
  await walk('js/');
  await walk('server/');
  assert.ok(files.length > 8);
  for (const f of files) assert.ok(!(await readFile(new URL(f, ROOT), 'utf8')).includes('Math.random'), f);
});
