/**
 * MUNICIPALITY / ADMIN views — the operational dashboard.
 * Shows operational data only (no names or personal details).
 */
import {
  ctx, t, $, $$, el, icon, litres, pct, shortWhen, relativeTime, statusBadge, priorityBadge, sensorBadge,
  daysText, deliveryText, reasonText, tankBar, runAction, STATUS_ICON, PARAM_VISUAL,
} from './common.js';
import { STATUS, PARAM, SENSORS } from '../detection.js';
import { ALERT_TYPES } from '../ops/store.js';

const FILTERS = ['all', 'normal', 'attention', 'low', 'monitor'];
const ui = { filter: 'all', query: '', alertType: 'delay' };
const go = (hash) => { location.hash = hash; };

function kpi(id, value, labelKey, tone, sub) {
  return el('div', { class: `kpi${tone ? ` kpi-${tone}` : ''}`, id }, el('p', { class: 'kpi-value' }, value), el('p', { class: 'kpi-label', i18n: [labelKey] }), sub ? el('p', { class: 'kpi-sub' }, sub) : null);
}

function waterCell(h) {
  return el('span', { class: 'cell-stack' }, statusBadge(h.status, { short: true }),
    h.lowWater ? el('span', { class: 'badge', 'data-flag': 'low' }, icon('i-drop', 'badge-icon'), el('span', { i18n: [h.lowWaterReported ? 'admin.lowReported' : 'admin.lowWater'] })) : null);
}

function deliveryCell(h) {
  return el('span', { class: 'cell-tank' }, deliveryText(h.plan), h.monitorAttention && typeof h.days !== 'number' ? el('span', { class: 'hint', i18n: ['admin.checkRequired'] }) : null);
}

const litresPerDay = (h) => (h.consumption.litresPerDay ? `${litres(h.consumption.litresPerDay)}/${t('unit.day')}` : '—');

function householdsTable(list, { caption, compact = false } = {}) {
  const cols = compact
    ? ['admin.col.house', 'admin.col.water', 'admin.col.tank', 'admin.col.remaining', 'admin.col.priority', 'admin.col.delivery']
    : ['admin.col.house', 'admin.col.water', 'admin.col.priority', 'admin.col.tank', 'admin.col.estWater', 'admin.col.use', 'admin.col.remaining', 'admin.col.delivery', 'admin.col.truck', 'admin.col.sensor'];
  const cell = {
    'admin.col.water': (h) => waterCell(h),
    'admin.col.priority': (h) => priorityBadge(h.priority.level),
    'admin.col.tank': (h) => el('span', { class: 'cell-tank' }, pct(h.level)),
    'admin.col.estWater': (h) => (typeof h.litres === 'number' ? litres(h.litres) : '—'),
    'admin.col.use': (h) => el('span', { class: 'cell-tank' }, litresPerDay(h), el('span', { class: 'hint', i18n: [`consumption.${h.consumption.source}`] })),
    'admin.col.remaining': (h) => daysText(h.days),
    'admin.col.delivery': (h) => deliveryCell(h),
    'admin.col.truck': (h) => h.plan.truckId || '—',
    'admin.col.sensor': (h) => sensorBadge(h.monitor),
  };
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
    el('caption', { class: 'sr-only' }, caption),
    el('thead', {}, el('tr', {}, ...cols.map((k) => el('th', { scope: 'col', i18n: [k] })))),
    el('tbody', {}, ...list.map((h) => el('tr', { 'data-house': h.id, 'data-priority': h.priority.level },
      el('th', { scope: 'row' }, el('a', { class: 'row-link', href: `#/admin/household/${h.id}` }, h.id)),
      ...cols.slice(1).map((k) => el('td', {}, cell[k](h))))))));
}

const byUrgency = (snap) => Object.values(snap.households).sort((a, b) => a.priority.score - b.priority.score || a.id.localeCompare(b.id));

