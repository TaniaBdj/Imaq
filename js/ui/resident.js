/**
 * RESIDENT / HOUSEHOLD views. Extremely simple: status first, plain words.
 */
import { STATUS, PARAM, SENSORS, PROTOTYPE_THRESHOLDS as T } from '../detection.js';
import {
  ctx, t, $, $$, el, svg, icon, setText, listJoin, relativeTime, clockTime, dayLabel, shortWhen, litres, pct,
  STATUS_ICON, PARAM_VISUAL, daysText, deliveryText, tankBar, runAction,
} from './common.js';

const REC_TONE = {
  nothing_unusual: STATUS.NORMAL,
  keep_watching: STATUS.CHECK,
  contact_services: STATUS.CHECK,
  follow_guidance: STATUS.ACTION,
  monitor_service: STATUS.SYSTEM_CHECK,
};
const HISTORY_READING_WINDOW_MS = 6 * 3600_000;

let lastAnnounced = null;

function statusDetail(h) {
  const result = h.result;
  const names = (keys) => listJoin(keys.map((k) => t(`param.short.${k}`)));
  switch (result.status) {
    case STATUS.NORMAL:
      return t('detail.NORMAL');
    case STATUS.CHECK:
      return t('detail.CHECK', { list: names(result.changed) });
    case STATUS.ACTION:
      return result.advisory ? t('detail.ACTION.advisory') : t('detail.ACTION.major', { list: names(result.changed) });
    default: {
      if (!h.analysis.latest) return t('detail.SYSTEM_CHECK.nodata');
      const invalid = SENSORS.filter((k) => result.params[k].state === PARAM.INVALID);
      return result.stale ? t('detail.SYSTEM_CHECK.stale') : t('detail.SYSTEM_CHECK.sensor', { list: names(invalid) });
    }
  }
}

/** Municipal notices banner (shared state → every household). */
export function renderNotices(snap) {
  const host = $('#notices');
  const notices = [...snap.alerts].sort((a, b) => b.ts - a.ts);
  host.replaceChildren(
    ...notices.map((a) =>
      el('section', { class: `notice notice-${a.type}`, 'aria-labelledby': `n-${a.id}` },
        icon(a.type === 'all_clear' ? 'i-normal' : a.type === 'advisory' ? 'i-action' : 'i-bell', 'notice-icon'),
        el('div', { class: 'notice-body' },
          el('p', { class: 'notice-kicker', i18n: ['notice.kicker'] }),
          el('h2', { class: 'notice-title', id: `n-${a.id}`, i18n: [`alert.${a.type}.title`] }),
          el('p', { i18n: [`alert.${a.type}.msg`] }),
          a.message ? el('p', { class: 'notice-note' }, a.message) : null,
          el('p', { class: 'notice-time' }, `${t('notice.issued')} ${shortWhen(a.ts)}`)))),
  );
  host.hidden = notices.length === 0;
}

