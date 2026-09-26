/**
 * ApiRepository — the only browser module that talks to the Imaq API.
 * UI → OperationalStore → Repository. Swapping infrastructure (another backend,
 * a local edge gateway) means writing another repository, not touching the UI.
 * The browser never connects to PostgreSQL.
 */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.offline = status === 0;
  }
}

export class ApiRepository {
  constructor({ baseUrl = 'api/', fetchImpl, getAdminPin = () => null } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl || ((u, o) => globalThis.fetch(u, o));
    this.getAdminPin = getAdminPin;
  }

  async #req(method, path, body, { admin = false, pin } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const p = pin ?? (admin ? this.getAdminPin() : null);
    if (p) headers['X-Imaq-Admin-Pin'] = p;
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch {
      throw new ApiError(0, 'offline');
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) throw new ApiError(res.status, (json && json.error) || `HTTP ${res.status}`, json && json.details);
    return json;
  }

  load() { return this.#req('GET', 'state'); }
  verifyAdminPin(pin) { return this.#req('POST', 'session/admin', { pin }, { pin }); }

  // resident
  reportLowWater(householdId) { return this.#req('POST', `households/${encodeURIComponent(householdId)}/low-water-reports`, {}); }
  // driver
  confirmDelivery({ householdId, truckId, litres }) { return this.#req('POST', 'deliveries', { householdId, truckId, litres }); }
  refillTruck(truckId) { return this.#req('POST', `trucks/${encodeURIComponent(truckId)}/refill`, {}); }
  setTruckStatus(truckId, status) { return this.#req('POST', `trucks/${encodeURIComponent(truckId)}/status`, { status }); }
  // municipality
  createAlert({ type, message }) { return this.#req('POST', 'alerts', { type, message }, { admin: true }); }
  endAlert(id) { return this.#req('POST', `alerts/${encodeURIComponent(id)}/end`, {}, { admin: true }); }
  saveHousehold(h, isNew) {
    return isNew ? this.#req('POST', 'households', h, { admin: true }) : this.#req('PUT', `households/${encodeURIComponent(h.id)}`, h, { admin: true });
  }
  archiveHousehold(id, archived = true) { return this.#req('POST', `households/${encodeURIComponent(id)}/archive`, { archived }, { admin: true }); }
  saveTruck(t, isNew) {
    return isNew ? this.#req('POST', 'trucks', t, { admin: true }) : this.#req('PUT', `trucks/${encodeURIComponent(t.id)}`, t, { admin: true });
  }
  archiveTruck(id, archived = true) { return this.#req('POST', `trucks/${encodeURIComponent(id)}/archive`, { archived }, { admin: true }); }
  registerSensor(s) { return this.#req('POST', 'sensors', s, { admin: true }); }
  updateSensor(id, patch) { return this.#req('PUT', `sensors/${encodeURIComponent(id)}`, patch, { admin: true }); }
}
