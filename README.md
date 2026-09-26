<p align="center">
  <img src="icons/icon.svg" alt="Imaq logo" width="96" height="96">
</p>

<h1 align="center">Imaq ᐃᒪᖅ</h1>

<p align="center">
  <strong>Household water visibility and delivery coordination for trucked-water communities.</strong><br>
  Hack for Humanity Ottawa 2026 · prototype
</p>

---

In Inukjuak (Nunavik), as in many northern communities, rock and permafrost make piped water impractical. Drinking water goes **treatment plant → delivery truck → household tank → tap**. The plant is monitored, but once water leaves it, visibility drops: nobody easily knows which tanks are close to empty, which homes are waiting, or what a truck breakdown means for the day.

**Imaq** is one web app with three views over one shared state:

| Role | Can answer |
|---|---|
| 🏠 **Resident** | How much water do I have? About how long will it last? Did measurable conditions change? Is the monitor working? When is my next delivery? Is there a municipal notice? It also offers a one-tap "my low-water light is on" report. |
| 🚚 **Driver** | Which house is next and why? How much should I deliver? How much water is on my truck? Confirm a delivery, return to the plant, report a truck problem. |
| 🏛 **Municipality** | Estimated water in every tank, days remaining, priority queue, low-water reports, monitor health, truck status, delivery log, notices. It also lets staff add and edit households, trucks and sensors, and get an **AI delivery risk assessment** for a household (advisory only). |

The core is an operational loop:

```
measurement → understanding → prioritisation → delivery / response → updated household state
```

> [!IMPORTANT]
> **All sensor data is synthetic.** No sensor is installed anywhere, no data from Inukjuak households is used, and there is no live municipal data. The API, database, calculations, priority engine and the three interfaces are real, working code.

> [!WARNING]
> **Imaq does not test water safety.** Turbidity, conductivity and temperature are *indicators*. They cannot detect bacteria, E. coli or other pathogens. **NORMAL means "no unusual change detected", never "safe".** Imaq does not replace official water testing or advisories.

---

## What is real, what is simulated

| | Status |
|---|---|
| Web app (PWA), three role views, English and French | **Real** |
| REST API (Node.js), PostgreSQL schema, validation, transactions | **Real** |
| Tank level, litres, consumption, days remaining, detection, priority, routing | **Real code** running on **synthetic inputs** |
| Deliveries, low-water reports, notices, households, trucks and sensors created in the app | **Real persisted records** |
| AI delivery risk assessment (OpenAI, server-side) | **Real API call** on synthetic household data; advisory only, falls back to rules |
| Sensor readings: tank level, turbidity, conductivity, temperature, battery | **Synthetic** |
| Tank rising after a confirmed delivery | **Simulated.** In the field, the next real sensor reading would measure it |
| Households, trucks, tank sizes, baselines, village water | **Synthetic / configured assumptions** |
| Railway PostgreSQL deployment | Supported by the code; **not yet verified end-to-end** |
| Physical sensors (commercial LoRaWAN or custom ESP32 gateway) | **Future integration** |
| Offline monitoring directly on the tablet | **Future work** |

## Quick start

Requires **Node.js 22+**.

```bash
npm install
npm run dev
```

- Open **http://localhost:8080**.
- Municipality PIN: **2026**. This is a prototype gate, not authentication.
- With no `DATABASE_URL`, the server uses an **embedded, in-memory PostgreSQL (PGlite)** seeded with synthetic data.
- To reset the data, restart `npm run dev`. To sign a browser out and clear its cache, open `http://localhost:8080/?reset=1`.
- To use several roles at once, give each one its own origin: `http://localhost:8080`, `http://127.0.0.1:8080`, and a private window. Screens refresh every 15 s; press F5 to see a change immediately.

A step-by-step judge demo is in **[docs/DEMO.md](docs/DEMO.md)**.

### AI delivery risk assessment (optional)

Tank level alone does not always say who needs water first. Two tanks can hold the same number of litres while one household uses water twice as fast.

On a municipality household page, **Assess risk** sends that household's *existing* Imaq data to OpenAI through the server. The data sent is:
- tank % now and 6, 12 and 24 h ago, and estimated litres;
- daily use and last-12 h use;
- residents and vulnerability flag;
- last and next delivery;
- any low-water report and the monitor status.

The card then shows a structured, **advisory** assessment: priority (LOW / MEDIUM / HIGH / CRITICAL), a one-line reason, a recommendation, and an approximate time to empty (only when the level and daily use are known).

To enable it:

```bash
# .env (git-ignored) in the project folder
OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o-mini   (default)
```

Then restart `npm run dev`. The startup line shows `AI assessment: OpenAI`.

Safeguards:
- **The key never reaches the browser.** The call is server-side and municipality-only.
- **The output is validated.** Model: `gpt-4o-mini`, temperature 0, strict JSON schema. The server checks the answer before showing it.
- **It is decision support only.** It never changes data or dispatches a truck, and the operator makes the final decision.
- **The app keeps working without it.** No key, a timeout (15 s), an error or invalid JSON all give Imaq's rule-based priority, clearly labelled.

