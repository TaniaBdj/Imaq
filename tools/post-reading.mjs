/**
 * Send ONE canonical sensor payload to an Imaq API — exactly what an ESP32
 * gateway will do in the field. Useful to demonstrate the sensor contract.
 *
 *   node tools/post-reading.mjs --url http://localhost:8080 --device IMQ-0031 --distance 60
 *
 * Optional: --turbidity 0.4 --conductivity 86 --temperature 14 --battery 80
 * Uses IMAQ_DEVICE_KEY from the environment if the server requires it.
 */
import { makeSensorPayload } from '../js/sensor-data.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const num = (v) => (v === undefined ? undefined : Number(v));
const url = (args.url || 'http://localhost:8080').replace(/\/$/, '');
const payload = makeSensorPayload({
  deviceId: args.device || 'IMQ-0031',
  ts: Date.now(),
  distanceCm: num(args.distance ?? 60),
  turbidity: num(args.turbidity ?? 0.42),
  conductivity: num(args.conductivity ?? 86),
  temperature: num(args.temperature ?? 14),
  batteryPercent: num(args.battery ?? 80),
});
const headers = { 'Content-Type': 'application/json' };
if (process.env.IMAQ_DEVICE_KEY) headers['X-Imaq-Device-Key'] = process.env.IMAQ_DEVICE_KEY;
const res = await fetch(`${url}/api/sensor-readings`, { method: 'POST', headers, body: JSON.stringify(payload) });
console.log(JSON.stringify(payload, null, 2));
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