export function renderAdminOverview(snap) {
  const k = snap.kpis;
  const queue = byUrgency(snap).filter((h) => h.needsAttention || h.priority.level !== 'LOW').slice(0, 6);
  $('#admin-overview-root').replaceChildren(
    el('h1', { tabindex: '-1', i18n: ['admin.overviewTitle'] }),
    ...snap.opsAlerts.map((a) => el('section', { class: 'ops-alert', role: 'alert' }, icon('i-system', 'notice-icon'),
      el('div', {}, el('h2', {}, t('admin.truckDownTitle', { id: a.truckId })),
        el('p', {}, t('admin.truckDownBody', { n: a.affected.length, list: a.affected.join(', ') })),
        el('a', { class: 'btn btn-secondary', href: '#/admin/trucks', i18n: ['admin.viewTrucks'] })))),
    el('div', { class: 'kpis kpis-6' },
      kpi('kpi-households', `${k.householdsMonitored} / ${k.householdsTotal}`, 'admin.kpi.households'),
      kpi('kpi-attention', String(k.needingAttention), 'admin.kpi.attention', k.needingAttention ? 'check' : null, t('admin.kpi.highSub', { n: k.highPriority })),
      kpi('kpi-trucks', `${k.trucksOperating} / ${k.trucksTotal}`, 'admin.kpi.trucks', k.trucksOperating < k.trucksTotal ? 'warn' : null),
      kpi('kpi-sensors', `${k.sensorsOnline} / ${k.householdsTotal}`, 'admin.kpi.sensors', k.sensorsOnline < k.householdsTotal ? 'check' : null),
      kpi('kpi-water', litres(k.communityWaterLitres), 'admin.kpi.communityWater', null, t('admin.kpi.knownTanks', { n: k.communityWaterKnown, total: k.householdsTotal })),
      kpi('kpi-alerts', String(k.activeAlerts), 'admin.kpi.alerts', k.activeAlerts ? 'check' : null)),
    el('div', { class: 'admin-grid' },
      el('section', { class: 'card', 'aria-labelledby': 'queue-h' },
        el('div', { class: 'card-head' }, el('h2', { class: 'eyebrow', id: 'queue-h', i18n: ['admin.queue'] }), el('a', { href: '#/admin/households', class: 'link-more', i18n: ['admin.allHouseholds'] })),
        householdsTable(queue, { caption: t('admin.queue'), compact: true }),
        el('p', { class: 'hint', i18n: ['admin.priorityNote'] })),
      el('div', { class: 'admin-side' },
        el('section', { class: 'card', 'aria-labelledby': 'trucks-h' },
          el('div', { class: 'card-head' }, el('h2', { class: 'eyebrow', id: 'trucks-h', i18n: ['admin.trucks'] }), el('a', { href: '#/admin/trucks', class: 'link-more', i18n: ['admin.manage'] })),
          el('ul', { class: 'mini-trucks' }, ...snap.trucks.map((tr) => el('li', { 'data-truck': tr.status },
            el('span', { class: 'mini-truck-id' }, tr.id), truckBadge(tr.status), el('span', { class: 'hint' }, t('admin.stopsToday', { n: tr.today.length })))))),
        el('section', { class: 'card', 'aria-labelledby': 'notices-h' },
          el('div', { class: 'card-head' }, el('h2', { class: 'eyebrow', id: 'notices-h', i18n: ['admin.activeNotices'] }), el('a', { href: '#/admin/alerts', class: 'link-more', i18n: ['admin.newNotice'] })),
          snap.alerts.length ? el('ul', { class: 'mini-list' }, ...snap.alerts.map((a) => el('li', {}, icon('i-bell', 'inline-icon'), el('span', { i18n: [`alert.${a.type}.title`] }), el('span', { class: 'hint' }, shortWhen(a.ts)))))
            : el('p', { class: 'hint', i18n: ['admin.noNotices'] })),
        el('section', { class: 'card', 'aria-labelledby': 'log-h' },
          el('h2', { class: 'eyebrow', id: 'log-h', i18n: ['admin.recentOps'] }),
          snap.log.length ? el('ol', { class: 'mini-list' }, ...snap.log.filter((l) => !l.local).slice(0, 8).map((l) => el('li', {}, el('span', { class: 'hint' }, shortWhen(l.ts)), el('span', {}, logText(l)))))
            : el('p', { class: 'hint', i18n: ['admin.noOps'] })))),
  );
}

function truckBadge(status) {
  return el('span', { class: 'badge', 'data-truck': status }, icon(status === 'OPERATING' ? 'i-normal' : 'i-system', 'badge-icon'), el('span', { i18n: [`truck.status.${status}`] }));
}

function logText(l) {
  switch (l.type) {
    case 'low_water': return t('log.lowWater', { id: l.householdId });
    case 'delivery': return t('log.delivery', { id: l.householdId, truck: l.truckId, litres: litres(l.litres) });
    case 'truck_down': return t('log.truckDown', { truck: l.truckId });
    case 'truck_up': return t('log.truckUp', { truck: l.truckId });
    case 'alert': return t('log.alert', { type: t(`alert.${l.alertType}.title`) });
    case 'alert_end': return t('log.alertEnd', { type: t(`alert.${l.alertType}.title`) });
    case 'check': return t('log.check', { id: l.householdId });
    default: return l.type;
  }
}

