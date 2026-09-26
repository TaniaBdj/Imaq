/**
 * Fault-tolerant persistence. Falls back to in-memory storage if localStorage is
 * unavailable (private mode, blocked storage, quota errors).
 */

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

export function createStorage(backend) {
  let store = backend;
  let persistent = true;
  if (!store) {
    try {
      store = globalThis.localStorage;
      const probe = '__imaq_probe__';
      store.setItem(probe, '1');
      store.removeItem(probe);
    } catch {
      store = null;
    }
  }
  if (!store) {
    store = memoryStore();
    persistent = false;
  }

  return {
    persistent,
    load(key) {
      try {
        const raw = store.getItem(key);
        return raw == null ? null : JSON.parse(raw);
      } catch {
        return null; // corrupt JSON or access error: treat as no saved state
      }
    },
    save(key, value) {
      try {
        store.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        store.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
