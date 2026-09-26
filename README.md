# Imaq ᐃᒪᖅ — Water visibility and delivery coordination

**Hack for Humanity Ottawa 2026 prototype.** One platform, three roles, one shared database:

| Role | Answers |
|---|---|
| 🏠 **Resident** | How much water do I have? How long will it last? Has anything unusual changed? When is my next delivery? Any municipal notice? |
| 🚚 **Driver** | Which household first? How much to deliver? How much water is on my truck? Report a truck problem. |
| 🏛 **Municipality** | Water in every tank (%, litres, daily use, days left), households needing attention, sensor health, trucks, deliveries, low-water reports, notices, plus CRUD for households, trucks and sensors. |

> **Imaq is an early-warning tool and does not replace official water-quality testing.** Its sensors measure turbidity, conductivity, temperature and tank level. They do **not** detect bacteria, E. coli or pathogens. NORMAL means "no unusual change detected", never "safe".

> **Data provenance:** sensor readings are **synthetic** today. No household water-quality data from Inukjuak is represented.

## Architecture

```
TODAY                                              FIELD
SyntheticSensorProvider  (server/synthetic-sensors) Physical tank sensors (level · turbidity · conductivity · temperature)
        │ canonical sensor payload                          │
        ▼                                                   ▼
POST /api/sensor-readings ◄──── same contract ──── ESP32 → tablet / gateway
        │  normalizeSensorPayload() → validation → sensor_readings
        ▼
Imaq API (node:http, server/api.mjs) ──► Railway PostgreSQL (DATABASE_URL, server-side only)
        ▲
        │ HTTPS JSON
Browser PWA: UI → OperationalStore → ApiRepository
        │
        └─ pure engines shared by all roles: tank.js (level/litres/consumption/days) · detection.js ·
           analysis.js · priority.js · routes.js
```

- **The browser never connects to PostgreSQL.** `DATABASE_URL` is read only in `server/db.mjs`.
- **One shared state.** Every role reads `GET /api/state` and every role action writes through the API, inside a transaction where needed.
- **Swappable infrastructure.** UI → `OperationalStore` → `ApiRepository`. Another backend means another repository; the UI does not change.
- **Edge monitoring (field design).** Critical resident warnings should run locally: sensor → tablet → the same `detection.js` → resident. The cloud database is for coordination. Today, the tablet receives readings through the API. Offline, it shows the last synced data read-only, clearly labelled. Actions are **not** queued or faked, and robust offline sync is future work.

### Railway PostgreSQL

- Set `DATABASE_URL` (Railway provides it). The server uses `pg` with TLS for remote hosts.
- If `DATABASE_URL` is **unset**, the server uses **embedded PostgreSQL (PGlite)**: the same SQL, for local development and tests. It is **refused when `NODE_ENV=production`**.
- The schema (`server/schema.sql`) is applied idempotently at startup. An empty database is seeded automatically.

### Database tables

`households`, `trucks`, `users` (ready for future authentication), `sensor_devices`, `sensor_readings` (index on device + time), `deliveries` (index on household + time), `low_water_reports`, `alerts`, `settings` (village water, stops per truck, seed time).

### API endpoints

| Method | Path | Who |
|---|---|---|
| GET | `/api/health` | all |
| GET | `/api/state` | all roles: households, trucks, sensors, 48 h readings, deliveries, reports, alerts |
| POST | `/api/sensor-readings` | sensor gateway (canonical payload; `X-Imaq-Device-Key` if `IMAQ_DEVICE_KEY` is set) |
| POST | `/api/households/:id/low-water-reports` | resident |
| POST | `/api/deliveries` | driver (transaction: record + truck water + resolve report) |
| POST | `/api/trucks/:id/refill` · `/api/trucks/:id/status` | driver |
| POST | `/api/session/admin` | municipality PIN check |
| POST/PUT | `/api/households[/:id]` · `/api/households/:id/archive` | municipality |
| POST/PUT | `/api/trucks[/:id]` · `/api/trucks/:id/archive` | municipality |
| POST/PUT | `/api/sensors[/:id]` (register / assign / reassign / service) | municipality |
| POST | `/api/alerts` · `/api/alerts/:id/end` | municipality |

### Sensor contract (canonical payload)

```json
{
  "deviceId": "IMQ-0031",
  "timestamp": "2026-09-26T13:00:00Z",
  "tank":   { "distanceCm": 102 },
  "water":  { "turbidity": 0.42, "conductivity": 87, "temperature": 13.8 },
  "device": { "batteryPercent": 84 }
}
```

`normalizeSensorPayload()` in `js/sensor-data.js` accepts a payload only if:

- the device exists and is assigned to a household
- the timestamp is valid ISO 8601 and not in the future
- the distance is present, numeric and physically possible for that tank
- water values are numeric when present
- battery is 0–100 when present

Malformed data is rejected with a 4xx response and never stored. A water value sent as `null` (a sensor fault) is stored as null, and detection turns it into **SYSTEM CHECK**, never NORMAL.

Try it: `npm run post-reading -- --url http://localhost:8080 --device IMQ-0031 --distance 60`

## Calculations (`js/core/tank.js`, pure and tested)