function matchesFilter(h, f) {
  if (f === 'normal') return h.status === STATUS.NORMAL && !h.needsAttention;
  if (f === 'attention') return h.needsAttention;
  if (f === 'low') return h.lowWater;
  if (f === 'monitor') return h.monitorAttention;
  return true;
}

export function renderAdminHouseholds(snap) {
  const root = $('#admin-households-root');
  const all = byUrgency(snap);
  const q = ui.query.trim().toUpperCase();
  const list = all.filter((h) => matchesFilter(h, ui.filter) && (!q || h.id.toUpperCase().includes(q)));
  if (!root.firstChild) {
    // Controls are built once so typing keeps focus.
    root.append(
      el('div', { class: 'detail-head' }, el('h1', { tabindex: '-1', i18n: ['admin.householdsTitle'] }),
        el('a', { class: 'btn btn-primary', href: '#/admin/household-new', id: 'add-household' }, el('span', { i18n: ['admin.addHousehold'] }))),
      el('div', { class: 'toolbar' },
        el('label', { class: 'search' }, el('span', { class: 'sr-only', i18n: ['admin.search'] }), icon('i-search', 'search-icon'),
          el('input', { type: 'search', id: 'hh-search', placeholder: t('admin.searchPlaceholder'), autocomplete: 'off', oninput: (e) => { ui.query = e.target.value; renderAdminHouseholds(ctx.ops.snapshot()); } })),
        el('div', { class: 'chips', role: 'group', 'aria-label': t('admin.filter') }, ...FILTERS.map((f) =>
          el('button', { type: 'button', class: 'chip', 'data-filter': f, 'aria-pressed': 'false', onclick: () => { ui.filter = f; renderAdminHouseholds(ctx.ops.snapshot()); } })))),
      el('p', { class: 'hint', id: 'hh-count', 'aria-live': 'polite' }),
      el('div', { id: 'hh-table' }));
  }
  for (const b of $$('.chip', root)) {
    const f = b.dataset.filter;
    b.setAttribute('aria-pressed', String(ui.filter === f));
    b.textContent = `${t(`admin.filter.${f}`)} (${all.filter((h) => matchesFilter(h, f)).length})`;
  }
  $('#hh-count').textContent = t('admin.showing', { n: list.length, total: all.length });
  $('#hh-table').replaceChildren(list.length ? householdsTable(list, { caption: t('admin.householdsTitle') }) : el('p', { class: 'hint', i18n: ['admin.noMatch'] }));
}

export function resetAdminHouseholds() {
  const root = $('#admin-households-root');
  if (root) root.replaceChildren();
}

const fact = (labelKey, value, attrs = {}) => el('div', attrs, el('dt', { i18n: [labelKey] }), el('dd', {}, value));

