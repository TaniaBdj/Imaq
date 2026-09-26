import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFromDistance, distanceFromLevel, litresFromLevel, estimateConsumption, daysRemaining, daysBucket } from '../js/core/tank.js';
import { normalizeSensorPayload, makeSensorPayload } from '../js/sensor-data.js';

const H = 3600_000;

test('TANK: level from top-mounted distance sensor', () => {
  assert.equal(levelFromDistance(150, 150), 0, 'empty');
  assert.equal(levelFromDistance(112.5, 150), 25);
  assert.equal(levelFromDistance(75, 150), 50);
  assert.equal(levelFromDistance(0, 150), 100, 'full');
  assert.equal(Math.round(levelFromDistance(102, 150)), 32, 'spec example: 150 cm tank, 102 cm → 32%');
  assert.equal(levelFromDistance(155, 150), 0, 'small overshoot clamps to 0');
});

test('TANK: invalid dimensions / readings → null (UNKNOWN), never 0', () => {
  for (const [d, h] of [[50, 0], [50, -10], [50, NaN], [NaN, 150], [null, 150], [undefined, 150], ['50', 150], [-1, 150], [500, 150]]) {
    assert.equal(levelFromDistance(d, h), null, `${d}/${h}`);
  }
  assert.equal(distanceFromLevel(25, 150), 112.5);
  assert.equal(distanceFromLevel(null, 150), null);
});

test('VOLUME: estimated litres', () => {
  assert.equal(litresFromLevel(32, 2000), 640);
  assert.equal(litresFromLevel(0, 2000), 0, 'EMPTY is 0 litres');
  assert.equal(litresFromLevel(null, 2000), null, 'UNKNOWN stays unknown');
  assert.equal(litresFromLevel(50, 0), null);
});

test('CONSUMPTION: measured from declining tank', () => {
  const series = Array.from({ length: 25 }, (_, i) => ({ ts: i * H, litres: 1500 - i * 12.5 })); // 300 L/day
  assert.deepEqual(estimateConsumption(series, 200), { litresPerDay: 300, source: 'measured', hours: 24 });
});

test('CONSUMPTION: a delivery rise is excluded, not counted as negative use', () => {
  const series = [];
  for (let i = 0; i <= 12; i++) series.push({ ts: i * H, litres: 800 - i * 10 }); // 240 L/day
  series.push({ ts: 13 * H, litres: 1900 }); // truck fill
  for (let i = 14; i <= 26; i++) series.push({ ts: i * H, litres: 1900 - (i - 13) * 10 });
  const c = estimateConsumption(series, 100);
  assert.equal(c.source, 'measured');
  assert.equal(c.litresPerDay, 240);
});

test('CONSUMPTION: falls back to configured use with insufficient history; unknown without either', () => {
  assert.deepEqual(estimateConsumption([{ ts: 0, litres: 500 }, { ts: H, litres: 490 }], 250), { litresPerDay: 250, source: 'configured' });
  assert.deepEqual(estimateConsumption([], 250), { litresPerDay: 250, source: 'configured' });
  assert.deepEqual(estimateConsumption([{ ts: 0, litres: null }, { ts: 20 * H, litres: null }], 250), { litresPerDay: 250, source: 'configured' });
  assert.deepEqual(estimateConsumption([], 0), { litresPerDay: null, source: 'unknown' });
});

test('DAYS REMAINING: normal, less than one day, unknown, invalid use', () => {
  assert.equal(daysRemaining(1560, 260), 6);
  assert.deepEqual(daysBucket(5.8), { kind: 'about', n: 6 });
  assert.deepEqual(daysBucket(1.4), { kind: 'about', n: 1 });
  assert.deepEqual(daysBucket(0.6), { kind: 'lessThanOne' });
  assert.equal(daysRemaining(0, 250), 0, 'EMPTY → 0 days (known)');
  assert.deepEqual(daysBucket(0), { kind: 'lessThanOne' });
  assert.equal(daysRemaining(null, 250), null, 'UNKNOWN → null, never 0');
  assert.deepEqual(daysBucket(null), { kind: 'unknown' });
  assert.equal(daysRemaining(500, 0), null);
  assert.equal(daysRemaining(500, NaN), null);
});

const NOW = Date.parse('2026-09-26T13:00:00Z');
const valid = () => ({ deviceId: 'IMQ-0031', timestamp: '2026-09-26T13:00:00Z', tank: { distanceCm: 102 }, water: { turbidity: 0.42, conductivity: 87, temperature: 13.8 }, device: { batteryPercent: 84 } });

test('SENSOR PAYLOAD: canonical payload validates and normalizes', () => {
  const r = normalizeSensorPayload(valid(), { now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reading, { deviceId: 'IMQ-0031', recordedAt: NOW, distanceCm: 102, turbidity: 0.42, conductivity: 87, temperature: 13.8, batteryPercent: 84 });
  assert.deepEqual(makeSensorPayload({ deviceId: 'IMQ-0031', ts: NOW, distanceCm: 102, turbidity: 0.42, conductivity: 87, temperature: 13.8, batteryPercent: 84 }), { ...valid(), timestamp: '2026-09-26T13:00:00.000Z' });
});

test('SENSOR PAYLOAD: malformed input is rejected (never silently NORMAL)', () => {
  const bad = (mut) => { const p = valid(); mut(p); return normalizeSensorPayload(p, { now: NOW }); };
  assert.equal(bad((p) => { p.timestamp = 'yesterday'; }).ok, false, 'invalid timestamp');
  assert.equal(bad((p) => { p.timestamp = '2026-09-27T13:00:00Z'; }).ok, false, 'future timestamp');
  assert.equal(bad((p) => { delete p.tank; }).ok, false, 'missing distance');
  assert.equal(bad((p) => { p.tank.distanceCm = 'NaN'; }).ok, false, 'non-numeric distance');
  assert.equal(bad((p) => { p.tank.distanceCm = -5; }).ok, false, 'impossible distance');
  assert.equal(bad((p) => { p.water.turbidity = 'abc'; }).ok, false, 'malformed water value');
  assert.equal(bad((p) => { p.device.batteryPercent = 140; }).ok, false, 'unreasonable battery');
  assert.equal(bad((p) => { p.deviceId = ''; }).ok, false, 'missing device');
  assert.equal(normalizeSensorPayload(null).ok, false);
  assert.equal(normalizeSensorPayload([1, 2]).ok, false);
  // A water value explicitly null = sensor fault → accepted as null (detection → SYSTEM CHECK)
  const faulty = bad((p) => { p.water.turbidity = null; });
  assert.equal(faulty.ok, true);
  assert.equal(faulty.reading.turbidity, null);
});
