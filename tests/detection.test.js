import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, detectDelivery, recommendFromCheck, isValidValue,
  STATUS, PARAM, SENSORS,
} from '../js/detection.js';

const NOW = Date.UTC(2026, 8, 26, 15, 0, 0);
const base = { turbidity: 0.4, conductivity: 85, temperature: 14 };
const reading = (over = {}) => ({ timestamp: NOW, turbidity: 0.4, conductivity: 85, temperature: 14, tankLevel: 82, ...over });

test('1. normal sensor values => NORMAL', () => {
  const r = evaluate(reading(), base, { now: NOW });
  assert.equal(r.status, STATUS.NORMAL);
  assert.deepEqual(r.changed, []);
  for (const k of SENSORS) assert.equal(r.params[k].state, PARAM.NORMAL);
});

test('2. meaningful deviation => CHECK (turbidity)', () => {
  const r = evaluate(reading({ turbidity: 2.1 }), base, { now: NOW });
  assert.equal(r.status, STATUS.CHECK);
  assert.deepEqual(r.changed, ['turbidity']);
  assert.equal(r.params.conductivity.state, PARAM.NORMAL);
});

test('2b. meaningful deviation => CHECK (conductivity drop)', () => {
  const r = evaluate(reading({ conductivity: 60 }), base, { now: NOW });
  assert.equal(r.status, STATUS.CHECK);
  assert.deepEqual(r.changed, ['conductivity']);
});

test('2c. a single MAJOR deviation alone is CHECK, not ACTION', () => {
  const r = evaluate(reading({ turbidity: 9 }), base, { now: NOW });
  assert.equal(r.status, STATUS.CHECK);
});

test('2d. small fluctuations stay NORMAL', () => {
  const r = evaluate(reading({ turbidity: 0.9, conductivity: 95, temperature: 17 }), base, { now: NOW });
  assert.equal(r.status, STATUS.NORMAL);
});

test('3. multiple major deviations => ACTION', () => {
  const r = evaluate(reading({ turbidity: 6.5, conductivity: 190 }), base, { now: NOW });
  assert.equal(r.status, STATUS.ACTION);
  assert.ok(r.reasons.includes('multiple_major_deviations'));
});

test('4. official advisory => ACTION even with normal sensors', () => {
  const r = evaluate(reading(), base, { now: NOW, advisory: true });
  assert.equal(r.status, STATUS.ACTION);
  assert.equal(r.reasons[0], 'official_advisory');
});

test('4b. advisory + sensor failure => ACTION (never less cautious) and fault still reported', () => {
  const r = evaluate(reading({ turbidity: null }), base, { now: NOW, advisory: true });
  assert.equal(r.status, STATUS.ACTION);
  assert.ok(r.reasons.includes('sensor_invalid:turbidity'));
  assert.equal(r.sensorFault, true);
});

test('5. missing critical sensor => SYSTEM_CHECK', () => {
  for (const k of SENSORS) {
    const rd = reading();
    delete rd[k];
    assert.equal(evaluate(rd, base, { now: NOW }).status, STATUS.SYSTEM_CHECK, k);
    assert.equal(evaluate(reading({ [k]: null }), base, { now: NOW }).status, STATUS.SYSTEM_CHECK, k);
  }
});

test('6. NaN / Infinity / string / out-of-range sensor => SYSTEM_CHECK', () => {
  for (const bad of [NaN, Infinity, -Infinity, '0.4', -3, 99999, undefined, {}, true]) {
    assert.equal(evaluate(reading({ turbidity: bad }), base, { now: NOW }).status, STATUS.SYSTEM_CHECK, String(bad));
  }
});

test('6b. missing reading, missing baseline, stale or future timestamp => SYSTEM_CHECK', () => {
  assert.equal(evaluate(null, base, { now: NOW }).status, STATUS.SYSTEM_CHECK);
  assert.equal(evaluate(undefined, undefined, { now: NOW }).status, STATUS.SYSTEM_CHECK);
  assert.equal(evaluate(reading(), null, { now: NOW }).status, STATUS.SYSTEM_CHECK);
  assert.equal(evaluate(reading(), { ...base, conductivity: NaN }, { now: NOW }).status, STATUS.SYSTEM_CHECK);
  assert.equal(evaluate(reading({ timestamp: NOW - 31 * 60_000 }), base, { now: NOW }).status, STATUS.SYSTEM_CHECK);
  assert.equal(evaluate(reading({ timestamp: NOW + 60 * 60_000 }), base, { now: NOW }).status, STATUS.SYSTEM_CHECK);
  assert.equal(evaluate(reading({ timestamp: undefined }), base, { now: NOW }).status, STATUS.SYSTEM_CHECK);
});

test('7. sensor failure can NEVER return NORMAL (property test, deterministic PRNG)', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const bads = [null, undefined, NaN, Infinity, -100, 1e9, 'x'];
  for (let i = 0; i < 5000; i++) {
    const rd = {
      timestamp: NOW,
      turbidity: rand() * 20,
      conductivity: 1 + rand() * 400,
      temperature: rand() * 40,
      tankLevel: rand() * 100,
    };
    const broken = SENSORS[Math.floor(rand() * SENSORS.length)];
    rd[broken] = bads[Math.floor(rand() * bads.length)];
    const r = evaluate(rd, base, { now: NOW, advisory: rand() < 0.2 });
    assert.notEqual(r.status, STATUS.NORMAL);
    assert.notEqual(r.status, STATUS.CHECK);
    assert.ok(r.status === STATUS.SYSTEM_CHECK || r.status === STATUS.ACTION);
  }
});

test('8. delivery/fill event is detected', () => {
  assert.equal(detectDelivery(21, 96), true);
  assert.equal(detectDelivery(70, 85), true); // exactly threshold
  assert.equal(detectDelivery(82, 90), false); // small rise (sensor noise)
  assert.equal(detectDelivery(96, 21), false); // consumption
  assert.equal(detectDelivery(null, 96), false);
  assert.equal(detectDelivery(NaN, 96), false);
});

test('water check recommendations never certify safety', () => {
  assert.equal(recommendFromCheck({ appearance: 'no', smell: 'no', chlorine: 'not_tested' }, STATUS.NORMAL), 'nothing_unusual');
  assert.equal(recommendFromCheck({ appearance: 'cloudy', smell: 'no' }, STATUS.NORMAL), 'contact_services');
  assert.equal(recommendFromCheck({ appearance: 'no', smell: 'yes' }, STATUS.NORMAL), 'contact_services');
  assert.equal(recommendFromCheck({ appearance: 'no', smell: 'no', chlorine: 'low' }, STATUS.NORMAL), 'contact_services');
  assert.equal(recommendFromCheck({ appearance: 'no', smell: 'no' }, STATUS.CHECK), 'keep_watching');
  assert.equal(recommendFromCheck({ appearance: 'no', smell: 'no' }, STATUS.ACTION), 'follow_guidance');
  assert.equal(recommendFromCheck({ appearance: 'no', smell: 'no' }, STATUS.SYSTEM_CHECK), 'monitor_service');
  assert.equal(recommendFromCheck(null, STATUS.NORMAL), 'nothing_unusual');
});

test('isValidValue', () => {
  assert.equal(isValidValue(0, [0, 1]), true);
  assert.equal(isValidValue(NaN, [0, 1]), false);
  assert.equal(isValidValue('1', [0, 5]), false);
});
