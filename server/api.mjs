/**
 * Imaq API — small, dependency-free JSON API over node:http.
 * Parameterized SQL only. Errors never leak stack traces or configuration.
 *
 * Prototype access control (NOT production authentication):
 *   - municipality endpoints require header X-Imaq-Admin-Pin matching IMAQ_ADMIN_PIN
 *     (default "2026" outside production; must be set explicitly in production)
 *   - sensor ingestion requires X-Imaq-Device-Key when IMAQ_DEVICE_KEY is set
 */
import { HttpError, ingestReading } from './ingest.mjs';
import { assessHousehold } from './ai-assessment.mjs';
import { buildSnapshot } from '../js/ops/selectors.js';

const ALERT_TITLES = { advisory: 'Water advisory', delay: 'Delivery delay', conserve: 'Save water notice', all_clear: 'All clear' };
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const VULN = [null, 'elder', 'infant', 'medical'];
const iso = (d) => (d == null ? null : new Date(d).getTime());

function int(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number between ${min} and ${max}`);
  return n;
}
function num(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
}
function id(v, name) {
  if (typeof v !== 'string' || !ID_RE.test(v.trim())) throw new HttpError(400, `${name} must be 1–24 letters, digits, - or _`);
  return v.trim().toUpperCase();
}
function text(v, name, max = 80) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${name} is required (max ${max} characters)`);
  return v.trim();
}