export function renderResidentHome(h, snap) {
  const root = $('#home-root');
  const s = h.status;
  const latest = h.analysis.latest;
  const MONITOR = { ONLINE: ['ok', 'monitor.working'], STALE: ['warn', 'monitor.noRecent'], OFFLINE: ['off', 'monitor.noRecent'], SERVICE_REQUIRED: ['off', 'monitor.service'], NOT_INSTALLED: ['off', 'monitor.notInstalled'] };
  const [monitorState, monitorKey] = MONITOR[h.monitor] || ['off', 'monitor.notConnected'];

  const announcement = t('announce.status', { word: t(`status.${s}.word`), msg: t(`status.${s}.msg`) });
  if (lastAnnounced !== null && lastAnnounced !== announcement && ctx.announce) ctx.announce(announcement);
  lastAnnounced = announcement;

  const statusCard = el('section', { class: 'status-card', 'data-status': s, id: 'status-card', 'aria-labelledby': 'status-eyebrow' },
    el('h2', { class: 'eyebrow', id: 'status-eyebrow', i18n: ['home.eyebrow'] }),
    el('div', { class: 'status-main' }, icon(STATUS_ICON[s], 'status-icon'),
      el('div', {}, el('p', { class: 'status-word', id: 'status-word', i18n: [`status.${s}.word`] }),
        el('p', { class: 'status-msg', id: 'status-msg', i18n: [`status.${s}.msg`] }))),
    el('p', { class: 'status-detail', id: 'status-detail' }, statusDetail(h)),
    el('dl', { class: 'status-meta' },
      el('div', {}, el('dt', { i18n: ['home.lastReading'] }), el('dd', { id: 'meta-last' }, latest ? `${clockTime(latest.timestamp)} · ${relativeTime(latest.timestamp)}` : t('time.never'))),
      el('div', {}, el('dt', { i18n: ['home.monitor'] }), el('dd', { id: 'meta-monitor', 'data-state': monitorState },
        el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { i18n: [monitorKey] })))),
    el('p', { class: 'status-note' }, icon('i-info', 'inline-icon'),
      el('span', { i18n: ['disclaimer'] }), el('a', { href: '#/help', i18n: ['disclaimer.more'] })),
  );

  const low = h.lowWaterReported
    ? el('div', { class: 'low-reported', role: 'status' }, icon('i-normal', 'inline-icon'),
      el('div', {}, el('p', { class: 'low-reported-title', i18n: ['low.reported'] }),
        el('p', { class: 'hint' }, t('low.reportedAt', { time: shortWhen(h.lowWaterReportedAt) }))))
    : el('button', { type: 'button', class: 'btn btn-warn btn-block', id: 'low-water-btn', onclick: () => onLowWater(h) },
      icon('i-drop', 'btn-icon'), el('span', { i18n: ['low.button'] }));

  const tankCard = el('section', { class: 'card tank-card', 'aria-labelledby': 'tank-h' },
    el('div', { class: 'tank-head' }, el('h2', { class: 'eyebrow', id: 'tank-h', i18n: ['tank.title'] }),
      el('p', { class: 'tank-pct', id: 'tank-pct', 'aria-hidden': 'true' }, pct(h.level))),
    tankBar(h.level),
    typeof h.level === 'number' && h.level < 25 ? el('p', { class: 'tank-low', i18n: ['tank.low'] }) : null,
    el('p', { class: 'tank-days', id: 'tank-days' }, typeof h.days === 'number' ? t('tank.remainingText', { days: daysText(h.days) }) : t('tank.remainingUnknown')),
    el('dl', { class: 'tank-facts' },
      el('div', {}, el('dt', { i18n: ['tank.nextDelivery'] }), el('dd', { id: 'next-delivery', 'data-when': h.plan.when }, deliveryText(h.plan))),
      el('div', {}, el('dt', { i18n: ['tank.lastDelivery'] }), el('dd', { id: 'tank-delivery' }, h.lastDelivery ? shortWhen(h.lastDelivery.ts) : '—'))),
    h.plan.reassigned ? el('p', { class: 'hint reassign-note', i18n: ['delivery.reassignedNote', { truck: t('truck.label', { id: h.plan.originalTruck }) }] }) : null,
    low,
  );

  const conditions = el('section', { class: 'card conditions-card', 'aria-labelledby': 'cond-h' },
    el('h2', { class: 'eyebrow', id: 'cond-h', i18n: ['conditions.title'] }),
    el('ul', { class: 'cond-list', id: 'cond-list' },
      ...SENSORS.map((key) => {
        const p = h.result.params[key];
        const vis = PARAM_VISUAL[p.state];
        const stateKey = key === 'tankLevel' && p.state === PARAM.NORMAL ? 'pstate.working' : `pstate.${p.state}`;
        return el('li', { class: `cond tone-${vis.tone}` }, icon(vis.icon, 'cond-icon'),
          el('span', { class: 'cond-name', i18n: [`cond.${key}`] }), el('span', { class: 'cond-state', i18n: [stateKey] }));
      })),
    el('a', { class: 'btn btn-secondary btn-block', href: '#/water', i18n: ['conditions.details'] }));

  const items = timelineItems(h, snap, { maxReadings: 3 });
  const recent = [...items.readings, ...pickRecent(items.others)].sort((a, b) => b.ts - a.ts);
  const activity = el('section', { class: 'card activity-card', 'aria-labelledby': 'act-h' },
    el('h2', { class: 'eyebrow', id: 'act-h', i18n: ['activity.title'] }),
    el('ol', { class: 'activity', id: 'activity' }, ...recent.map((it) => {
      const d = describe(it);
      return el('li', { class: `act tone-${String(d.tone).toLowerCase()}` }, el('span', { class: 'act-time' }, shortWhen(it.ts)),
        icon(d.icon, 'act-icon'), el('span', { class: 'act-text' }, el('span', { class: 'act-title' }, d.title), d.sub ? el('span', { class: 'act-sub' }, d.sub) : null));
    })));

  const actions = el('div', { class: 'home-actions' },
    el('a', { class: 'btn btn-primary', href: '#/check', i18n: ['btn.check'] }),
    el('a', { class: 'btn btn-secondary', href: '#/history', i18n: ['nav.history'] }));

  root.replaceChildren(
    el('div', { class: 'dash' }, statusCard, tankCard, conditions, activity),
    actions,
    el('footer', { class: 'home-footer' },
      el('p', { class: 'offline-strip', id: 'sync-strip' }, icon('i-offline', 'inline-icon'),
        ctx.ops.sync.online
          ? el('span', {}, el('strong', { i18n: ['sync.connected'] }), ' · ', el('span', {}, t('sync.lastSync', { time: ctx.ops.sync.lastSync ? clockTime(ctx.ops.sync.lastSync) : '—' })))
          : el('span', {}, el('strong', { i18n: ['sync.offlineShort'] }), ' · ', el('span', {}, t('sync.lastSync', { time: ctx.ops.sync.lastSync ? clockTime(ctx.ops.sync.lastSync) : '—' })))),
      el('p', { class: 'provenance' }, el('a', { href: '#/help', i18n: ['provenance'] }))),
  );
}

