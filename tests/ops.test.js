/**
 * Pure operational engines + role session.
 * (Cross-role flows run against the real API and database in api.test.js.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../js/storage.js';
import { createSession } from '../js/session.js';
import { priorityOf, litresToFill } from '../js/ops/priority.js';
import { planRoutes } from '../js/ops/routes.js';
import { sensorStatus } from '../js/ops/selectors.js';
import { memoryBackend } from './helpers.js';

test('session: role entry, municipality sign-in after API verification, sign out, language', () => {
  const storage = createStorage(memoryBackend());
  const s = createSession(storage);
  assert.equal(s.current.role, null);
  assert.equal(s.signInMunicipality(''), false);
  assert.equal(s.current.role, null);
  assert.equal(s.signInMunicipality('2026'), true);
  assert.equal(s.current.role, 'municipality');
  assert.equal(s.adminPin, '2026');
  s.signInResident('H-031');
  assert.equal(s.adminPin, null, 'PIN is dropped when leaving the municipality role');
  s.setLang('fr');
  const again = createSession(storage);
  assert.equal(again.current.role, 'resident');
  assert.equal(again.current.householdId, 'H-031');
  assert.equal(again.current.lang, 'fr');
  again.signOut();
  assert.equal(again.current.role, null);
  assert.equal(again.current.lastHouseholdId, 'H-031');
});

test('priority: deterministic and explainable', () => {
  assert.equal(litresToFill(24, { tankCapacityLitres: 1500 }), 1150);
  assert.equal(litresToFill(null, { tankCapacityLitres: 1500 }), null);
  assert.deepEqual(priorityOf({ days: 1.5, lowWaterReported: true, vulnerability: 'elder', delayed: false }), { score: -1, level: 'HIGH', reasons: ['days', 'lowWater', 'vulnerability'] });
  assert.deepEqual(priorityOf({ days: 3, lowWaterReported: false, vulnerability: null, delayed: false, overdue: true }), { score: 2.5, level: 'LOW', reasons: ['days', 'overdue'] });
});

test('priority: unknown tank level is planned by schedule — sensor failure never means low water', () => {
  const soon = priorityOf({ days: null, lowWaterReported: false, vulnerability: null, delayed: false, daysUntilDue: 0 });
  assert.equal(soon.reasons[0], 'scheduleOnly');
  assert.equal(soon.level, 'MEDIUM', 'due now: planned, not escalated to HIGH');
  const later = priorityOf({ days: null, lowWaterReported: false, vulnerability: null, delayed: false, daysUntilDue: 3 });
  assert.equal(later.level, 'LOW');
  const overdueUnknown = priorityOf({ days: null, lowWaterReported: false, vulnerability: null, delayed: false, overdue: true, daysUntilDue: -1 });
  assert.ok(!overdueUnknown.reasons.includes('overdue'));
  // A resident's own report still counts even when the sensor is down
  assert.equal(priorityOf({ days: null, lowWaterReported: true, vulnerability: null, delayed: false, daysUntilDue: 1 }).level, 'HIGH');
});

test('routes: sorted by priority, reassignment on truck failure, daily cap, no trucks → delayed', () => {
  const now = Date.UTC(2026, 9, 3, 12);
  const hs = [
    { id: 'A', assignedTruck: 'T1', score: 1, priorityLevel: 'MEDIUM', dueTs: now, servedToday: false },
    { id: 'B', assignedTruck: 'T1', score: 0.2, priorityLevel: 'HIGH', dueTs: now + 5 * 86_400_000, servedToday: false },
    { id: 'C', assignedTruck: 'T2', score: 3, priorityLevel: 'LOW', dueTs: now, servedToday: false },
  ];
  const r = planRoutes({ households: hs, trucks: [{ id: 'T1', status: 'OPERATING' }, { id: 'T2', status: 'OUT_OF_SERVICE' }], now });
  assert.deepEqual(r.routes.T1.today, ['B', 'A', 'C']);
  assert.equal(r.plan.C.reassigned, true);
  assert.deepEqual(r.affected, ['C']);
  const capped = planRoutes({ households: hs, trucks: [{ id: 'T1', status: 'OPERATING' }, { id: 'T2', status: 'OPERATING' }], now, maxStopsPerDay: 1 });
  assert.equal(capped.plan.A.when, 'tomorrow');
  assert.equal(capped.plan.A.delayed, true);
  const none = planRoutes({ households: hs, trucks: [{ id: 'T1', status: 'OUT_OF_SERVICE' }], now });
  assert.equal(none.plan.A.when, 'delayed');
  const served = planRoutes({ households: [{ ...hs[0], servedToday: true }], trucks: [{ id: 'T1', status: 'OPERATING' }], now });
  assert.deepEqual(served.routes.T1.today, []);
});

test('sensor status: not installed, unassigned, service, online, stale, offline', () => {
  const now = Date.UTC(2026, 9, 3, 12);
  assert.equal(sensorStatus(null, now), 'NOT_INSTALLED');
  assert.equal(sensorStatus({ householdId: null }, now), 'UNASSIGNED');
  assert.equal(sensorStatus({ householdId: 'H', status: 'SERVICE_REQUIRED', lastSeen: now }, now), 'SERVICE_REQUIRED');
  assert.equal(sensorStatus({ householdId: 'H', status: 'ONLINE', lastSeen: now - 60_000 }, now), 'ONLINE');
  assert.equal(sensorStatus({ householdId: 'H', status: 'ONLINE', lastSeen: now - 3600_000 }, now), 'STALE');
  assert.equal(sensorStatus({ householdId: 'H', status: 'ONLINE', lastSeen: now - 5 * 3600_000 }, now), 'OFFLINE');
  assert.equal(sensorStatus({ householdId: 'H', status: 'ONLINE', lastSeen: null }, now), 'OFFLINE');
});