export function renderAdminHousehold(snap, id) {
  const root = $('#admin-household-root');
  const h = snap.households[id];
  if (!h) {
    root.replaceChildren(el('a', { class: 'btn btn-back', href: '#/admin/households' }, icon('i-back'), el('span', { i18n: ['admin.backToHouseholds'] })),
      el('h1', { tabindex: '-1' }, id), el('p', { i18n: ['admin.notFound'] }));
    return;
  }
  const history = [
    ...h.deliveries.map((d) => ({ ts: d.ts, text: t('log.delivery', { id: h.id, truck: d.truckId, litres: litres(d.litres) }), icon: 'i-truck' })),
    ...snap.log.filter((l) => l.householdId === id && l.type === 'low_water').map((l) => ({ ts: l.ts, text: logText(l), icon: 'i-drop' })),
    ...h.analysis.events.filter((e) => e.type === 'status').map((e) => ({ ts: e.ts, text: t(`history.status.${e.status}`), icon: STATUS_ICON[e.status] })),
  ].filter((x) => x.ts <= snap.now).sort((a, b) => b.ts - a.ts).slice(0, 10);
  const s = h.sensor;
  root.replaceChildren(
    el('a', { class: 'btn btn-back', href: '#/admin/households' }, icon('i-back'), el('span', { i18n: ['admin.backToHouseholds'] })),
    el('div', { class: 'detail-head' }, el('h1', { tabindex: '-1' }, t('house.label', { id })), priorityBadge(h.priority.level),
      el('a', { class: 'btn btn-secondary', href: `#/admin/household/${id}/edit`, id: 'edit-household' }, el('span', { i18n: ['admin.editHousehold'] }))),
    el('div', { class: 'detail-grid' },
      el('section', { class: 'card', 'aria-labelledby': 'd-tank' }, el('h2', { class: 'eyebrow', id: 'd-tank', i18n: ['tank.title'] }),
        el('p', { class: 'tank-pct', id: 'detail-level' }, pct(h.level)), tankBar(h.level),
        el('dl', { class: 'facts-grid' },
          fact('admin.estWater', typeof h.litres === 'number' ? litres(h.litres) : t('days.unknown'), { id: 'detail-litres' }),
          fact('admin.estUse', h.consumption.litresPerDay ? `${litresPerDay(h)} · ${t(`consumption.${h.consumption.source}`)}` : t('days.unknown'), { id: 'detail-use' }),
          fact('admin.estRemaining', daysText(h.days), { id: 'detail-days' }),
          fact('admin.capacity', `${litres(h.meta.tankCapacityLitres)} · ${h.meta.tankHeightCm} cm`)),
        el('p', { class: 'hint', i18n: ['admin.tankNote'] })),
      el('section', { class: 'card', 'aria-labelledby': 'd-sensor' }, el('h2', { class: 'eyebrow', id: 'd-sensor', i18n: ['admin.sensor'] }),
        el('p', { class: 'sensor-id' }, s ? s.id : t('sensor.NOT_INSTALLED'), ' ', sensorBadge(h.monitor)),
        el('dl', { class: 'facts-grid' },
          fact('admin.battery', s && typeof s.batteryPercent === 'number' ? `${Math.round(s.batteryPercent)}%` : '—'),
          fact('admin.lastReading', s && h.analysis.latest ? relativeTime(h.analysis.latest.timestamp, snap.now) : '—')),
        el('h3', { class: 'eyebrow', i18n: ['admin.waterCondition'] }),
        statusBadge(h.status),
        el('ul', { class: 'cond-list' }, ...SENSORS.filter((k) => k !== 'tankLevel').map((key) => {
          const p = h.result.params[key];
          const vis = PARAM_VISUAL[p.state];
          return el('li', { class: `cond tone-${vis.tone}` }, icon(vis.icon, 'cond-icon'), el('span', { class: 'cond-name', i18n: [`cond.${key}`] }), el('span', { class: 'cond-state', i18n: [`pstate.${p.state}`] }));
        }))),
      el('section', { class: 'card', 'aria-labelledby': 'd-ops' }, el('h2', { class: 'eyebrow', id: 'd-ops', i18n: ['admin.operations'] }),
        el('dl', { class: 'facts-grid' },
          fact('admin.assignedTruck', h.plan.reassigned ? t('admin.reassignedFrom', { to: h.plan.truckId, from: h.plan.originalTruck }) : (h.plan.truckId || '—')),
          fact('tank.nextDelivery', deliveryText(h.plan)),
          fact('tank.lastDelivery', h.lastDelivery ? `${shortWhen(h.lastDelivery.ts)} · ${h.lastDelivery.truckId} · ${litres(h.lastDelivery.litres)}` : '—'),
          fact('admin.lowReport', h.lowWaterReported ? t('admin.yesAt', { time: h.lowWaterReportedAt ? shortWhen(h.lowWaterReportedAt) : '' }) : t('admin.no'), { id: 'detail-low' }),
          fact('driver.people', String(h.meta.occupants)),
          fact('driver.vulnerability', h.meta.vulnerability ? t(`vuln.${h.meta.vulnerability}`) : t('driver.none')))),
      el('section', { class: 'card', 'aria-labelledby': 'd-prio' }, el('h2', { class: 'eyebrow', id: 'd-prio', i18n: ['admin.whyPriority'] }),
        priorityBadge(h.priority.level),
        el('ul', { class: 'reasons' }, ...h.priority.reasons.map((r) => el('li', {}, reasonText(r, h)))),
        el('p', { class: 'hint' }, t('admin.score', { score: h.priority.score })),
        h.monitorAttention ? el('p', { class: 'warn-line' }, icon('i-system', 'inline-icon'), el('span', { i18n: ['admin.monitorAttention'] })) : null),
      el('section', { class: 'card detail-history', 'aria-labelledby': 'd-hist' }, el('h2', { class: 'eyebrow', id: 'd-hist', i18n: ['admin.recentHistory'] }),
        el('ol', { class: 'mini-list' }, ...history.map((x) => el('li', {}, icon(x.icon, 'inline-icon'), el('span', { class: 'hint' }, shortWhen(x.ts)), el('span', {}, x.text)))))),
    el('button', { type: 'button', class: 'btn btn-danger-outline', id: 'archive-household', onclick: () => archiveHousehold(id) }, el('span', { i18n: ['admin.archiveHousehold'] })),
  );
}