Code: [`server/ai-assessment.mjs`](server/ai-assessment.mjs).

## How it works (short)

```
SyntheticSensorProvider (today)        field sensor + gateway (future)
            │   same canonical payload  │
            ▼                           ▼
     POST /api/sensor-readings  →  validation  →  sensor_readings
                                                    │
Browser (PWA) ── GET /api/state ──► Imaq API ──► PostgreSQL
   │             POST actions                         (PGlite locally / Railway)
   └─ pure engines in the browser: tank.js · detection.js · analysis.js · priority.js · routes.js
```

- **The browser never connects to the database.** `DATABASE_URL` is read only by the server.
- **Tank level** = (tank height − sensor distance) ÷ tank height. This **assumes volume is linear with height**; real tanks may need a calibration table.
- **Unknown is never empty.** A missing, stale (> 30 min) or impossible reading gives *Unknown*, not 0.
- **A sensor failure is not low water.** An unknown tank is planned from the delivery schedule and flagged as maintenance.
- **Water supply ≠ water condition.** A tank can be 25 % full with NORMAL condition.
- **Priority** = days of water left, adjusted for a low-water report (−2), vulnerability (−0.5), delay (−0.5) and overdue delivery (−0.5). These are deterministic, explainable rules, not AI.

Details:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data flow, database, offline behaviour
- [docs/CALCULATIONS.md](docs/CALCULATIONS.md): tank, consumption, detection, priority, routing
- [docs/API.md](docs/API.md): endpoints and the sensor payload contract
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md): known issues, security boundary, field-validation needs

## Offline: what it does and does not do

| | Today |
|---|---|
| App opens without Internet | ✅ (service worker) |
| Shows last synced data, labelled "Offline" | ✅ read-only |
| Resident "check my water" questionnaire | ✅ saved on the device only |
| Low-water report, delivery, notices offline | ❌ refused with a clear message, never faked or queued |
| Sensor monitoring without Internet | ❌ requires local edge monitoring (future) |
| Offline sync between devices | ❌ |

## Tests

```bash
npm test            # 57 unit + database + API + cross-role + AI-fallback tests (OpenAI mocked)
npm run test:e2e    # 70 browser checks (Playwright + axe-core) on a fresh database
```

`npm run test:e2e` needs Chromium once: `npx playwright install chromium`.

The tests cover:

- tank maths and the sensor payload contract;
- detection invariants (a sensor fault can never be NORMAL);
- CRUD and the four cross-role flows, checked in the database;
- offline honesty;
- axe accessibility and 48 px touch targets on every screen;
- a scientific-wording audit in English and French.

All tests run on embedded PostgreSQL (PGlite). The `pg` / Railway connection path is not covered by automated tests.

## Deploy (Railway)

1. Create a project with a **PostgreSQL** service and a service from this repository.
2. On the app service, set:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `NODE_ENV=production`
   - `IMAQ_ADMIN_PIN=<your pin>`. It is required: without it, municipality sign-in is refused.
   - optionally `IMAQ_DEVICE_KEY`
   - optionally `OPENAI_API_KEY` (and `OPENAI_MODEL`) for the AI risk assessment
3. Deploy. `railway.json` runs `npm start` with a health check on `/api/health`. The schema is created on first start and an empty database is seeded with the synthetic data.
4. Check that `GET /api/health` returns `"db":"postgres"`.
5. To reseed: run `npm run seed` with `DATABASE_URL` set to the database's **public** connection URL (it is destructive).

## Project structure

```
index.html, css/, icons/, manifest.webmanifest, sw.js   PWA shell
js/app.js                     composition root, routing, dialogs
js/ops/                       store, API repository, selectors, priority, routes
js/core/tank.js               tank / litres / consumption / days
js/detection.js, analysis.js  water-condition status engine
js/sensor-data.js             sensor payload contract + normalization
js/ui/                        welcome, resident, driver, municipality views
js/i18n.js                    English / French (Inuktitut: see below)
server/                       HTTP server, API, database, schema, seed, synthetic sensors, AI assessment
data/                         synthetic seed data (generated by tools/generate-data.mjs)
tools/                        data generator, post-a-reading CLI
tests/                        node:test suites + Playwright e2e
docs/                         documentation
```

## Languages

The interface is available in English and French. **Inuktitut** shows only three words (Imaq ᐃᒪᖅ, Inuktitut ᐃᓄᒃᑎᑐᑦ, Inukjuak ᐃᓄᑦᔪᐊᖅ); everything else falls back to English, marked for screen readers. No machine translation is used. Translation must be done and reviewed by community speakers.

## Before any real deployment

- Choose sensor hardware and validate it in the field: tank geometry, mounting, condensation, freezing, battery, connectivity (LoRaWAN or gateway), maintenance.
- Build tank-specific calibration tables.
- Establish measured water-condition baselines and validate thresholds against laboratory results.
- Add local edge detection on the household tablet so warnings work without Internet.
- Add real authentication, per-device keys and data governance.
- Consult the community, operators and drivers, including Inuktitut translation by community speakers.

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full list.

## License

[MIT](LICENSE)