async function onLowWater(h) {
  const res = await ctx.confirm({
    title: t('low.confirmTitle'),
    body: t('low.confirmBody'),
    confirmLabel: t('low.confirmYes'),
    tone: 'warn',
  });
  if (!res.ok) return;
  const done = await runAction(() => ctx.ops.reportLowWater(h.id), t('low.reported'));
  if (!done.ok) return;
  const next = $('.low-reported');
  if (next) next.setAttribute('tabindex', '-1'), next.focus();
}

function pickRecent(others) {
  const sorted = [...others].sort((a, b) => b.ts - a.ts);
  const picked = sorted.slice(0, 1);
  const delivery = sorted.find((e) => e.type === 'delivered' || e.type === 'delivery');
  if (delivery && !picked.includes(delivery)) picked.push(delivery);
  return picked;
}

/** Timeline items for a household: readings, detected events, confirmed deliveries, reports, checks, notices. */
function timelineItems(h, snap, { readingsSince = -Infinity, maxReadings = Infinity } = {}) {
  const { statusByTs, events } = h.analysis;
  const readings = h.readings.filter((r) => r.timestamp >= readingsSince && r.timestamp <= snap.now).slice(-maxReadings)
    .map((r) => ({ ts: r.timestamp, type: 'reading', status: statusByTs.get(r.timestamp) }));
  // Confirmed deliveries (operational record) matched with the fill the monitor detected.
  const detected = events.filter((e) => e.type === 'delivery');
  const used = new Set();
  const delivered = h.deliveries.map((d) => {
    const m = detected.find((e) => !used.has(e) && Math.abs(e.ts - d.ts) <= 60 * 60_000);
    if (m) used.add(m);
    return { ts: d.ts, type: 'delivered', truckId: d.truckId, litres: d.litres, from: m ? m.from : null, to: m ? m.to : null };
  });
  const unmatched = detected.filter((e) => !used.has(e));
  const other = events.filter((e) => e.type === 'status');
  const log = snap.log.filter((l) => l.householdId === h.id && l.type === 'low_water').map((l) => ({ ts: l.ts, type: 'low_water' }));
  const checks = snap.checks.filter((c) => c.householdId === h.id).map((c) => ({ ts: c.ts, type: 'check', recommendation: c.recommendation }));
  const notices = snap.allAlerts.map((a) => ({ ts: a.ts, type: 'notice', alertType: a.type }));
  return { readings, others: [...delivered, ...unmatched, ...other, ...log, ...checks, ...notices] };
}