async function archiveHousehold(id) {
  const res = await ctx.confirm({ title: t('admin.archiveHousehold'), body: t('admin.archiveHouseholdBody', { id }), confirmLabel: t('admin.archive'), tone: 'danger' });
  if (!res.ok) return;
  const r = await runAction(() => ctx.ops.archiveHousehold(id), t('admin.saved'));
  if (r.ok) go('#/admin/households');
}

// ---------- Forms ----------
function field(name, labelKey, input, hintKey) {
  const inputId = `f-${name}`;
  input.id = inputId;
  input.name = name;
  return el('div', { class: 'field' }, el('label', { for: inputId, i18n: [labelKey] }), input, hintKey ? el('p', { class: 'hint', i18n: [hintKey] }) : null);
}
const numInput = (value, min, max, step = '1') => el('input', { type: 'number', inputmode: 'numeric', min: String(min), max: String(max), step, required: true, value: value == null ? '' : String(value) });
function select(options, value) {
  const s = el('select', {});
  for (const [v, label] of options) {
    const o = el('option', { value: v }, label);
    if (String(v) === String(value ?? '')) o.selected = true;
    s.append(o);
  }
  return s;
}
function formShell(titleText, backHref, fields, onSubmit, submitKey) {
  const err = el('p', { class: 'form-error', id: 'form-error', role: 'alert' });
  const form = el('form', { class: 'card admin-form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (!f.checkValidity()) {
      err.textContent = t('form.invalid');
      const bad = f.querySelector(':invalid');
      if (bad) bad.focus();
      return;
    }
    err.textContent = '';
    const values = Object.fromEntries(new FormData(f).entries());
    try {
      await onSubmit(values);
    } catch (x) {
      err.textContent = x && x.offline ? t('error.offline') : (x && x.message) || '';
    }
  } }, el('div', { class: 'form-grid' }, ...fields), err, el('button', { type: 'submit', class: 'btn btn-primary btn-xl', id: 'form-save', i18n: [submitKey] }));
  return [el('a', { class: 'btn btn-back', href: backHref }, icon('i-back'), el('span', { i18n: ['back'] })), el('h1', { tabindex: '-1' }, titleText), form];
}

export function renderHouseholdForm(snap, id) {
  const root = $('#admin-form-root');
  const isNew = !id;
  const raw = isNew ? null : snap.rawHouseholds.find((h) => h.id === id);
  if (!isNew && !raw) {
    root.replaceChildren(el('h1', { tabindex: '-1' }, id), el('p', { i18n: ['admin.notFound'] }));
    return;
  }
  const h = raw || { residentsCount: 4, tankCapacityL: 2000, tankHeightCm: 150, configuredDailyUseL: 240, deliveryIntervalDays: 2, vulnerability: null, assignedTruckId: snap.trucks[0] && snap.trucks[0].id };
  const truckOpts = [['', t('admin.noTruck')], ...snap.trucks.map((tr) => [tr.id, `${tr.id} · ${tr.displayName}`])];
  const fields = [
    isNew ? field('id', 'admin.f.householdId', el('input', { type: 'text', required: true, maxlength: '24', pattern: '[A-Za-z0-9_\\-]+', autocomplete: 'off', placeholder: 'H-101' })) : null,
    field('residentsCount', 'admin.f.residents', numInput(h.residentsCount, 1, 30)),
    field('tankCapacityL', 'admin.f.capacity', numInput(h.tankCapacityL, 100, 50000)),
    field('tankHeightCm', 'admin.f.height', numInput(h.tankHeightCm, 20, 500, '0.1'), 'admin.f.heightHint'),
    field('configuredDailyUseL', 'admin.f.dailyUse', numInput(h.configuredDailyUseL, 1, 5000), 'admin.f.dailyUseHint'),
    field('deliveryIntervalDays', 'admin.f.interval', numInput(h.deliveryIntervalDays, 1, 14)),
    field('vulnerability', 'admin.f.vulnerability', select([['', t('driver.none')], ['elder', t('vuln.elder')], ['infant', t('vuln.infant')], ['medical', t('vuln.medical')]], h.vulnerability)),
    field('assignedTruckId', 'admin.f.truck', select(truckOpts, h.assignedTruckId)),
  ];
  root.replaceChildren(...formShell(isNew ? t('admin.addHousehold') : t('admin.editHouseholdTitle', { id }), isNew ? '#/admin/households' : `#/admin/household/${id}`, fields, async (v) => {
    const body = {
      id: isNew ? v.id : id, residentsCount: Number(v.residentsCount), tankCapacityL: Number(v.tankCapacityL), tankHeightCm: Number(v.tankHeightCm),
      configuredDailyUseL: Number(v.configuredDailyUseL), deliveryIntervalDays: Number(v.deliveryIntervalDays), vulnerability: v.vulnerability || null, assignedTruckId: v.assignedTruckId || null,
    };
    await ctx.ops.saveHousehold(body, isNew);
    ctx.announce && ctx.announce(t('admin.saved'));
    go(`#/admin/household/${encodeURIComponent((isNew ? v.id : id).trim().toUpperCase())}`);
  }, 'admin.save'));
}