export function createApi({ db, synthetic = null, clock = () => Date.now(), env = process.env, aiFetch = globalThis.fetch }) {
  const adminPin = env.IMAQ_ADMIN_PIN || (env.NODE_ENV === 'production' ? null : '2026');
  const deviceKey = env.IMAQ_DEVICE_KEY || null;

  const requireAdmin = (req) => {
    if (!adminPin || req.headers['x-imaq-admin-pin'] !== adminPin) throw new HttpError(401, 'Municipality access required');
  };
  const one = async (sql, params, msg = 'Not found') => {
    const { rows } = await db.query(sql, params);
    if (!rows[0]) throw new HttpError(404, msg);
    return rows[0];
  };
  const truckExists = async (tid) => {
    if (tid == null) return null;
    await one(`SELECT id FROM trucks WHERE id = $1 AND NOT archived`, [tid], 'Unknown truck');
    return tid;
  };

  // ---------------- READ: one consistent operational state for every role ----------------
  async function state() {
    const now = clock();
    const since = new Date(now - 49 * 3600_000).toISOString();
    const [settings, households, trucks, sensors, readings, deliveries, reports, alerts] = await Promise.all([
      db.query(`SELECT key, value FROM settings`),
      db.query(`SELECT * FROM households ORDER BY id`),
      db.query(`SELECT * FROM trucks ORDER BY id`),
      db.query(`SELECT * FROM sensor_devices ORDER BY id`),
      db.query(`SELECT sensor_device_id, recorded_at, distance_cm, turbidity, conductivity, temperature FROM sensor_readings WHERE recorded_at >= $1 ORDER BY recorded_at`, [since]),
      db.query(`SELECT * FROM deliveries WHERE delivered_at >= $1 ORDER BY delivered_at`, [new Date(now - 30 * 86_400_000).toISOString()]),
      db.query(`SELECT * FROM low_water_reports WHERE resolved_at IS NULL OR created_at >= $1 ORDER BY created_at`, [new Date(now - 7 * 86_400_000).toISOString()]),
      db.query(`SELECT * FROM alerts WHERE active OR created_at >= $1 ORDER BY created_at`, [new Date(now - 7 * 86_400_000).toISOString()]),
    ]);
    const byDevice = {};
    for (const r of readings.rows) (byDevice[r.sensor_device_id] ||= []).push([iso(r.recorded_at), r.distance_cm, r.turbidity, r.conductivity, r.temperature]);
    return {
      serverTime: now,
      settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
      households: households.rows.map((h) => ({
        id: h.id, displayName: h.display_name, residentsCount: h.residents_count, tankCapacityL: h.tank_capacity_l, tankHeightCm: Number(h.tank_height_cm),
        configuredDailyUseL: h.configured_daily_use_l, vulnerability: h.vulnerability_flag, assignedTruckId: h.assigned_truck_id,
        deliveryIntervalDays: h.delivery_interval_days, baseline: h.water_baseline, lowWaterReported: h.low_water_reported, archived: h.archived,
      })),
      trucks: trucks.rows.map((t) => ({ id: t.id, displayName: t.display_name, capacityL: t.capacity_l, currentWaterL: t.current_water_l, status: t.status, trip: t.trip, statusChangedAt: iso(t.status_changed_at), archived: t.archived })),
      sensors: sensors.rows.map((s) => ({ id: s.id, serialNumber: s.serial_number, householdId: s.household_id, status: s.status, batteryPercent: s.battery_percent, firmwareVersion: s.firmware_version, lastSeen: iso(s.last_seen) })),
      readings: byDevice,
      deliveries: deliveries.rows.map((d) => ({ id: String(d.id), householdId: d.household_id, truckId: d.truck_id, litres: d.litres, deliveredAt: iso(d.delivered_at) })),
      lowWaterReports: reports.rows.map((r) => ({ id: String(r.id), householdId: r.household_id, createdAt: iso(r.created_at), resolvedAt: iso(r.resolved_at) })),
      alerts: alerts.rows.map((a) => ({ id: String(a.id), type: a.type, title: a.title, message: a.message, audience: a.audience, truckId: a.truck_id, affected: a.affected, active: a.active, createdAt: iso(a.created_at), endedAt: iso(a.ended_at) })),
    };
  }

  // ---------------- ROUTES ----------------
  const routes = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true, db: db.kind })],
    ['GET', /^\/api\/state$/, async () => {
      if (synthetic) await synthetic.tick();
      return state();
    }],
    ['POST', /^\/api\/session\/admin$/, async (req, body) => {
      if (!adminPin || String(body.pin || '') !== adminPin) throw new HttpError(401, 'Incorrect PIN');
      return { ok: true };
    }],

    // --- sensors (device → API) ---
    ['POST', /^\/api\/sensor-readings$/, async (req, body) => {
      if (deviceKey && req.headers['x-imaq-device-key'] !== deviceKey) throw new HttpError(401, 'Device key required');
      return ingestReading(db, body, { now: clock() });
    }],

    // --- resident ---
    ['POST', /^\/api\/households\/([^/]+)\/low-water-reports$/, async (req, body, [hid]) => {
      await one(`SELECT id FROM households WHERE id = $1 AND NOT archived`, [hid], 'Unknown household');
      return db.tx(async (t) => {
        const open = await t.query(`SELECT id FROM low_water_reports WHERE household_id = $1 AND resolved_at IS NULL`, [hid]);
        if (!open.rows.length) await t.query(`INSERT INTO low_water_reports (household_id, created_at) VALUES ($1, $2)`, [hid, new Date(clock()).toISOString()]);
        await t.query(`UPDATE households SET low_water_reported = TRUE, updated_at = now() WHERE id = $1`, [hid]);
        return { ok: true, alreadyReported: open.rows.length > 0 };
      });
    }],

    // --- driver ---
    ['POST', /^\/api\/deliveries$/, async (req, body) => {
      const hid = id(body.householdId, 'householdId');
      const tid = id(body.truckId, 'truckId');
      const litres = int(body.litres, 'litres', 1, 20000);
      const out = await db.tx(async (t) => {
        const truck = (await t.query(`SELECT * FROM trucks WHERE id = $1 AND NOT archived FOR UPDATE`, [tid])).rows[0];
        if (!truck) throw new HttpError(404, 'Unknown truck');
        if (truck.status !== 'IN_SERVICE') throw new HttpError(409, 'Truck is out of service');
        if (litres > truck.current_water_l) throw new HttpError(409, 'Not enough water on board');
        const hh = (await t.query(`SELECT id FROM households WHERE id = $1 AND NOT archived`, [hid])).rows[0];
        if (!hh) throw new HttpError(404, 'Unknown household');
        const at = new Date(clock()).toISOString();
        const d = (await t.query(`INSERT INTO deliveries (household_id, truck_id, litres, delivered_at) VALUES ($1, $2, $3, $4) RETURNING id`, [hid, tid, litres, at])).rows[0];
        await t.query(`UPDATE trucks SET current_water_l = current_water_l - $2, updated_at = now() WHERE id = $1`, [tid, litres]);
        // The tank was refilled: an open low-water report is resolved.
        await t.query(`UPDATE low_water_reports SET resolved_at = $2 WHERE household_id = $1 AND resolved_at IS NULL`, [hid, at]);
        await t.query(`UPDATE households SET low_water_reported = FALSE, updated_at = now() WHERE id = $1`, [hid]);
        return { id: String(d.id), deliveredAt: at };
      });
      if (synthetic) await synthetic.afterDelivery(hid); // hardware emulation: the level sensor reports the fill
      return out;
    }],
    ['POST', /^\/api\/trucks\/([^/]+)\/refill$/, async (req, body, [tid]) => db.tx(async (t) => {
      const truck = (await t.query(`SELECT * FROM trucks WHERE id = $1 AND NOT archived FOR UPDATE`, [tid])).rows[0];
      if (!truck) throw new HttpError(404, 'Unknown truck');
      if (truck.status !== 'IN_SERVICE') throw new HttpError(409, 'Truck is out of service');
      const village = Number((await t.query(`SELECT value FROM settings WHERE key = 'village_water_m3'`)).rows[0]?.value ?? 0);
      const litres = Math.max(0, Math.min(truck.capacity_l - truck.current_water_l, Math.floor(village * 1000)));
      await t.query(`UPDATE trucks SET current_water_l = current_water_l + $2, trip = trip + 1, updated_at = now() WHERE id = $1`, [tid, litres]);
      await t.query(`UPDATE settings SET value = to_jsonb(round(($1::numeric), 1)) WHERE key = 'village_water_m3'`, [village - litres / 1000]);
      return { litres };
    })],
    ['POST', /^\/api\/trucks\/([^/]+)\/status$/, async (req, body, [tid]) => {
      // Drivers may report a problem; putting a truck back in service is also allowed from the truck (prototype).
      const status = body.status === 'OUT_OF_SERVICE' ? 'OUT_OF_SERVICE' : body.status === 'IN_SERVICE' ? 'IN_SERVICE' : null;
      if (!status) throw new HttpError(400, 'status must be IN_SERVICE or OUT_OF_SERVICE');
      return db.tx(async (t) => {
        const truck = (await t.query(`SELECT * FROM trucks WHERE id = $1 AND NOT archived FOR UPDATE`, [tid])).rows[0];
        if (!truck) throw new HttpError(404, 'Unknown truck');
        if (truck.status === status) return { changed: false };
        const at = new Date(clock()).toISOString();
        await t.query(`UPDATE trucks SET status = $2, status_changed_at = $3, updated_at = now() WHERE id = $1`, [tid, status, at]);
        if (status === 'OUT_OF_SERVICE') {
          const affected = (await t.query(`SELECT id FROM households WHERE assigned_truck_id = $1 AND NOT archived ORDER BY id`, [tid])).rows.map((r) => r.id);
          await t.query(`INSERT INTO alerts (type, title, message, audience, truck_id, affected, created_at) VALUES ('ops_truck_down', $1, '', 'municipality', $2, $3, $4)`,
            [`Truck ${tid} out of service`, tid, JSON.stringify(affected), at]);
        } else {
          await t.query(`UPDATE alerts SET active = FALSE, ended_at = $2 WHERE type = 'ops_truck_down' AND truck_id = $1 AND active`, [tid, at]);
        }
        return { changed: true };
      });
    }],

    // --- municipality: alerts ---
    ['POST', /^\/api\/alerts$/, async (req, body) => {
      requireAdmin(req);
      const type = body.type;
      if (!ALERT_TITLES[type]) throw new HttpError(400, 'Unknown alert type');
      const note = typeof body.message === 'string' ? body.message.slice(0, 280) : '';
      return db.tx(async (t) => {
        const at = new Date(clock()).toISOString();
        // "All clear" ends every public notice; a new notice replaces a previous "all clear".
        await t.query(`UPDATE alerts SET active = FALSE, ended_at = $1 WHERE active AND audience = 'households' AND ($2 = 'all_clear' OR type = 'all_clear')`, [at, type]);
        const a = (await t.query(`INSERT INTO alerts (type, title, message, created_at) VALUES ($1, $2, $3, $4) RETURNING id`, [type, ALERT_TITLES[type], note, at])).rows[0];
        return { id: String(a.id) };
      });
    }],
    ['POST', /^\/api\/alerts\/(\d+)\/end$/, async (req, body, [aid]) => {
      requireAdmin(req);
      const { rows } = await db.query(`UPDATE alerts SET active = FALSE, ended_at = $2 WHERE id = $1 AND active RETURNING id`, [aid, new Date(clock()).toISOString()]);
      return { ended: rows.length > 0 };
    }],

    // --- municipality: AI delivery risk assessment (advisory only; writes nothing) ---
    ['POST', /^\/api\/households\/([^/]+)\/ai-assessment$/, async (req, body, [hid]) => {
      requireAdmin(req);
      const now = clock();
      const snap = buildSnapshot({ data: await state(), now });
      const h = snap.households[hid];
      if (!h) throw new HttpError(404, 'Unknown household');
      return assessHousehold(h, { now, env, fetchImpl: aiFetch, lang: body.lang === 'fr' ? 'fr' : 'en' });
    }],

    // --- municipality: households ---
    ['POST', /^\/api\/households$/, async (req, body) => {
      requireAdmin(req);
      const h = await householdFields(body, true);
      await db.query(
        `INSERT INTO households (id, display_name, residents_count, tank_capacity_l, tank_height_cm, configured_daily_use_l, vulnerability_flag, assigned_truck_id, delivery_interval_days, water_baseline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [h.id, h.displayName, h.residentsCount, h.tankCapacityL, h.tankHeightCm, h.configuredDailyUseL, h.vulnerability, h.assignedTruckId, h.deliveryIntervalDays,
          JSON.stringify({ turbidity: 0.42, conductivity: 86, temperature: 14.2 })]).catch(dup('Household'));
      return { id: h.id };
    }],
    ['PUT', /^\/api\/households\/([^/]+)$/, async (req, body, [hid]) => {
      requireAdmin(req);
      await one(`SELECT id FROM households WHERE id = $1`, [hid], 'Unknown household');
      const h = await householdFields({ ...body, id: hid }, false);
      await db.query(
        `UPDATE households SET display_name=$2, residents_count=$3, tank_capacity_l=$4, tank_height_cm=$5, configured_daily_use_l=$6, vulnerability_flag=$7, assigned_truck_id=$8, delivery_interval_days=$9, updated_at=now() WHERE id=$1`,
        [hid, h.displayName, h.residentsCount, h.tankCapacityL, h.tankHeightCm, h.configuredDailyUseL, h.vulnerability, h.assignedTruckId, h.deliveryIntervalDays]);
      return { id: hid };
    }],
    ['POST', /^\/api\/households\/([^/]+)\/archive$/, async (req, body, [hid]) => {
      requireAdmin(req);
      const archived = body.archived !== false;
      await one(`UPDATE households SET archived = $2, updated_at = now() WHERE id = $1 RETURNING id`, [hid, archived], 'Unknown household');
      if (archived) await db.query(`UPDATE sensor_devices SET household_id = NULL, status = 'UNASSIGNED' WHERE household_id = $1`, [hid]);
      return { id: hid, archived };
    }],

    // --- municipality: trucks ---
    ['POST', /^\/api\/trucks$/, async (req, body) => {
      requireAdmin(req);
      const t = truckFields(body, true);
      await db.query(`INSERT INTO trucks (id, display_name, capacity_l, current_water_l, status) VALUES ($1,$2,$3,$4,$5)`,
        [t.id, t.displayName, t.capacityL, t.currentWaterL, t.status]).catch(dup('Truck'));
      return { id: t.id };
    }],
    ['PUT', /^\/api\/trucks\/([^/]+)$/, async (req, body, [tid]) => {
      requireAdmin(req);
      const cur = await one(`SELECT * FROM trucks WHERE id = $1`, [tid], 'Unknown truck');
      const t = truckFields({ ...body, id: tid }, false);
      await db.query(`UPDATE trucks SET display_name=$2, capacity_l=$3, current_water_l=$4, status=$5, status_changed_at = CASE WHEN status <> $5 THEN now() ELSE status_changed_at END, updated_at=now() WHERE id=$1`,
        [tid, t.displayName, t.capacityL, t.currentWaterL, t.status ?? cur.status]);
      return { id: tid };
    }],
    ['POST', /^\/api\/trucks\/([^/]+)\/archive$/, async (req, body, [tid]) => {
      requireAdmin(req);
      const archived = body.archived !== false;
      await one(`UPDATE trucks SET archived = $2, updated_at = now() WHERE id = $1 RETURNING id`, [tid, archived], 'Unknown truck');
      return { id: tid, archived };
    }],

    // --- municipality: sensors ---
    ['POST', /^\/api\/sensors$/, async (req, body) => {
      requireAdmin(req);
      const sid = id(body.serialNumber, 'serialNumber');
      const hid = body.householdId ? id(body.householdId, 'householdId') : null;
      if (hid) await assignable(hid);
      await db.query(`INSERT INTO sensor_devices (id, serial_number, household_id, status, battery_percent, firmware_version) VALUES ($1,$1,$2,$3,$4,$5)`,
        [sid, hid, hid ? 'ONLINE' : 'UNASSIGNED', body.batteryPercent == null ? null : num(body.batteryPercent, 'batteryPercent', 0, 100), typeof body.firmwareVersion === 'string' ? body.firmwareVersion.slice(0, 20) : null]).catch(dup('Sensor'));
      return { id: sid };
    }],
    ['PUT', /^\/api\/sensors\/([^/]+)$/, async (req, body, [sid]) => {
      requireAdmin(req);
      const cur = await one(`SELECT * FROM sensor_devices WHERE id = $1`, [sid], 'Unknown sensor');
      const hid = body.householdId === undefined ? cur.household_id : body.householdId ? id(body.householdId, 'householdId') : null;
      if (hid && hid !== cur.household_id) await assignable(hid);
      let status = body.status === 'SERVICE_REQUIRED' ? 'SERVICE_REQUIRED' : body.status === 'ONLINE' ? 'ONLINE' : cur.status;
      if (!hid) status = 'UNASSIGNED';
      else if (status === 'UNASSIGNED') status = 'ONLINE';
      await db.query(`UPDATE sensor_devices SET household_id = $2, status = $3 WHERE id = $1`, [sid, hid, status]);
      if (hid && hid !== cur.household_id) {
        // A monitor moved to another tank must not carry the old tank's readings.
        await db.query(`DELETE FROM sensor_readings WHERE sensor_device_id = $1`, [sid]);
        await db.query(`UPDATE sensor_devices SET last_seen = NULL WHERE id = $1`, [sid]);
        const off = await db.query(`SELECT value FROM settings WHERE key = 'synthetic_offline_devices'`);
        if (off.rows[0]) await db.query(`UPDATE settings SET value = $1 WHERE key = 'synthetic_offline_devices'`, [JSON.stringify(off.rows[0].value.filter((x) => x !== sid))]);
      }
      return { id: sid, householdId: hid, status };
    }],
  ];

  async function assignable(hid) {
    await one(`SELECT id FROM households WHERE id = $1 AND NOT archived`, [hid], 'Unknown household');
    const { rows } = await db.query(`SELECT id FROM sensor_devices WHERE household_id = $1`, [hid]);
    if (rows.length) throw new HttpError(409, `Household already has sensor ${rows[0].id}. Unassign it first.`);
  }
  async function householdFields(b, isNew) {
    const vuln = b.vulnerability === '' || b.vulnerability == null ? null : b.vulnerability;
    if (!VULN.includes(vuln)) throw new HttpError(400, 'Unknown vulnerability flag');
    const residents = int(b.residentsCount, 'residentsCount', 1, 30);
    return {
      id: isNew ? id(b.id, 'id') : b.id,
      displayName: b.displayName ? text(b.displayName, 'displayName', 40) : (isNew ? id(b.id, 'id') : b.id),
      residentsCount: residents,
      tankCapacityL: int(b.tankCapacityL, 'tankCapacityL', 100, 50000),
      tankHeightCm: num(b.tankHeightCm, 'tankHeightCm', 20, 500),
      configuredDailyUseL: int(b.configuredDailyUseL ?? residents * 60, 'configuredDailyUseL', 1, 5000),
      vulnerability: vuln,
      assignedTruckId: await truckExists(b.assignedTruckId ? id(b.assignedTruckId, 'assignedTruckId') : null),
      deliveryIntervalDays: int(b.deliveryIntervalDays ?? 2, 'deliveryIntervalDays', 1, 14),
    };
  }
  function truckFields(b, isNew) {
    const capacityL = int(b.capacityL, 'capacityL', 100, 100000);
    const status = b.status == null ? (isNew ? 'IN_SERVICE' : null) : ['IN_SERVICE', 'OUT_OF_SERVICE'].includes(b.status) ? b.status : null;
    if (b.status != null && !status) throw new HttpError(400, 'Unknown truck status');
    return {
      id: isNew ? id(b.id, 'id') : b.id,
      displayName: b.displayName ? text(b.displayName, 'displayName', 40) : `Truck ${isNew ? id(b.id, 'id') : b.id}`,
      capacityL,
      currentWaterL: int(b.currentWaterL ?? capacityL, 'currentWaterL', 0, capacityL),
      status,
    };
  }
  const dup = (what) => (e) => {
    if (e && (e.code === '23505' || /duplicate key/i.test(e.message))) throw new HttpError(409, `${what} already exists`);
    throw e;
  };

  /** Handle an /api request. Returns true if handled. */
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(obj));
    };
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) throw new HttpError(404, 'Not found');
      const params = url.pathname.match(route[1]).slice(1).map(decodeURIComponent);
      const body = req.method === 'GET' ? {} : await readJson(req);
      send(200, await route[2](req, body, params));
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { error: e.message, details: e.details });
      else {
        console.error('[api] internal error:', e && e.code ? `${e.code} ${e.message}` : e && e.message);
        send(500, { error: 'Internal error' });
      }
    }
    return true;
  };
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