function describe(item) {
  switch (item.type) {
    case 'reading':
      return { icon: STATUS_ICON[item.status] || 'i-system', tone: item.status, title: t('activity.reading'), sub: t(`history.status.${item.status}`) };
    case 'status': {
      const returned = item.status === STATUS.NORMAL && (item.previous === STATUS.CHECK || item.previous === STATUS.ACTION);
      const title = returned ? t('history.returned') : item.status === STATUS.SYSTEM_CHECK ? t('history.monitorProblem') : t(`history.status.${item.status}`);
      const sub = (item.status === STATUS.CHECK || item.status === STATUS.ACTION) && item.changed && item.changed.length
        ? t('history.changedFrom', { list: listJoin(item.changed.map((k) => t(`param.short.${k}`))) }) : null;
      return { icon: STATUS_ICON[item.status], tone: item.status, title, sub };
    }
    case 'delivered': {
      const parts = [t('truck.label', { id: item.truckId }), litres(item.litres)];
      if (typeof item.from === 'number') parts.push(t('history.levels', { from: Math.round(item.from), to: Math.round(item.to) }));
      return { icon: 'i-truck', tone: 'info', title: t('history.delivered'), sub: parts.join(' · ') };
    }
    case 'delivery':
      return { icon: 'i-truck', tone: 'info', title: t('history.delivery'), sub: typeof item.from === 'number' ? t('history.levels', { from: Math.round(item.from), to: Math.round(item.to) }) : null };
    case 'low_water':
      return { icon: 'i-drop', tone: 'CHECK', title: t('history.lowWater'), sub: t('history.lowWaterSub') };
    case 'check':
      return { icon: 'i-clipboard', tone: 'info', title: t('history.check'), sub: item.recommendation ? t(`rec.${item.recommendation}.title`) : null };
    case 'notice':
      return { icon: 'i-bell', tone: item.alertType === 'advisory' ? STATUS.ACTION : 'info', title: t('history.notice'), sub: t(`alert.${item.alertType}.title`) };
    default:
      return { icon: 'i-info', tone: 'info', title: '', sub: null };
  }
}

export function renderResidentHistory(h, snap) {
  const host = $('#timeline');
  const latest = h.analysis.latest;
  const since = latest ? latest.timestamp - HISTORY_READING_WINDOW_MS : -Infinity;
  const { readings, others } = timelineItems(h, snap, { readingsSince: since });
  // Keep the timeline readable: readings every 30 min are enough here.
  const thinned = readings.filter((r, i) => i === readings.length - 1 || new Date(r.ts).getMinutes() % 30 < 5);
  const items = [...thinned, ...others].filter((i) => i.ts <= snap.now).sort((a, b) => b.ts - a.ts);
  if (!items.length) {
    host.replaceChildren(el('p', { class: 'timeline-empty', i18n: ['history.empty'] }));
    return;
  }
  const groups = [];
  for (const it of items) {
    const day = dayLabel(it.ts);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(it);
  }
  host.replaceChildren(...groups.map((g) =>
    el('section', { class: 'timeline-group' }, el('h2', { class: 'timeline-day-h' }, g.day),
      el('ol', { class: 'timeline' }, ...g.items.map((it) => {
        const d = describe(it);
        return el('li', { class: `timeline-item tone-${String(d.tone).toLowerCase()}` }, el('p', { class: 'timeline-when' }, clockTime(it.ts)),
          el('div', { class: 'timeline-body' }, icon(d.icon, 'timeline-icon'),
            el('div', {}, el('p', { class: 'timeline-title' }, d.title), d.sub ? el('p', { class: 'timeline-sub' }, d.sub) : null)));
      })))));
}

// ---------- WATER (why this status + details) ----------
function fmt(key, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (key === 'turbidity') return `${v.toFixed(1)} NTU`;
  if (key === 'conductivity') return `${Math.round(v)} µS/cm`;
  if (key === 'temperature') return `${v.toFixed(1)} °C`;
  return `${Math.round(v)} %`;
}

