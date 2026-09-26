# Calculations

All calculations are pure functions with unit tests. Every threshold and weight below is a **prototype value** that needs field validation.

## Tank (`js/core/tank.js`)

| Value | Formula | When unknown |
|---|---|---|
| Level % | `(tankHeightCm − distanceCm) ÷ tankHeightCm × 100`, clamped to 0–100 | Missing, negative or > height + 10 cm distance → `null` |
| Litres | `tankCapacityL × level ÷ 100` | Unknown level → `null`, never 0 |
| Daily use | Average fall in litres over the **declining** segments of the last 48 h, rounded to 10 L/day. Rises (deliveries) are excluded and gaps over 6 h are skipped. Needs at least 12 h of data | Falls back to `configured_daily_use_l` (`source: "configured"`) |
| Days remaining | `litres ÷ daily use`, shown as "About N days", "About 1 day" or "Less than 1 day" | "Unknown" |

A reading older than **30 min** is stale: the tank level becomes Unknown. A monitor silent for more than **2 h** is OFFLINE.

**Assumptions to keep in mind:**
- **Geometry.** Volume is assumed linear with height (an upright tank). Horizontal cylinders and irregular tanks need a calibration table.
- **Noise.** The consumption estimate sums every downward step and ignores small upward steps. With real sensor noise of about ±1 cm, it would *overestimate* use, and therefore underestimate days remaining. A regression over the window would be more robust.

## Water-condition status (`js/detection.js`, `js/analysis.js`)

Each reading is compared with the household **baseline**. Today the baseline is a configured value, the same for every household. After a detected delivery (a level rise of ≥ 15 points), the baseline is refreshed from the new water if that water looks normal.

| Parameter | Changed | Large change |
|---|---|---|
| Turbidity | rise ≥ +1.0 NTU | rise ≥ +4.0 NTU |
| Conductivity | ±20 % | ±50 % |
| Temperature | ±8 °C (context only) | — |

Status is decided in this order, most cautious first:

1. An official **advisory** is active → **ACTION**.
2. A missing, invalid, stale (> 30 min) or future reading → **SYSTEM CHECK**.
3. Two or more large changes → **ACTION** *(see LIMITATIONS: this should become CHECK)*.
4. Any change → **CHECK WATER**.
5. Otherwise → **NORMAL**, meaning no unusual change detected.

**Invariant:** a sensor fault never produces NORMAL or CHECK. This is enforced in code and covered by a property test.

## Priority (`js/ops/priority.js`)

```
score = days remaining
        − 2    resident low-water report
        − 0.5  vulnerability flag
        − 0.5  delivery delayed (no truck / route full)
        − 0.5  delivery overdue by more than 12 h (only when the level is known)

HIGH ≤ 0.5 < MEDIUM ≤ 2 < LOW
```

When the tank level is unknown, the score is `days until the scheduled delivery + 1`. A sensor failure never raises supply priority; it is tracked separately as monitor maintenance.

Suggested delivery amount = litres needed to fill the tank, rounded to 50 L.

## Routes (`js/ops/routes.js`)

1. Each household belongs to its assigned truck. If that truck is out of service or archived, the household moves (most urgent first) to the operating truck with the fewest households.
2. A household is on **today's** route if it has not been served today, and either it is due by the end of today or its priority is HIGH.
3. Each truck's stops are sorted by score. A truck makes at most 6 stops per day; the rest move to tomorrow and count as delayed.
4. With no operating truck, deliveries are delayed.

Priority is computed twice: a first pass finds delayed households, and the second pass includes the delay weight. Routes have no map or distance optimisation. "Today" uses the device's local time.