| | Formula | Unknown handling |
|---|---|---|
| Tank level | `(tankHeightCm − distanceCm) ÷ tankHeightCm × 100`, clamped 0–100 | missing/invalid/impossible → **null** (UNKNOWN) |
| Litres | `tankCapacityL × level ÷ 100` | unknown level → null, never 0 |
| Consumption | average fall in litres over **declining** segments of the last 48 h, rounded to 10 L/day; rises (deliveries) excluded; gaps > 6 h ignored; needs ≥ 12 h of data | falls back to `configured_daily_use_l` (`source: "configured"`) |
| Days remaining | `litres ÷ litresPerDay` → "About 6 days" · "About 1 day" · "Less than 1 day" | missing reading → "Unknown" (UNKNOWN ≠ EMPTY) |

Example: a 150 cm tank with a sensor distance of 102 cm → 48 cm of water → 32 % → 640 L in a 2,000 L tank.

⚠️ **Geometry assumption:** volume changes linearly with height (upright tank). Horizontal cylinders and irregular tanks need a **tank-specific calibration table**. This formula is not valid for every tank.

A tank reading is trusted only if it is fresh. A monitor silent for more than 30 min is STALE, and after 2 h it is OFFLINE. Its tank level becomes UNKNOWN and its water measurements show "No valid reading".

## Priority (deterministic decision support, not AI)

```
score = days remaining − 2 (resident low-water report) − 0.5 (vulnerability) − 0.5 (delivery delayed / no truck) − 0.5 (overdue > 12 h)
HIGH ≤ 0.5 < MEDIUM ≤ 2 < LOW
```

**A sensor failure never means low water.** An unknown level is planned from the delivery schedule (`score = days until due + 1`). Monitor maintenance is tracked separately (`monitorAttention`, Sensors page, "Check required").

Routes are not maps. Each truck's households are sorted by score, with a maximum of 6 stops per day. A truck out of service has its households redistributed to the operating truck with the fewest households.

## Deliveries: records vs. physical level

A confirmed delivery (`POST /api/deliveries`) creates the delivery record, reduces the truck's water and resolves any open low-water report, all in one transaction. The **physical tank level is always the next sensor reading.** Today the synthetic provider emulates that reading right after the delivery; in the field, the real level sensor measures the fill.

## Run locally

```bash
npm install
npm run dev          # http://localhost:8080 — embedded PostgreSQL if DATABASE_URL is unset
npm run seed         # deterministic demo reset (DESTRUCTIVE; never exposed in the web UI)
```

With Railway locally: put `DATABASE_URL=...` in `.env` (gitignored), then `npm run seed` and `npm run dev`.

## Deploy to Railway

1. Create a project with a **PostgreSQL** service and a service from this repository.
2. On the app service, set the variables:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `NODE_ENV=production`
   - `IMAQ_ADMIN_PIN=<choose>`
   - optionally `IMAQ_DEVICE_KEY`
3. Deploy. `railway.json` runs `npm start` with a health check at `/api/health`. On first start the schema is created and the synthetic seed is loaded.
4. Reset the demo before presenting: `railway run npm run seed`.

The PWA and the API are served from one origin, with relative paths and no hard-coded hosts.

## Prototype access (not authentication)

- Role selection: residents pick a house and drivers pick a truck.
- The municipality enters a PIN. It is **verified server-side** against `IMAQ_ADMIN_PIN` (default `2026` outside production), and municipality endpoints require it.
- The `users` table and the `LocalRoleAccess`-shaped session make it possible to add real authentication later. Resident and driver endpoints are **open in this prototype**. That is a known limitation.

## Tests

```bash
npm test             # 56 unit + database + API + cross-role integration tests (real server on embedded PostgreSQL)
npm run test:e2e     # 67 browser checks (Playwright + axe-core), full judge demo on a fresh database
```

What they cover:

- the schema and seed
- household, truck and sensor CRUD
- sensor validation: invalid device, timestamp, distance, NaN, impossible values
- tank level, volume, consumption and days remaining
- the 4 cross-role flows, plus new truck → driver, new household → admin, and registered sensor → monitored
- offline honesty
- server files not served
- axe accessibility and 48 px touch targets on every role screen
- a scientific wording audit in English and French

## What is real today / what is synthetic

**Real:**
- the API and PostgreSQL schema, validation and transactions
- all calculations, detection, priority and routing
- CRUD, deliveries, reports and alerts persisted centrally
- the PWA, the offline shell and accessibility

**Synthetic:**
- the sensor readings (a 48 h synthetic history plus `SyntheticSensorProvider`)
- the households, trucks and village-water figures
- the tank-height and consumption assumptions

**ESP32 later:** the ESP32 (or the tablet gateway) posts the same canonical payload to `/api/sensor-readings` with a device key, and you set `IMAQ_SYNTHETIC_SENSORS=0`. Nothing else changes.

## Field validation required before deployment

- sensor selection and calibration
- tank-specific calibration tables
- field testing
- biofouling and freeze/environmental testing
- validation against laboratory water-quality measurements
- real authentication and data governance
- local edge detection on the tablet
- consultation with the community, operators and drivers, including Inuktitut translation by community speakers
