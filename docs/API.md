# API

Base path: `/api/`. JSON in and out, request bodies limited to 64 KB.

Errors return `{ "error": "...", "details": [...] }` with a 4xx status, or `{ "error": "Internal error" }` with 500. No stack traces are returned.

Access levels:
- **admin**: the request needs the header `X-Imaq-Admin-Pin`.
- **device**: the request needs `X-Imaq-Device-Key`, only if `IMAQ_DEVICE_KEY` is set.
- **open**: no check (prototype).

| Method | Path | Access | Effect |
|---|---|---|---|
| GET | `/api/health` | open | `{ ok, db }`. `db` is `postgres` or `embedded-postgres (...)` |
| GET | `/api/state` | open | Households, trucks, sensors, readings from the last 49 h, deliveries from the last 30 days, open and recent reports, active and recent alerts, settings. It also triggers the synthetic sensor catch-up |
| POST | `/api/session/admin` | open | `{ pin }` → 200 or 401 |
| POST | `/api/sensor-readings` | device | Canonical payload (below) → stored reading |
| POST | `/api/households/:id/low-water-reports` | open | Opens a report (idempotent while one is open) |
| POST | `/api/deliveries` | open | `{ householdId, truckId, litres }`. In one transaction: records the delivery, subtracts litres from the truck, resolves the open report. 409 if the truck is out of service or has too little water |
| POST | `/api/trucks/:id/refill` | open | Tops the truck up from `village_water_m3` and increments the trip counter |
| POST | `/api/trucks/:id/status` | open | `{ status: "IN_SERVICE" \| "OUT_OF_SERVICE" }`. Out of service creates an `ops_truck_down` alert listing affected households; back in service ends it |
| POST | `/api/alerts` | admin | `{ type: advisory \| delay \| conserve \| all_clear, message? }`. `all_clear` ends every public notice |
| POST | `/api/alerts/:id/end` | admin | Ends one notice |
| POST | `/api/households/:id/ai-assessment` | admin | `{ lang?: "en" \| "fr" }`. Returns an **advisory** assessment and writes nothing. See below |
| POST | `/api/households` | admin | Create a household |
| PUT | `/api/households/:id` | admin | Edit a household |
| POST | `/api/households/:id/archive` | admin | `{ archived: true \| false }`. Archiving unassigns its sensor |
| POST | `/api/trucks` | admin | Create a truck |
| PUT | `/api/trucks/:id` | admin | Edit a truck. Send `currentWaterL`; if it is missing it defaults to capacity |
| POST | `/api/trucks/:id/archive` | admin | `{ archived }` |
| POST | `/api/sensors` | admin | `{ serialNumber, householdId? }` registers a monitor |
| PUT | `/api/sensors/:id` | admin | `{ householdId?, status?: "SERVICE_REQUIRED" \| "ONLINE" }`. Assigning a monitor to a new household deletes its previous readings |

## AI delivery risk assessment

`POST /api/households/H-024/ai-assessment` with the header `X-Imaq-Admin-Pin`.

Response when OpenAI answered:

```json
{
  "source": "openai",
  "model": "gpt-4o-mini",
  "priority": "MEDIUM",
  "reason": "Water level is decreasing rapidly, and next delivery is overdue.",
  "recommendedAction": "Schedule a delivery soon to prevent shortages.",
  "estimatedTimeToEmpty": "about 3 days"
}
```

Response when Imaq falls back to its rules:

```json
{
  "source": "rules",
  "fallbackReason": "not_configured",
  "priority": "LOW",
  "reason": "Rule-based priority: about 3 day(s) of water left.",
  "recommendedAction": "No change to the regular delivery schedule.",
  "estimatedTimeToEmpty": "about 3 days"
}
```

- **What is sent.** The server builds the household context from the same derived state every role uses (`js/ops/selectors.js`). It sends it to OpenAI Chat Completions with `temperature: 0` and a strict `json_schema` response format.
- **How the answer is checked.** `priority` must be `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`. `reason` and `recommendedAction` must be non-empty strings. `estimatedTimeToEmpty` is a string or null, and it is **forced to null** when Imaq does not know the tank level or the daily use.
- **When it falls back.** `fallbackReason` is one of:
  - `not_configured`: `OPENAI_API_KEY` is not set;
  - `openai_http_<status>`: OpenAI returned an error status;
  - `invalid_response`: the answer failed the checks above;
  - `timeout`: no answer within 15 s;
  - `unavailable`: a network error.
- **Key handling.** `OPENAI_API_KEY` is read only on the server and is never returned.

## Household fields

| Field | Type | Range | Default |
|---|---|---|---|
| `id` | string | 1–24 of `A-Z 0-9 _ -` | required |
| `residentsCount` | integer | 1–30 | required |
| `tankCapacityL` | integer | 100–50,000 | required |
| `tankHeightCm` | number | 20–500 | required |
| `configuredDailyUseL` | integer | 1–5,000 | residents × 60 |
| `deliveryIntervalDays` | integer | 1–14 | 2 |
| `vulnerability` | enum | `elder`, `infant`, `medical`, or null | null |
| `assignedTruckId` | string | existing truck | null |

## Truck fields

| Field | Type | Range | Default |
|---|---|---|---|
| `id` | string | 1–24 of `A-Z 0-9 _ -` | required |
| `displayName` | string | max 40 characters | — |
| `capacityL` | integer | 100–100,000 | required |
| `currentWaterL` | integer | 0–capacity | capacity |
| `status` | enum | `IN_SERVICE`, `OUT_OF_SERVICE` | — |

## Sensor payload contract

```json
{
  "deviceId": "IMQ-0031",
  "timestamp": "2026-09-26T13:00:00Z",
  "tank":   { "distanceCm": 102 },
  "water":  { "turbidity": 0.42, "conductivity": 87, "temperature": 13.8 },
  "device": { "batteryPercent": 84 }
}
```

A payload is rejected unless:
- the device exists and is assigned to a household (otherwise 404 or 409);
- `timestamp` parses as a date and is no more than 5 min in the future;
- `tank.distanceCm` is present, numeric, and at most the tank height + 10 cm (otherwise 422);
- `water.*` values are numbers within their ranges, or `null`;
- `device.batteryPercent` is between 0 and 100.

A `null` water value is stored as a sensor fault; the detection engine turns it into **SYSTEM CHECK**.

To send one reading by hand:

```bash
npm run post-reading -- --url http://localhost:8080 --device IMQ-0031 --distance 60
```