export function renderTruckForm(snap, id) {
  const root = $('#admin-form-root');
  const isNew = !id;
  const raw = isNew ? null : snap.rawTrucks.find((x) => x.id === id);
  if (!isNew && !raw) {
    root.replaceChildren(el('h1', { tabindex: '-1' }, id), el('p', { i18n: ['admin.notFound'] }));
    return;
  }
  const tr = raw || { displayName: '', capacityL: 10000, currentWaterL: 10000, status: 'IN_SERVICE' };
  const fields = [
    isNew ? field('id', 'admin.f.truckId', el('input', { type: 'text', required: true, maxlength: '24', pattern: '[A-Za-z0-9_\\-]+', autocomplete: 'off', placeholder: 'T4' })) : null,
    field('displayName', 'admin.f.displayName', el('input', { type: 'text', maxlength: '40', value: tr.displayName, placeholder: t('admin.f.displayNameHint') })),
    field('capacityL', 'admin.f.truckCapacity', numInput(tr.capacityL, 100, 100000)),
    field('currentWaterL', 'admin.f.currentWater', numInput(tr.currentWaterL, 0, 100000)),
    field('status', 'admin.f.status', select([['IN_SERVICE', t('truck.status.OPERATING')], ['OUT_OF_SERVICE', t('truck.status.OUT_OF_SERVICE')]], tr.status)),
  ];
  root.replaceChildren(...formShell(isNew ? t('admin.addTruck') : t('admin.editTruckTitle', { id }), '#/admin/trucks', fields, async (v) => {
    const body = { id: isNew ? v.id : id, displayName: v.displayName || undefined, capacityL: Number(v.capacityL), currentWaterL: Number(v.currentWaterL), status: v.status };
    if (body.currentWaterL > body.capacityL) throw new Error(t('admin.waterOverCapacity'));
    await ctx.ops.saveTruck(body, isNew);
    ctx.announce && ctx.announce(t('admin.saved'));
    go('#/admin/trucks');
  }, 'admin.save'));
}

// ---------- Trucks ----------
export function renderAdminTrucks(snap) {
  $('#admin-trucks-root').replaceChildren(
    el('div', { class: 'detail-head' }, el('h1', { tabindex: '-1', i18n: ['admin.trucksTitle'] }),
      el('a', { class: 'btn btn-primary', href: '#/admin/truck-new', id: 'add-truck' }, el('span', { i18n: ['admin.addTruck'] }))),
    el('div', { class: 'truck-cards' }, ...snap.trucks.map((tr) => {
      const out = tr.status !== 'OPERATING';
      return el('section', { class: `card truck-card${out ? ' is-out' : ''}`, 'data-truck-card': tr.id, 'aria-labelledby': `tc-${tr.id}` },
        el('div', { class: 'card-head' }, el('h2', { id: `tc-${tr.id}` }, `${tr.id} · ${tr.displayName}`), truckBadge(tr.status)),
        el('dl', { class: 'facts-grid' },
          fact('admin.route', t('admin.routeHouseholds', { n: tr.assigned.length })),
          fact('admin.stopsTodayLabel', String(tr.today.length)),
          fact('driver.remaining', `${litres(tr.remainingLitres)} / ${litres(tr.capacityLitres)}`),
          fact('driver.trip', String(tr.trip))),
        tr.today.length ? el('ol', { class: 'stop-chips', 'aria-label': t('admin.stopsTodayLabel') }, ...tr.today.map((hid) => el('li', { 'data-priority': snap.households[hid].priority.level }, el('a', { href: `#/admin/household/${hid}` }, hid))))
          : el('p', { class: 'hint', i18n: [out ? 'admin.routeReassigned' : 'driver.noStops'] }),
        el('div', { class: 'row-actions' },
          el('button', { type: 'button', class: `btn ${out ? 'btn-secondary' : 'btn-danger-outline'}`, 'data-truck-toggle': tr.id, onclick: () => toggleTruck(tr) }, el('span', { i18n: [out ? 'admin.markInService' : 'admin.markOut'] })),
          el('a', { class: 'btn btn-secondary', href: `#/admin/truck/${tr.id}/edit` }, el('span', { i18n: ['admin.edit'] })),
          el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => archiveTruck(tr) }, el('span', { i18n: ['admin.archive'] }))));
    })),
  );
}