export function renderWater(h) {
  const result = h.result;
  const s = result.status;
  setText($('#why-h'), 'why.title', { word: t(`status.${s}.word`) });
  const summaryKey = s === STATUS.ACTION ? (result.advisory ? 'why.summary.ACTION.advisory' : 'why.summary.ACTION.major') : `why.summary.${s}`;
  const banner = $('#why-banner');
  banner.dataset.status = s;
  banner.replaceChildren(icon(STATUS_ICON[s], 'why-banner-icon'),
    el('div', {}, el('p', { class: 'why-banner-word', i18n: [`status.${s}.word`] }), el('p', { class: 'why-banner-msg', i18n: [summaryKey] })));

  const list = $('#param-list');
  list.replaceChildren();
  if (result.advisory) {
    list.append(el('li', { class: 'param tone-action' }, icon('i-action', 'param-icon'),
      el('div', { class: 'param-text' }, el('span', { class: 'param-name', i18n: ['why.advisory'] })),
      el('span', { class: 'param-state', i18n: ['why.advisory.on'] })));
  }
  for (const key of SENSORS) {
    const p = result.params[key];
    const vis = PARAM_VISUAL[p.state];
    const stateKey = key === 'tankLevel' && p.state === PARAM.NORMAL ? 'pstate.working' : `pstate.${p.state}`;
    list.append(el('li', { class: `param tone-${vis.tone}` }, icon(vis.icon, 'param-icon'),
      el('div', { class: 'param-text' }, el('span', { class: 'param-name', i18n: [`param.${key}`] }), el('span', { class: 'param-help', i18n: [`param.help.${key}`] })),
      el('span', { class: 'param-state', i18n: [stateKey] })));
  }
  $('#why-caveat').replaceChildren(icon('i-info', 'inline-icon'), el('span', { i18n: [`why.caveat.${s}`] }));
  $('#next-list').replaceChildren(el('li', { i18n: [`why.next.${s}.1`] }), el('li', { i18n: [`why.next.${s}.2`] }));

  const rules = {
    turbidity: t('why.tech.rule.turbidity', { c: T.turbidity.changedRise, m: T.turbidity.majorRise }),
    conductivity: t('why.tech.rule.conductivity', { c: T.conductivity.changedFraction * 100, m: T.conductivity.majorFraction * 100 }),
    temperature: t('why.tech.rule.temperature', { c: T.temperature.changedDelta }),
    tankLevel: t('why.tech.rule.tankLevel', { d: T.deliveryRisePoints }),
  };
  const r = h.analysis.latest;
  $('#tech-body').replaceChildren(
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['why.tech.param', 'why.tech.current', 'why.tech.baseline', 'why.tech.rule'].map((k) => el('th', { scope: 'col', i18n: [k] })))),
      el('tbody', {}, ...SENSORS.map((key) => {
        const p = result.params[key];
        return el('tr', {}, el('th', { scope: 'row', i18n: [`param.${key}`] }), el('td', {}, fmt(key, p.value)),
          el('td', {}, key === 'tankLevel' ? '—' : fmt(key, p.baseline)), el('td', {}, rules[key]));
      })))),
    el('p', { class: 'hint' }, `${t('why.tech.readingAt')}: ${r ? new Date(r.timestamp).toLocaleString() : '—'} · ${h.meta.sensorDevice || t('sensor.NOT_INSTALLED')}`),
    el('p', { class: 'hint', i18n: ['why.tech.note'] }),
  );
  renderChart(h);
}

