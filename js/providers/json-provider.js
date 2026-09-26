/**
 * JsonSensorProvider — today's sensor data source for every household.
 *
 * SensorProvider interface (a future BluetoothSensorProvider / API provider
 * implements the same methods; nothing after this boundary changes):
 *
 *   connect()                         load / (re)connect
 *   setAnchor(ms)                     real time at which the recording "ends"
 *   getHouseholdIds()
 *   getHousehold(id)                  normalized household metadata
 *   getRecentReadings(id, now)        NormalizedReading[] oldest→newest
 *   getLatestReading(id, now)         NormalizedReading | null
 *   getConnection(id)                 { deviceId, transport }
 *
 * How it produces data:
 *  1. RECORDED: 48 h of synthetic readings per household (data/readings.json),
 *     rebased so the recording ends at the anchor time.
 *  2. HARDWARE EMULATION after the anchor: a reading every 5 minutes, carrying
 *     the last recorded water-quality values (a broken sensor stays broken) and a
 *     tank level that falls with household use and rises when water is added.
 *     "Water added" comes from `waterAddedFeed` (confirmed deliveries). In the
 *     field this whole step disappears: the level sensor physically measures it.
 *
 * Fully deterministic — no randomness at runtime.
 */
import { normalizeReadings, normalizeHousehold, parseTimestamp } from '../sensor-data.js';

const EMULATION_STEP_MS = 5 * 60_000;
const hourWeight = (hour) => (hour >= 7 && hour < 22 ? 0.9 / 15 : 0.1 / 9); // same use model as the generator

export class JsonSensorProvider {
  constructor({ baseUrl = 'data/', fetchImpl, clock = () => Date.now(), waterAddedFeed = () => [] } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl || ((url) => globalThis.fetch(url));
    this.clock = clock;
    this.waterAddedFeed = waterAddedFeed;
    this.households = new Map();
    this.recorded = new Map();
    this.rejected = 0;
    this.recordingEnd = NaN;
    this.anchor = NaN;
    this.cache = new Map();
  }

  async #json(path) {
    const res = await this.fetch(this.baseUrl + path);
    if (!res || !res.ok) throw new Error(`Cannot load ${path}`);
    return res.json();
  }

  async connect() {
    const [hh, rd] = await Promise.all([this.#json('households.json'), this.#json('readings.json')]);
    this.households.clear();
    this.recorded.clear();
    this.rejected = 0;
    for (const raw of hh.households || []) {
      const h = normalizeHousehold(raw);
      this.households.set(h.id, h);
    }
    let end = parseTimestamp(rd._meta && rd._meta.recordingEnd);
    for (const id of this.households.keys()) {
      const { readings, rejected } = normalizeReadings((rd.households || {})[id]);
      this.rejected += rejected;
      this.recorded.set(id, readings);
      if (!Number.isFinite(end) && readings.length) end = Math.max(end || -Infinity, readings[readings.length - 1].timestamp);
    }
    this.recordingEnd = end;
    this.cache.clear();
  }

  /** Map the end of the recording onto real time `ms`. */
  setAnchor(ms) {
    this.anchor = ms;
    this.cache.clear();
  }

  /** Recorded timestamps → real timestamps. */
  replayTime(recordedMs) {
    return recordedMs + (this.anchor - this.recordingEnd);
  }

  getHouseholdIds() {
    return [...this.households.keys()];
  }

  getHousehold(id) {
    return this.households.get(id) || null;
  }

  getConnection(id) {
    const h = this.getHousehold(id);
    return { deviceId: h ? h.sensorDevice : null, transport: 'recorded-data' };
  }

  getLatestReading(id, now = this.clock()) {
    const all = this.getRecentReadings(id, now);
    return all.length ? all[all.length - 1] : null;
  }

  getRecentReadings(id, now = this.clock()) {
    const h = this.getHousehold(id);
    const rec = this.recorded.get(id);
    if (!h || !rec || !Number.isFinite(this.anchor)) return [];
    const additions = (this.waterAddedFeed(id) || []).filter((a) => Number.isFinite(a.ts) && a.litres > 0).sort((a, b) => a.ts - b.ts);
    const key = `${id}|${Math.floor(now / EMULATION_STEP_MS)}|${additions.map((a) => `${a.ts}:${a.litres}`).join(',')}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const shift = this.anchor - this.recordingEnd;
    const out = rec.map((r) => ({ ...r, timestamp: r.timestamp + shift })).filter((r) => r.timestamp <= now);
    const lastRecorded = out[out.length - 1];
    // A monitor whose recording stops before the anchor is offline: no emulated readings.
    const monitorOnline = lastRecorded && this.anchor - lastRecorded.timestamp <= 60 * 60_000;
    if (lastRecorded && monitorOnline) {
      const points = [];
      for (let t = lastRecorded.timestamp + EMULATION_STEP_MS; t <= now; t += EMULATION_STEP_MS) points.push({ t, add: 0 });
      for (const a of additions) if (a.ts > lastRecorded.timestamp && a.ts <= now) points.push({ t: a.ts, add: a.litres });
      points.sort((a, b) => a.t - b.t);
      let level = lastRecorded.tankLevel;
      let prevT = lastRecorded.timestamp;
      const cap = h.tankCapacityLitres || 1;
      const daily = h.estimatedDailyUseLitres || 0;
      for (const p of points) {
        if (typeof level === 'number') {
          const mid = new Date((prevT + p.t) / 2).getHours();
          level -= (daily * hourWeight(mid) * ((p.t - prevT) / 3600_000) * 100) / cap;
          if (p.add) level += (p.add / cap) * 100;
          level = Math.max(0, Math.min(100, level));
        }
        prevT = p.t;
        out.push({
          timestamp: p.t,
          turbidity: lastRecorded.turbidity,
          conductivity: lastRecorded.conductivity,
          temperature: lastRecorded.temperature,
          tankLevel: typeof level === 'number' ? Math.round(level * 10) / 10 : null,
        });
      }
    }
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }
}
