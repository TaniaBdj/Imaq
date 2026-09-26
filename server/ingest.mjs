/**
 * Sensor ingestion — the ONE path every reading takes into the database,
 * whether it comes from POST /api/sensor-readings (ESP32 gateway later) or the
 * in-process SyntheticSensorProvider (today).
 */
import { normalizeSensorPayload } from '../js/sensor-data.js';
import { DISTANCE_TOLERANCE_CM } from '../js/core/tank.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function ingestReading(db, payload, { now = Date.now() } = {}) {
  const n = normalizeSensorPayload(payload, { now });
  if (!n.ok) throw new HttpError(400, 'Invalid sensor payload', n.errors);
  const r = n.reading;
  const { rows } = await db.query(
    `SELECT d.id, d.household_id, h.tank_height_cm
       FROM sensor_devices d LEFT JOIN households h ON h.id = d.household_id
      WHERE d.id = $1`, [r.deviceId]);
  const dev = rows[0];
  if (!dev) throw new HttpError(404, 'Unknown sensor device');
  if (!dev.household_id) throw new HttpError(409, 'Sensor is not assigned to a household');
  if (r.distanceCm > Number(dev.tank_height_cm) + DISTANCE_TOLERANCE_CM) {
    throw new HttpError(422, 'Impossible distance for this tank', ['tank.distanceCm exceeds tank height']);
  }
  const at = new Date(r.recordedAt).toISOString();
  await db.query(
    `INSERT INTO sensor_readings (sensor_device_id, recorded_at, distance_cm, turbidity, conductivity, temperature, battery_percent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [r.deviceId, at, r.distanceCm, r.turbidity, r.conductivity, r.temperature, r.batteryPercent]);
  await db.query(
    `UPDATE sensor_devices
        SET last_seen = GREATEST(COALESCE(last_seen, $2::timestamptz), $2::timestamptz),
            battery_percent = COALESCE($3, battery_percent)
      WHERE id = $1`, [r.deviceId, at, r.batteryPercent]);
  return { deviceId: r.deviceId, recordedAt: at };
}
