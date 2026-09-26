import { readFile } from 'node:fs/promises';

export const ROOT = new URL('../', import.meta.url);
export const NOW = Date.UTC(2026, 9, 3, 18, 0, 0); // an arbitrary "today", unrelated to the recording dates

/** fetch() over the local file system, so tests read the real data/ files. */
export function fsFetch(overrides = {}) {
  return async (url) => {
    if (url in overrides) {
      const v = overrides[url];
      return v === 404 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => structuredClone(v) };
    }
    try {
      const text = await readFile(new URL(url, ROOT), 'utf8');
      return { ok: true, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, json: async () => ({}) };
    }
  };
}

export function makeClock(start = NOW) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  return clock;
}

export function memoryBackend() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
