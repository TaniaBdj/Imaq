/**
 * SENSOR BOUNDARY — normalization shared by every sensor provider.
 *
 * Whatever the source (recorded JSON today, ESP32 over Bluetooth later), a
 * provider must hand the rest of the app readings in exactly this shape:
 *
 *   NormalizedReading {
 *     timestamp:    number   // ms since epoch; NaN if unknown
 *     turbidity:    number | null   // NTU
 *     conductivity: number | null   // µS/cm
 *     temperature:  number | null   // °C
 *     tankLevel:    number | null   // % full
 *   }
 *
 * Anything that is not a finite number becomes null. The detection engine
 * treats null as "sensor invalid" → SYSTEM_CHECK. Unknown is never normal.
 */

const FIELDS = ['turbidity', 'conductivity', 'temperature', 'tankLevel'];

function toNumberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseTimestamp(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.length >= 10) return Date.parse(v);
  return NaN;
}

/** Normalize one raw reading. Returns null only if `raw` is not an object at all. */
export function normalizeReading(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { timestamp: parseTimestamp(raw.timestamp) };
  for (const f of FIELDS) out[f] = toNumberOrNull(raw[f]);
  return out;
}

/**
 * Normalize a list: drops entries that cannot be placed in time (no object /
 * no valid timestamp), then sorts chronologically (oldest first).
 * Returns { readings, rejected } so providers can report bad input.
 */
export function normalizeReadings(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const readings = [];
  let rejected = 0;
  for (const raw of list) {
    const r = normalizeReading(raw);
    if (r && Number.isFinite(r.timestamp)) readings.push(r);
    else rejected += 1;
  }
  readings.sort((a, b) => a.timestamp - b.timestamp);
  return { readings, rejected };
}

export function normalizeAlerts(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  return list
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      id: String(a.id ?? ''),
      type: String(a.type ?? ''),
      active: a.active === true,
      issuedAt: parseTimestamp(a.issuedAt),
      issuer: typeof a.issuer === 'string' ? a.issuer : '',
    }))
    .filter((a) => Number.isFinite(a.issuedAt));
}

export function normalizeHousehold(raw) {
  const h = raw && typeof raw === 'object' ? raw : {};
  const b = h.baseline && typeof h.baseline === 'object' ? h.baseline : {};
  const pos = (v) => (typeof v === 'number' && v > 0 ? v : null);
  return {
    id: typeof h.id === 'string' ? h.id : '—',
    sensorDevice: typeof h.sensorDevice === 'string' ? h.sensorDevice : '—',
    assignedTruck: typeof h.assignedTruck === 'string' ? h.assignedTruck : null,
    tankCapacityLitres: pos(h.tankCapacityLitres),
    estimatedDailyUseLitres: pos(h.estimatedDailyUseLitres),
    occupants: pos(h.occupants),
    vulnerability: typeof h.vulnerability === 'string' ? h.vulnerability : null,
    deliveryIntervalDays: pos(h.deliveryIntervalDays) || 2,
    baseline: {
      turbidity: toNumberOrNull(b.turbidity),
      conductivity: toNumberOrNull(b.conductivity),
      temperature: toNumberOrNull(b.temperature),
    },
  };
}

/**
 * CANONICAL SENSOR PAYLOAD — the one contract every sensor source uses
 * (SyntheticSensorProvider today, ESP32 gateway in the field):
 *
 *   {
 *     "deviceId": "IMQ-0031",
 *     "timestamp": "2026-09-26T13:00:00Z",
 *     "tank":   { "distanceCm": 102 },
 *     "water":  { "turbidity": 0.42, "conductivity": 87, "temperature": 13.8 },
 *     "device": { "batteryPercent": 84 }
 *   }
 *
 * normalizeSensorPayload() validates it and returns a flat, typed reading or
 * a list of errors. Water values may be null (sensor fault) — they are stored
 * as null and the detection engine turns null into SYSTEM CHECK, never NORMAL.
 * A value that is present but not a finite number is REJECTED (malformed).
 */
export function normalizeSensorPayload(payload, { now = Date.now(), maxFutureMs = 5 * 60_000 } = {}) {
  const errors = [];
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!p) return { ok: false, errors: ['payload must be a JSON object'] };
  const deviceId = typeof p.deviceId === 'string' ? p.deviceId.trim() : '';
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(deviceId)) errors.push('deviceId is required');
  const ts = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
  if (!Number.isFinite(ts)) errors.push('timestamp must be an ISO 8601 date');
  else if (ts > now + maxFutureMs) errors.push('timestamp is in the future');

  const tank = p.tank && typeof p.tank === 'object' ? p.tank : {};
  const water = p.water && typeof p.water === 'object' ? p.water : {};
  const device = p.device && typeof p.device === 'object' ? p.device : {};
  const num = (v, name, min, max, { required = false } = {}) => {
    if (v === undefined || v === null) {
      if (required) errors.push(`${name} is required`);
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${name} must be a number`);
      return null;
    }
    if (v < min || v > max) {
      errors.push(`${name} out of range`);
      return null;
    }
    return v;
  };
  const reading = {
    deviceId,
    recordedAt: ts,
    distanceCm: num(tank.distanceCm, 'tank.distanceCm', 0, 1000, { required: true }),
    turbidity: num(water.turbidity, 'water.turbidity', 0, 1000),
    conductivity: num(water.conductivity, 'water.conductivity', 0, 10000),
    temperature: num(water.temperature, 'water.temperature', -10, 80),
    batteryPercent: num(device.batteryPercent, 'device.batteryPercent', 0, 100),
  };
  return errors.length ? { ok: false, errors } : { ok: true, reading };
}

/** Build a canonical payload (used by the synthetic provider and tests). */
export function makeSensorPayload({ deviceId, ts, distanceCm, turbidity, conductivity, temperature, batteryPercent }) {
  return {
    deviceId,
    timestamp: new Date(ts).toISOString(),
    tank: { distanceCm },
    water: { turbidity, conductivity, temperature },
    device: { batteryPercent },
  };
}