async function toggleTruck(tr) {
  const out = tr.status !== 'OPERATING';
  const res = await ctx.confirm({
    title: t(out ? 'admin.markInService' : 'admin.markOut'), body: t(out ? 'driver.restoreBody' : 'admin.markOutBody', { id: tr.id }),
    confirmLabel: t(out ? 'admin.markInService' : 'admin.markOut'), tone: out ? 'primary' : 'danger',
  });
  if (!res.ok) return;
  await runAction(() => (out ? ctx.ops.restoreTruck(tr.id) : ctx.ops.reportTruckProblem(tr.id)));
}

async function archiveTruck(tr) {
  const res = await ctx.confirm({ title: t('admin.archive'), body: t('admin.archiveTruckBody', { id: tr.id }), confirmLabel: t('admin.archive'), tone: 'danger' });
  if (res.ok) await runAction(() => ctx.ops.archiveTruck(tr.id), t('admin.saved'));
}

// ---------- Sensors ----------
export function renderAdminSensors(snap) {
  const withSensor = new Set(snap.sensors.filter((s) => s.householdId).map((s) => s.householdId));
  const free = Object.keys(snap.households).filter((id) => !withSensor.has(id)).sort();
  const lastReading = (s) => {
    const h = s.householdId && snap.households[s.householdId];
    return h && h.analysis.latest ? relativeTime(h.analysis.latest.timestamp, snap.now) : '—';
  };
  const regErr = el('p', { class: 'form-error', role: 'alert', id: 'sensor-error' });
  $('#admin-sensors-root').replaceChildren(
    el('h1', { tabindex: '-1', i18n: ['admin.sensorsTitle'] }),
    el('p', { class: 'hint', i18n: ['admin.sensorsIntro'] }),
    el('div', { class: 'table-wrap card' }, el('table', { class: 'data-table', id: 'sensor-table' },
      el('caption', { class: 'sr-only', i18n: ['admin.sensorsTitle'] }),
      el('thead', {}, el('tr', {}, ...['admin.col.device', 'admin.col.house', 'admin.col.status', 'admin.col.lastReading', 'admin.col.battery', 'admin.col.actions'].map((k) => el('th', { scope: 'col', i18n: [k] })))),
      el('tbody', {}, ...snap.sensors.map((s) => el('tr', { 'data-sensor': s.id },
        el('th', { scope: 'row' }, s.id),
        el('td', {}, s.householdId ? el('a', { class: 'row-link', href: `#/admin/household/${s.householdId}` }, s.householdId) : '—'),
        el('td', {}, sensorBadge(s.effectiveStatus)),
        el('td', {}, lastReading(s)),
        el('td', {}, typeof s.batteryPercent === 'number' ? `${Math.round(s.batteryPercent)}%` : '—'),
        el('td', {}, el('div', { class: 'row-actions compact' },
          el('label', { class: 'sr-only', for: `assign-${s.id}` }, t('admin.assignTo', { id: s.id })),
          Object.assign(select([['', t('admin.unassigned')], ...(s.householdId ? [[s.householdId, s.householdId]] : []), ...free.map((id) => [id, id])], s.householdId || ''), { id: `assign-${s.id}` }),
          el('button', { type: 'button', class: 'btn btn-secondary', 'data-assign': s.id, onclick: (e) => assignSensor(s, e.currentTarget.previousElementSibling.value) }, el('span', { i18n: [s.householdId ? 'admin.reassign' : 'admin.assign'] })),
          s.householdId ? el('button', { type: 'button', class: 'btn btn-secondary', 'data-service': s.id, onclick: () => serviceSensor(s) }, el('span', { i18n: [s.status === 'SERVICE_REQUIRED' ? 'admin.backOnline' : 'admin.markService'] })) : null)))))),
    ),
    el('form', { class: 'card admin-form', id: 'register-sensor', onsubmit: async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.currentTarget).entries());
      if (!v.serialNumber) { regErr.textContent = t('form.invalid'); return; }
      const r = await runAction(() => ctx.ops.registerSensor({ serialNumber: v.serialNumber, householdId: v.householdId || null }), t('admin.saved'));
      if (!r.ok) regErr.textContent = r.error && r.error.message;
    } },
    el('h2', { class: 'eyebrow', i18n: ['admin.registerSensor'] }),
    el('div', { class: 'form-grid' },
      field('serialNumber', 'admin.f.serial', el('input', { type: 'text', maxlength: '24', pattern: '[A-Za-z0-9_\\-]+', autocomplete: 'off', placeholder: 'IMQ-0101' })),
      field('householdId', 'admin.f.assignHousehold', select([['', t('admin.unassigned')], ...free.map((id) => [id, id])], ''))),
    regErr,
    el('button', { type: 'submit', class: 'btn btn-primary', id: 'register-sensor-btn', i18n: ['admin.registerSensor'] })),
  );
}

