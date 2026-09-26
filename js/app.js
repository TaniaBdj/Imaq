/**
 * App shell: bootstraps the shared OperationalStore, the sensor provider and the
 * session, then routes each role to its own screens and navigation.
 */
import { createStorage } from './storage.js';
import { createOperationalStore, CACHE_KEY } from './ops/store.js';
import { ApiRepository } from './ops/api-repository.js';
import { createSession, SESSION_KEY } from './session.js';
import { LANG_OPTIONS } from './i18n.js';
import { ctx, t, $, $$, el, icon, setText, clockTime } from './ui/common.js';
import { renderWelcome, renderResidentSelect, renderDriverSelect, renderAdminLogin } from './ui/welcome.js';
import { renderResidentHome, renderNotices, renderWater, renderResidentHistory, bindCheckForm, resetCheckForm } from './ui/resident.js';
import { renderDriverRoute, renderDriverTruck, renderDriverHistory } from './ui/driver.js';
import { renderAdminOverview, renderAdminHouseholds, resetAdminHouseholds, renderAdminHousehold, renderAdminTrucks, renderAdminAlerts, renderAdminSensors, renderHouseholdForm, renderTruckForm } from './ui/admin.js';

const TICK_MS = 15_000;

// ---- Composition root: the only place that chooses infrastructure. ----
// Browser → ApiRepository → Imaq API → PostgreSQL (the browser never talks to the database).
const storage = createStorage();
const session = createSession(storage);
const repository = new ApiRepository({ baseUrl: 'api/', getAdminPin: () => session.adminPin });
const ops = createOperationalStore({ repository, storage });
ctx.ops = ops;
ctx.session = session;

// ---------- Routes & navigation per role ----------
const ROUTES = [
  { path: '', view: 'welcome' },
  { path: 'resident', view: 'resident-select' },
  { path: 'driver', view: 'driver-select' },
  { path: 'municipality', view: 'admin-login' },
  { path: 'help', view: 'help', role: 'any' },
  { path: 'home', view: 'home', role: 'resident', nav: 'home' },
  { path: 'water', view: 'water', role: 'resident', nav: 'water' },
  { path: 'check', view: 'check', role: 'resident', nav: 'home' },
  { path: 'history', view: 'history', role: 'resident', nav: 'history' },
  { path: 'route', view: 'driver-route', role: 'driver', nav: 'route' },
  { path: 'truck', view: 'driver-truck', role: 'driver', nav: 'truck' },
  { path: 'deliveries', view: 'driver-history', role: 'driver', nav: 'deliveries' },
  { path: 'admin', view: 'admin-overview', role: 'municipality', nav: 'admin' },
  { path: 'admin/households', view: 'admin-households', role: 'municipality', nav: 'households' },
  { path: 'admin/household-new', view: 'admin-form', form: 'household', role: 'municipality', nav: 'households' },
  { path: 'admin/household/:id/edit', view: 'admin-form', form: 'household', role: 'municipality', nav: 'households' },
  { path: 'admin/household/:id', view: 'admin-household', role: 'municipality', nav: 'households' },
  { path: 'admin/trucks', view: 'admin-trucks', role: 'municipality', nav: 'trucks' },
  { path: 'admin/truck-new', view: 'admin-form', form: 'truck', role: 'municipality', nav: 'trucks' },
  { path: 'admin/truck/:id/edit', view: 'admin-form', form: 'truck', role: 'municipality', nav: 'trucks' },
  { path: 'admin/sensors', view: 'admin-sensors', role: 'municipality', nav: 'sensors' },
  { path: 'admin/alerts', view: 'admin-alerts', role: 'municipality', nav: 'alerts' },
];
const NAVS = {
  resident: [['home', '#/home', 'i-home', 'nav.home'], ['water', '#/water', 'i-glass', 'nav.water'], ['history', '#/history', 'i-list', 'nav.history'], ['help', '#/help', 'i-info', 'nav.help']],
  driver: [['route', '#/route', 'i-route', 'nav.route'], ['truck', '#/truck', 'i-truck', 'nav.truck'], ['deliveries', '#/deliveries', 'i-list', 'nav.deliveries']],
  municipality: [['admin', '#/admin', 'i-grid', 'nav.overview'], ['households', '#/admin/households', 'i-home', 'nav.households'], ['trucks', '#/admin/trucks', 'i-truck', 'nav.trucks'], ['sensors', '#/admin/sensors', 'i-offline', 'nav.sensors'], ['alerts', '#/admin/alerts', 'i-bell', 'nav.alerts']],
};
const HOME = { resident: '#/home', driver: '#/route', municipality: '#/admin' };

