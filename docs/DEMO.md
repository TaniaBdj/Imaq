# Demo guide (about 3 minutes, local)

## Setup (5 minutes before)

```bash
npm install
npm run dev
```

- Open `http://localhost:8080/?reset=1`. Municipality PIN: **2026**.
- **Restart `npm run dev` to reset the data.** The database is in memory. `npm run seed` does not reset the running local server, because without `DATABASE_URL` it seeds a separate database.
- Give each role its own window and origin:
  - Resident: `http://localhost:8080`
  - Driver: `http://127.0.0.1:8080`
  - Municipality: a private window
- Screens refresh every 15 s. Press **F5** to see a change immediately.
- Keep the laptop awake while the server runs.

## Script

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 | Resident, House **H-031** | Show 25 %, "About N days", **NORMAL** | "Water *amount* and water *condition* are separate. A low tank is not bad water." |
| 0:20 | Resident | **My low-water light is on** → confirm | "One tap, saved to the shared database." |
| 0:40 | Municipality | H-031 is first, **HIGH**, with reasons: low-water light, elder | "Priority is explainable rules, not AI." |
| 1:00 | Driver, Truck **T2** | H-031 is the next stop, ~1,150 L → **Delivered** → confirm | "Truck water goes from 6,800 to 5,650 L." |
| 1:30 | Resident H-031 (F5) | Tank ~95 %, report cleared, history shows "Water delivered" | "The tank reading after delivery is simulated here. In the field, the real sensor measures it." |
| 1:50 | Driver T2 | **Report truck problem** → confirm | |
| 2:05 | Municipality | Trucks 2/3, banner listing affected houses, routes recalculated | |
| 2:20 | Municipality → Alerts | **Delivery delay**, note "Truck T2 is being repaired" → send | |
| 2:35 | Resident **H-012** | Notice and note, "Reassigned to Truck T1/T3" | |
| 2:45 | Resident **H-044** | **SYSTEM CHECK**, tank **Unknown** | "If the monitor fails we say *unknown*, never *normal* or *empty*. A broken sensor is not low water." |

### AI step (30 seconds, needs `OPENAI_API_KEY` in `.env`)

| Screen | Do | Say |
|---|---|---|
| Municipality → Households → **H-024** | **Assess risk** | "52 %, six residents, about 360 L a day." |
| Back → **H-071** | **Assess risk** | "68 %, about the same litres, but three residents using half as much. Tank level alone doesn't tell us who needs water first." |
| Point to the card footer | | "The AI only explains the data we already have. It's advisory; the operator decides, and without the AI Imaq falls back to its own rules." |

Run both households once before presenting: answers can vary slightly. If the card says "AI unavailable", the key or credit is missing and Imaq is showing its rule-based priority. That still demonstrates the fallback.

## Avoid

- Registering or assigning a new sensor. It starts from a synthetic 50 % reading.
- Failing truck T2 before the delivery. An out-of-service truck cannot deliver.
- Saying "live data", "safe water", "works fully offline" or "deployed".

## Short, honest answers

- **Where does the data come from?** It is synthetic. No hardware is installed and no Inukjuak data is used. The API, database, calculations and interfaces are real.
- **Does it detect E. coli?** No. NORMAL means no measured change. It is not a safety test.
- **What happens offline?** The app opens and shows the last synced data read-only. Actions need a connection. Monitoring on the tablet itself is future work.
- **Is it secure?** The PIN is a prototype gate. Resident and driver actions are open in this prototype.
- **Does the AI decide deliveries?** No. It reads the household's existing data and explains a suggested priority; it cannot change anything. The operator decides. If OpenAI is down, Imaq uses its own transparent rules.
- **What data goes to OpenAI?** Tank level and history, use, number of residents, vulnerability flag and delivery times for one household. There are no names or addresses, and today it is all synthetic. A real deployment would need the community's agreement on data governance.
