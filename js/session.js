/**
 * Role access (PROTOTYPE). The municipality PIN is verified by the API
 * (POST /api/session/admin, IMAQ_ADMIN_PIN on the server) and then sent with
 * municipality requests. This is NOT authentication; see README.
 *
 * This is role SELECTION, not authentication. It is shaped like an access
 * provider so a real identity service (e.g. municipal SSO, Supabase Auth) can
 * replace LocalRoleAccess without changing the UI:
 *
 *   signInResident(householdId) · signInDriver(truckId) · signInMunicipality(pin) · signOut()
 */
export const SESSION_KEY = 'imaq.session.v1';
export const ROLES = ['resident', 'driver', 'municipality'];
const LANGS = ['en', 'fr', 'iu'];

function fresh() {
  return { role: null, householdId: null, truckId: null, lang: 'en', lastHouseholdId: null, lastTruckId: null };
}

export function createSession(storage) {
  const saved = storage.load(SESSION_KEY);
  let s = { ...fresh(), ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!ROLES.includes(s.role)) s.role = null;
  if (!LANGS.includes(s.lang)) s.lang = 'en';
  const listeners = new Set();
  const save = () => {
    storage.save(SESSION_KEY, s);
    for (const fn of listeners) fn();
  };
  return {
    get current() {
      return s;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    signInResident(householdId) {
      s = { ...s, role: 'resident', householdId, truckId: null, lastHouseholdId: householdId };
      save();
    },
    signInDriver(truckId) {
      s = { ...s, role: 'driver', truckId, householdId: null, lastTruckId: truckId };
      save();
    },
    /** Call after the API accepted the PIN. @returns {boolean} */
    signInMunicipality(pin) {
      const p = String(pin ?? '').trim();
      if (!p) return false;
      s = { ...s, role: 'municipality', householdId: null, truckId: null, adminPin: p };
      save();
      return true;
    },
    get adminPin() {
      return s.role === 'municipality' ? s.adminPin || null : null;
    },
    signOut() {
      s = { ...s, role: null, householdId: null, truckId: null, adminPin: null };
      save();
    },
    setLang(lang) {
      if (!LANGS.includes(lang)) return;
      s = { ...s, lang };
      save();
    },
    reload() {
      const v = storage.load(SESSION_KEY);
      if (v && typeof v === 'object') s = { ...fresh(), ...v };
    },
  };
}