function renderChart(h) {
  const host = $('#tank-chart-svg');
  const readings = h.readings.filter((r) => typeof r.tankLevel === 'number');
  host.replaceChildren();
  $('#tank-chart').hidden = readings.length < 2;
  if (readings.length < 2) return;
  const W = 600, H = 190, L = 38, R = 8, TOP = 18, B = 24;
  const end = readings[readings.length - 1].timestamp;
  const start = end - 48 * 3600_000;
  const pts = readings.filter((r) => r.timestamp >= start);
  const x = (ts) => L + ((ts - start) / (end - start)) * (W - L - R);
  const y = (v) => TOP + (1 - v / 100) * (H - TOP - B);
  const deliveries = h.deliveries.filter((d) => d.ts >= start);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img' });
  root.setAttribute('aria-label', t('chart.summary', { start: Math.round(pts[0].tankLevel), now: Math.round(pts[pts.length - 1].tankLevel), n: deliveries.length }));
  for (const v of [0, 50, 100]) {
    root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'chart-grid' }));
    const lbl = svg('text', { x: L - 6, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' });
    lbl.textContent = `${v}%`;
    root.append(lbl);
  }
  const line = pts.map((r, i) => `${i ? 'L' : 'M'}${x(r.timestamp).toFixed(1)},${y(r.tankLevel).toFixed(1)}`).join('');
  root.append(svg('path', { d: `${line}L${x(end).toFixed(1)},${y(0)}L${x(pts[0].timestamp).toFixed(1)},${y(0)}Z`, class: 'chart-area' }));
  root.append(svg('path', { d: line, class: 'chart-line' }));
  for (const d of deliveries) {
    const dx = x(d.ts);
    root.append(svg('line', { x1: dx, x2: dx, y1: TOP - 4, y2: y(0), class: 'chart-delivery' }));
    const lbl = svg('text', { x: Math.min(dx + 5, W - 60), y: TOP + 6, class: 'chart-delivery-label' });
    lbl.textContent = t('chart.delivery');
    root.append(lbl);
  }
  const last = pts[pts.length - 1];
  root.append(svg('circle', { cx: x(last.timestamp), cy: y(last.tankLevel), r: 5, class: 'chart-dot' }));
  [[start, 'chart.ago48', 'start'], [start + 24 * 3600_000, 'chart.ago24', 'middle'], [end, 'chart.now', 'end']].forEach(([ts, key, anchor]) => {
    const lbl = svg('text', { x: x(ts), y: H - 6, class: 'chart-axis', 'text-anchor': anchor });
    lbl.textContent = t(key);
    root.append(lbl);
  });
  host.append(root);
}

// ---------- CHECK ----------
export function resetCheckForm() {
  $('#check-form').reset();
  $('#check-form').hidden = false;
  $('#check-result').hidden = true;
  $('#check-error').textContent = '';
  $$('.choice-group').forEach((fs) => fs.classList.remove('has-error'));
}

export function bindCheckForm(getHouseholdId) {
  $('#check-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const answers = { appearance: data.get('appearance'), smell: data.get('smell'), chlorine: data.get('chlorine') || 'not_tested' };
    const missing = [];
    if (!answers.appearance) missing.push('#fs-appearance');
    if (!answers.smell) missing.push('#fs-smell');
    $$('.choice-group').forEach((fs) => fs.classList.remove('has-error'));
    if (missing.length) {
      missing.forEach((id) => $(id).classList.add('has-error'));
      setText($('#check-error'), 'check.error');
      $(`${missing[0]} input`).focus();
      return;
    }
    $('#check-error').textContent = '';
    const record = ctx.ops.saveCheck(getHouseholdId(), answers);
    const tone = REC_TONE[record.recommendation];
    const result = $('#check-result');
    result.dataset.status = tone;
    result.replaceChildren(
      el('div', { class: 'rec' }, icon(STATUS_ICON[tone], 'rec-icon'),
        el('div', {}, el('h2', { class: 'rec-title', i18n: [`rec.${record.recommendation}.title`] }), el('p', { i18n: [`rec.${record.recommendation}.body`] }))),
      el('p', { class: 'hint saved-note', i18n: ['check.saved'] }),
      el('p', { class: 'hint', i18n: ['check.note'] }),
      el('div', { class: 'row-actions' },
        el('button', { type: 'button', class: 'btn btn-secondary', id: 'check-again', i18n: ['check.again'], onclick: () => { resetCheckForm(); $('#fs-appearance input').focus(); } }),
        el('a', { class: 'btn btn-primary', href: '#/home', i18n: ['check.home'] })));
    e.currentTarget.hidden = true;
    result.hidden = false;
    result.focus();
  });
}