async function assignSensor(s, householdId) {
  if ((householdId || null) === (s.householdId || null)) return;
  const res = await ctx.confirm({
    title: t(householdId ? 'admin.assign' : 'admin.unassign'),
    body: householdId ? t('admin.assignBody', { id: s.id, house: householdId }) : t('admin.unassignBody', { id: s.id }),
    confirmLabel: t('admin.save'), tone: 'primary',
  });
  if (res.ok) await runAction(() => ctx.ops.updateSensor(s.id, { householdId: householdId || null }), t('admin.saved'));
}
async function serviceSensor(s) {
  const toService = s.status !== 'SERVICE_REQUIRED';
  await runAction(() => ctx.ops.updateSensor(s.id, { status: toService ? 'SERVICE_REQUIRED' : 'ONLINE' }), t('admin.saved'));
}

// ---------- Alerts ----------
export function renderAdminAlerts(snap) {
  const root = $('#admin-alerts-root');
  const past = snap.allAlerts.filter((a) => !a.active).sort((a, b) => b.ts - a.ts).slice(0, 8);
  root.replaceChildren(
    el('h1', { tabindex: '-1', i18n: ['admin.alertsTitle'] }),
    el('form', { class: 'card alert-form', id: 'alert-form', onsubmit: onSendAlert },
      el('fieldset', { class: 'choice-group plain' }, el('legend', { i18n: ['admin.alertType'] }),
        el('div', { class: 'choices' }, ...ALERT_TYPES.map((type) => el('label', { class: 'choice' },
          el('input', { type: 'radio', name: 'alertType', value: type, checked: ui.alertType === type, onchange: () => { ui.alertType = type; renderAdminAlerts(ctx.ops.snapshot()); } }),
          el('span', { i18n: [`alert.${type}.title`] }))))),
      el('div', { class: 'preview' }, el('p', { class: 'eyebrow', i18n: ['admin.preview'] }),
        el('p', { class: 'preview-title', i18n: [`alert.${ui.alertType}.title`] }), el('p', { i18n: [`alert.${ui.alertType}.msg`] })),
      el('label', { class: 'field' }, el('span', { i18n: ['admin.note'] }), el('textarea', { name: 'note', rows: '2', maxlength: '280' })),
      el('p', { class: 'hint', i18n: ['admin.alertAudience'] }),
      el('button', { type: 'submit', class: 'btn btn-primary btn-block', id: 'send-alert', i18n: ['admin.send'] })),
    el('section', { class: 'card', 'aria-labelledby': 'active-h' }, el('h2', { class: 'eyebrow', id: 'active-h', i18n: ['admin.activeNotices'] }),
      snap.alerts.length ? el('ul', { class: 'alert-list' }, ...snap.alerts.map((a) => el('li', {}, icon('i-bell', 'inline-icon'),
        el('div', {}, el('p', { class: 'preview-title', i18n: [`alert.${a.type}.title`] }), el('p', { class: 'hint' }, `${shortWhen(a.ts)}${a.message ? ` · ${a.message}` : ''}`)),
        el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => endAlert(a) }, el('span', { i18n: ['admin.endNotice'] })))))
        : el('p', { class: 'hint', i18n: ['admin.noNotices'] })),
    past.length ? el('section', { class: 'card' }, el('h2', { class: 'eyebrow', i18n: ['admin.pastNotices'] }),
      el('ul', { class: 'mini-list' }, ...past.map((a) => el('li', {}, el('span', { i18n: [`alert.${a.type}.title`] }), el('span', { class: 'hint' }, shortWhen(a.ts)))))) : null,
  );
}

async function onSendAlert(e) {
  e.preventDefault();
  const note = new FormData(e.currentTarget).get('note') || '';
  const res = await ctx.confirm({ title: t('admin.sendTitle'), body: `${t(`alert.${ui.alertType}.title`)} — ${t('admin.alertAudience')}`, confirmLabel: t('admin.send'), tone: 'primary' });
  if (!res.ok) return;
  await runAction(() => ctx.ops.createAlert({ type: ui.alertType, note }), t('admin.sent'));
}

async function endAlert(a) {
  const res = await ctx.confirm({ title: t('admin.endNotice'), body: t(`alert.${a.type}.title`), confirmLabel: t('admin.endNotice'), tone: 'primary' });
  if (res.ok) await runAction(() => ctx.ops.endAlert(a.id));
}