function matchRoute() {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0].replace(/\/$/, '');
  const parts = path.split('/');
  for (const r of ROUTES) {
    const rp = r.path.split('/');
    if (rp.length !== parts.length) continue;
    const params = {};
    const ok = rp.every((seg, i) => {
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
        return parts[i] !== '';
      }
      return seg === parts[i];
    });
    if (ok) return { ...r, params };
  }
  return { ...ROUTES[0], params: {} };
}

/** Route guard: role screens need the matching role; signed-in users skip the welcome page. */
function guard(route) {
  const role = session.current.role;
  if (route.role && route.role !== 'any' && route.role !== role) return role ? HOME[role] : '#/';
  if (route.view === 'welcome' && role) return HOME[role];
  return null;
}

// ---------- Confirm dialog (Promise-based) ----------
function confirmDialog({ title, body, confirmLabel, tone = 'primary', input = null }) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  const bodyHost = $('#confirm-body');
  bodyHost.replaceChildren(typeof body === 'string' ? el('p', {}, body) : body);
  const field = $('#confirm-field');
  const inputEl = $('#confirm-input');
  const err = $('#confirm-error');
  err.textContent = '';
  field.hidden = !input;
  if (input) {
    $('#confirm-input-label').textContent = input.label;
    $('#confirm-suffix').textContent = input.suffix || '';
    inputEl.value = String(input.value ?? '');
    inputEl.min = String(input.min ?? '');
    inputEl.max = String(input.max ?? '');
    inputEl.removeAttribute('aria-invalid');
  }
  const ok = $('#confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn btn-xl ${tone === 'danger' ? 'btn-danger' : tone === 'warn' ? 'btn-warn' : 'btn-primary'}`;
  setText($('#confirm-cancel'), 'cancel');
  return new Promise((resolve) => {
    const cleanup = (result) => {
      ok.removeEventListener('click', onOk);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const onOk = (e) => {
      e.preventDefault();
      if (input) {
        const v = Number(inputEl.value);
        if (!Number.isFinite(v) || v < (input.min ?? -Infinity) || v > (input.max ?? Infinity)) {
          err.textContent = input.error || '';
          inputEl.setAttribute('aria-invalid', 'true');
          inputEl.focus();
          return;
        }
        cleanup({ ok: true, value: v });
      } else cleanup({ ok: true });
    };
    const onClose = () => cleanup({ ok: false });
    ok.addEventListener('click', onOk);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    (input ? inputEl : ok).focus();
    if (input) inputEl.select();
  });
}
ctx.confirm = confirmDialog;
let toastTimer = null;
ctx.toast = (text) => {
  const box = $('#toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 6000);
};
ctx.announce = (text) => {
  const a = $('#announcer');
  a.textContent = '';
  requestAnimationFrame(() => (a.textContent = text));
};

// ---------- Shell ----------
function renderShell(route, snap) {
  const s = session.current;
  document.documentElement.lang = s.lang;
  document.body.dataset.role = s.role || 'none';
  for (const node of $$('[data-i18n]')) setText(node, node.dataset.i18n);
  const ctxLine = $('#brand-context');
  if (s.role === 'resident') ctxLine.textContent = t('house.label', { id: s.householdId });
  else if (s.role === 'driver') ctxLine.textContent = t('truck.label', { id: s.truckId });
  else if (s.role === 'municipality') ctxLine.textContent = t('admin.context');
  else setText(ctxLine, 'tagline');
  $('#brand-link').setAttribute('href', s.role ? HOME[s.role] : '#/');
  $('#role-chip').hidden = !s.role;
  if (s.role) setText($('#role-chip'), `role.${s.role}`);
  $('#switch-role').hidden = !s.role;
  const sel = $('#lang-select');
  if (sel.value !== s.lang) sel.value = s.lang;
  $('#iu-note').hidden = s.lang !== 'iu';
  if (s.lang === 'iu') setText($('#iu-note'), 'iu.note');

  const nav = $('#tabbar');
  const items = NAVS[s.role] || [];
  nav.hidden = !items.length;
  nav.style.setProperty('--tabs', String(items.length || 1));
  nav.replaceChildren(...items.map(([key, href, ic, label]) =>
    el('a', { href, 'data-route': key, 'aria-current': route.nav === key ? 'page' : null }, icon(ic), el('span', { i18n: [label] }))));

  const sync = ops.sync;
  const banner = $('#sync-banner');
  banner.hidden = sync.online;
  if (!sync.online) banner.textContent = t('sync.offline', { time: sync.lastSync ? clockTime(sync.lastSync) : '—' });

  const showNotices = s.role === 'resident';
  if (showNotices) renderNotices(snap);
  else $('#notices').hidden = true;
}

function renderView(route, snap) {
  const s = session.current;
  switch (route.view) {
    case 'welcome': return renderWelcome();
    case 'resident-select': return renderResidentSelect(snap);
    case 'driver-select': return renderDriverSelect(snap);
    case 'admin-login': return renderAdminLogin();
    case 'home': return renderResidentHome(snap.households[s.householdId], snap);
    case 'water': return renderWater(snap.households[s.householdId]);
    case 'history': return renderResidentHistory(snap.households[s.householdId], snap);
    case 'driver-route': return renderDriverRoute(snap.trucks.find((x) => x.id === s.truckId), snap);
    case 'driver-truck': return renderDriverTruck(snap.trucks.find((x) => x.id === s.truckId), snap);
    case 'driver-history': return renderDriverHistory(snap.trucks.find((x) => x.id === s.truckId), snap);
    case 'admin-overview': return renderAdminOverview(snap);
    case 'admin-households': return renderAdminHouseholds(snap);
    case 'admin-household': return renderAdminHousehold(snap, route.params.id);
    case 'admin-trucks': return renderAdminTrucks(snap);
    case 'admin-alerts': return renderAdminAlerts(snap);
    case 'admin-sensors': return renderAdminSensors(snap);
    case 'admin-form': return route.form === 'truck' ? renderTruckForm(snap, route.params.id) : renderHouseholdForm(snap, route.params.id);
    default: return null;
  }
}

let currentView = null;
function render({ focus = false } = {}) {
  const route = matchRoute();
  const redirect = guard(route);
  if (redirect && redirect !== location.hash) {
    location.replace(redirect);
    return;
  }
  // A household/truck that no longer exists → back to role entry.
  const s = session.current;
  const snap = ops.snapshot();
  if ((s.role === 'resident' && !snap.households[s.householdId]) || (s.role === 'driver' && !snap.trucks.find((x) => x.id === s.truckId))) {
    session.signOut();
    location.replace('#/');
    return;
  }
  const viewKey = route.view + '|' + location.hash;
  const changedView = currentView !== viewKey;
  // Forms render once per visit so background refreshes never wipe what the user typed.
  if (!changedView && route.view === 'admin-form') {
    renderShell(route, snap);
    return;
  }
  if (changedView && route.view === 'check') resetCheckForm();
  if (changedView && route.view === 'admin-households') resetAdminHouseholds();
  for (const v of $$('.view')) v.hidden = v.dataset.view !== route.view;
  currentView = viewKey;
  renderShell(route, snap);
  renderView(route, snap);
  if (focus) {
    const h = $(`[data-view="${route.view}"] h1`);
    if (h) {
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }
}

async function init() {
  const sel = $('#lang-select');
  for (const o of LANG_OPTIONS) {
    const opt = el('option', { value: o.code }, o.label);
    if (o.code === 'iu') opt.setAttribute('lang', 'iu');
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    session.setLang(sel.value);
    resetAdminHouseholds();
    render();
  });
  $('#switch-role').addEventListener('click', () => {
    session.signOut();
    location.hash = '#/';
  });
  $('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close());
  bindCheckForm(() => session.current.householdId);

  // Hidden: ?reset=1 signs this device out and clears its cached data.
  // (The shared database is reset server-side with `npm run seed`, never from the web UI.)
  const params = new URLSearchParams(location.search);
  if (params.get('reset') === '1') {
    session.signOut();
    storage.remove(CACHE_KEY);
    history.replaceState(null, '', location.pathname + '#/');
  }
  try {
    await ops.init();
  } catch (e) {
    $('#main').replaceChildren(el('p', { class: 'card', role: 'alert' }, t('error.load')));
    document.body.classList.add('is-ready');
    return;
  }

  ops.subscribe(() => render());
  window.addEventListener('hashchange', () => render({ focus: true }));
  // Another tab/window on this device changed shared state (e.g. driver and household side by side).
  window.addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY) {
      session.reload();
      render();
    }
  });
  window.addEventListener('online', () => ops.refresh().catch(() => {}));
  window.addEventListener('offline', () => ops.refresh().catch(() => {}));
  render();
  document.body.classList.add('is-ready');
  setInterval(() => ops.tick(), TICK_MS);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

// Exposed for automated tests / debugging only.
window.__imaq = { ops, session, repository };
