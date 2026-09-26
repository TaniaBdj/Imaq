# Limitations and known issues

Imaq is a hackathon prototype. This page lists what it does **not** do yet, so that no one reads more into it than exists.

## Data and science

- **All sensor readings are synthetic.** Households, trucks, tank sizes, baselines and village water are invented. No Inukjuak data is used.
- **Turbidity, conductivity and temperature cannot detect bacteria, E. coli or pathogens.** NORMAL means "no unusual change detected".
- Water-condition **baselines are configured constants** (0.42 NTU, 86 µS/cm, 14.2 °C), the same for every household, including new ones. They are not measured.
- Two large sensor changes currently produce **ACTION** ("Follow local water guidance") even when no official advisory exists. ACTION should be reserved for official advisories.
- A **newly assigned monitor** starts from a synthetic 50 % level and immediately reports NORMAL.
- A tank-level-only device (no water-condition sensors), or a household with no monitor, shows **SYSTEM CHECK**. The app has no "water-condition monitoring not installed" state.
- Tank volume assumes **linear geometry**. The consumption estimate is **biased upward by sensor noise** (see [CALCULATIONS.md](CALCULATIONS.md)).
- Thresholds and priority weights are prototype values.

## Operations

- **Duplicate deliveries are accepted.** There is no idempotency key, so a retried request records two deliveries.
- **Delivered litres are not capped by the tank's free space.**
- **Drivers can only confirm the next stop.** Routes have no map or distance ordering.
- **Truck reassignment is computed on each client, not stored.**
- **Truck status changes have inconsistent side effects.**
  - Setting a truck out of service through the **edit form** does not create the truck-down alert (the status button does).
  - Archiving a truck creates no alert.
- A "refill" with no village water left still succeeds with 0 L.
- Resident water checks stay on the device and never reach the municipality.
- Delay notices go to every household and say "today".
- In the UI, an unknown tank level shows an empty bar. The text says "Unknown".

## AI delivery risk assessment

- **It is advisory only.** It never changes data or dispatches a truck, and the operator decides.
- **The model can misread details.** In testing it once described a household as having "no scheduled delivery for today" when Imaq had it on today's route. Always check the facts shown elsewhere on the page.
- **Answers can vary slightly between requests**, even at temperature 0.
- **Household operational data is sent to OpenAI.** The data sent is tank level and history, use, number of residents, vulnerability flag, delivery times, and any low-water report; no names or addresses. Today the data is synthetic. A real deployment would need a data-governance decision with the community, a privacy review, and possibly a self-hosted or regional model.
- **It needs Internet and an OpenAI account with credit.** Without them, Imaq shows its rule-based priority.
- The call is municipality-only, but there is no per-user rate limit or cost cap.

## Security (not production-ready)

- **Resident and driver endpoints are open.** Anyone who can reach the API can file reports, record deliveries or change truck status.
- **The municipality PIN** is a shared secret: stored in the browser, never rate-limited, defaulting to `2026` outside production.
- **Sensor authentication** is one optional shared key; there are no per-device keys.
- **There is no audit log.**

## Connectivity

- Offline means **read-only last synced data**. There is no offline sensing, no offline writes and no sync.
- Each open screen downloads the full state (about 135 KB) every 15 s. That is not low-bandwidth.

## Engineering

- Automated tests run only on embedded PostgreSQL. The Railway (`pg`) path has **not been tested end-to-end**.
- Some multi-step admin operations (archive, sensor reassignment) are not wrapped in a transaction.
- Time zones are mixed. The data generator uses UTC, the synthetic day/night profile uses server time, and "today" uses device time.
- Reassigning a sensor deletes its previous readings.

## Field validation required

Hardware choice, installation, calibration, freezing and condensation behaviour, battery life, LoRaWAN or gateway coverage, power outages, maintenance ownership and cost, lab validation of thresholds, local edge detection, data governance, and consultation with residents, operators and drivers. Inuktitut must be translated and reviewed by community speakers.
