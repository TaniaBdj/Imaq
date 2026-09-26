# Architecture

Imaq is a single Node.js server that serves both the web app (a PWA) and a JSON API, backed by PostgreSQL.

```
┌────────────── Browser (PWA) ──────────────┐
│ UI views (js/ui/*)                        │
│   │                                       │
│ OperationalStore (js/ops/store.js)        │── last synced state cached in localStorage
│   │            └─ selectors (pure):       │
│   │               tank.js · detection.js  │
│   │               analysis.js ·           │
│   │               priority.js · routes.js │
│ ApiRepository (js/ops/api-repository.js)  │
└───────┬───────────────────────────────────┘
        │ HTTPS JSON (same origin)
┌───────▼──────────── Server (server/) ─────┐
│ index.mjs   static files + API routing    │
│ api.mjs     endpoints, validation, tx     │
│ ingest.mjs  single sensor ingestion path  │◄── POST /api/sensor-readings (future hardware)
│ synthetic-sensors.mjs (today's stand-in)  │── same ingestion path
│ db.mjs      pg (DATABASE_URL) or PGlite   │
└───────┬───────────────────────────────────┘
        ▼
   PostgreSQL (Railway)  /  PGlite (local, in-memory)
```

## Design choices

- **One shared state.** Every role loads `GET /api/state`. Every action (report, delivery, notice, CRUD) is a `POST`/`PUT` to the API. Screens poll every 15 s; there is no push.
- **Derived values are computed in the browser.** Tank level, litres, consumption, days remaining, detection status, priority and routes come from pure, deterministic functions (`js/ops/selectors.js`). All clients compute the same result from the same state. Routes and reassignments are **not stored**: a household keeps its `assigned_truck_id` when its truck is out of service, and the reassignment is recomputed on each client.
- **Swappable infrastructure.** The UI talks only to `OperationalStore`, which talks only to a repository. Another backend (for example a local edge gateway) means another repository class.
- **The browser never connects to the database.** Only `server/db.mjs` reads `DATABASE_URL`.

## Database

The schema lives in `server/schema.sql` and is applied idempotently at every start.

| Table | Purpose |
|---|---|
| `households` | Tank capacity and height, configured daily use, residents, vulnerability flag, assigned truck, delivery interval, water-condition baseline, `low_water_reported` flag, `archived` |
| `trucks` | Capacity, water on board, status (`IN_SERVICE`/`OUT_OF_SERVICE`), trip counter, `archived` |
| `sensor_devices` | Monitor registry: household assignment, manual status, battery, `last_seen` |
| `sensor_readings` | `distance_cm`, turbidity, conductivity, temperature, battery, `recorded_at` (index on device + time) |
| `deliveries` | Household, truck, litres, time (index on household + time) |
| `low_water_reports` | Open or resolved resident reports |
| `alerts` | Public notices (`advisory`, `delay`, `conserve`, `all_clear`) and internal `ops_truck_down` alerts |
| `settings` | Community name, village water volume, max stops per truck, synthetic settings |
| `users` | Placeholder for future authentication (unused today) |

- **Seeding.** `server/seed.mjs` truncates all tables and loads `data/*.json`, shifting timestamps so the newest reading is about 2 minutes old. The server seeds automatically when the `households` table is empty.
- **Database selection.** With `DATABASE_URL` set, the server uses `pg` (TLS for non-local hosts). Without it, it uses embedded PGlite (in-memory, or persisted with `IMAQ_LOCAL_DB_DIR`). PGlite is refused when `NODE_ENV=production`.

## Sensors

`js/sensor-data.js` defines the canonical payload and `normalizeSensorPayload()`. `server/ingest.mjs` is the only path into `sensor_readings`, and both the synthetic provider and the public endpoint use it.

`server/synthetic-sensors.mjs` runs every 60 s and on every `GET /api/state`. For each assigned monitor it:

- lowers the tank level using the household's configured daily use, with a day/night profile;
- raises the level after a confirmed delivery. This emulates what a physical level sensor would measure;
- repeats the last water-condition values, so a failed sensor stays failed;
- stays silent for monitors listed in `settings.synthetic_offline_devices`.

Set `IMAQ_SYNTHETIC_SENSORS=0` when real devices send readings.

## AI delivery risk assessment

`server/ai-assessment.mjs`, called by `POST /api/households/:id/ai-assessment` (municipality only):

```
admin clicks "Assess risk"
  → API rebuilds the household's derived state (same selectors as the UI)
  → buildContext(): only facts Imaq already has; unknown stays null
  → OpenAI Chat Completions (gpt-4o-mini, temperature 0, strict JSON schema), 15 s timeout
  → validateAssessment()
  → card in the admin household view
```

If the key is missing, the call fails, it times out or the answer is invalid, the server returns the existing rule-based priority in the same shape (`source: "rules"`). The assessment is advisory and never writes to the database.

## Offline

- `sw.js` precaches the app shell (stale-while-revalidate). `/api/*` is never served from the service-worker cache.
- `OperationalStore` saves the last `/api/state` in `localStorage`. Without a connection it shows that copy **read-only**, labelled with its sync time.
- Actions are **refused** offline ("nothing was sent"). Nothing is queued or faked.
- The resident water check is saved on the device only.

The intended field design keeps critical warnings working without Internet: sensor → household tablet → the same `detection.js` → resident. This local path is **not implemented yet**.

## Access control (prototype)

- **Municipality endpoints** require the header `X-Imaq-Admin-Pin`. It is compared server-side with `IMAQ_ADMIN_PIN` (default `2026` outside production). The browser keeps the PIN in `localStorage`.
- **Resident and driver endpoints are open.**
- **Sensor ingestion** requires `X-Imaq-Device-Key` only when `IMAQ_DEVICE_KEY` is set.

This is not authentication. See [LIMITATIONS.md](LIMITATIONS.md).
