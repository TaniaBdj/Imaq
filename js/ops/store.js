/**
 * OperationalStore — the ONE shared operational state for residents, drivers and
 * the municipality, backed by a Repository (ApiRepository → Imaq API → PostgreSQL).
 *
 *   UI ─► OperationalStore ─► Repository ─► API ─► PostgreSQL
 *                │
 *                └─► selectors (pure): sensors → detection, tank litres, consumption,
 *                    days remaining, priority, routes
 *
 * Offline: the last synced state is kept on the device and shown read-only with its
 * sync time. Actions need a connection — nothing is silently queued or faked.
 * Water checks are private to the device (localStorage) by design.
 */
import { recommendFromCheck } from '../detection.js';
import { buildSnapshot } from './selectors.js';

export const CACHE_KEY = 'imaq.cache.v2';
export const CHECKS_KEY = 'imaq.checks.v1';
export const ALERT_TYPES = ['advisory', 'delay', 'conserve', 'all_clear'];

let idCounter = 0;

export function createOperationalStore({ repository, storage, clock = () => Date.now() }) {
  let data = null;
  let sync = { online: true, lastSync: null, error: null };
  let checks = Array.isArray(storage.load(CHECKS_KEY)) ? storage.load(CHECKS_KEY) : [];
  let snapshot = null;
  let snapshotKey = '';
  let version = 0;
  const listeners = new Set();
  const emit = () => {
    snapshot = null;
    version += 1;
    for (const fn of listeners) fn();
  };

  async function refresh() {
    try {
      data = await repository.load();
      sync = { online: true, lastSync: clock(), error: null };
      storage.save(CACHE_KEY, { savedAt: sync.lastSync, data });
    } catch (e) {
      const cached = storage.load(CACHE_KEY);
      if (cached && cached.data && (!data || e.offline)) data = data || cached.data;
      sync = { online: false, lastSync: sync.lastSync || (cached && cached.savedAt) || null, error: e.offline ? 'offline' : e.message };
      if (!data) throw e;
    }
    emit();
  }

  async function act(fn) {
    const out = await fn();
    await refresh();
    return out;
  }

  const store = {
    get sync() { return sync; },
    get data() { return data; },
    get checks() { return checks; },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    init: refresh,
    refresh,
    /** Derived operational picture (memoised per state change and minute). */
    snapshot() {
      const now = clock();
      const key = `${version}|${Math.floor(now / 60_000)}`;
      if (!snapshot || snapshotKey !== key) {
        snapshot = buildSnapshot({ data, now, checks });
        snapshotKey = key;
      }
      return snapshot;
    },
    tick() {
      return refresh().catch(() => {});
    },
    verifyAdminPin: (pin) => repository.verifyAdminPin(pin),

    // resident
    reportLowWater: (householdId) => act(() => repository.reportLowWater(householdId)),
    saveCheck(householdId, answers) {
      const now = clock();
      const status = store.snapshot().households[householdId].status;
      const recommendation = recommendFromCheck(answers, status);
      idCounter += 1;
      const record = { id: `C-${now.toString(36)}-${idCounter}`, householdId, ts: now, answers: { ...answers }, recommendation, statusAtCheck: status };
      checks = [record, ...checks].slice(0, 200);
      storage.save(CHECKS_KEY, checks);
      emit();
      return record;
    },
    // driver
    confirmDelivery: (d) => act(() => repository.confirmDelivery(d)),
    returnToPlant: (truckId) => act(() => repository.refillTruck(truckId)),
    reportTruckProblem: (truckId) => act(() => repository.setTruckStatus(truckId, 'OUT_OF_SERVICE')),
    restoreTruck: (truckId) => act(() => repository.setTruckStatus(truckId, 'IN_SERVICE')),
    // municipality
    createAlert: ({ type, note = '' }) => act(() => repository.createAlert({ type, message: note })),
    endAlert: (id) => act(() => repository.endAlert(id)),
    saveHousehold: (h, isNew) => act(() => repository.saveHousehold(h, isNew)),
    archiveHousehold: (id, archived = true) => act(() => repository.archiveHousehold(id, archived)),
    saveTruck: (t, isNew) => act(() => repository.saveTruck(t, isNew)),
    archiveTruck: (id, archived = true) => act(() => repository.archiveTruck(id, archived)),
    registerSensor: (s) => act(() => repository.registerSensor(s)),
    updateSensor: (id, patch) => act(() => repository.updateSensor(id, patch)),
  };
  return store;
}
