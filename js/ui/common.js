/**
 * Shared UI helpers used by every role. No business logic here.
 */
import { translate } from '../i18n.js';
import { STATUS, PARAM } from '../detection.js';
import { daysBucket } from '../core/tank.js';

/** Filled in by app.js: { ops, session, confirm(opts) → Promise, announce(text), toast(text) } */
export const ctx = { ops: null, session: null, confirm: null, announce: null, toast: null };

/** Run a store action; report failures (offline, validation) instead of throwing into the UI. */
export async function runAction(fn, successText) {
  try {
    const out = await fn();
    if (successText && ctx.announce) ctx.announce(successText);
    return { ok: true, out };
  } catch (e) {
    const msg = e && e.offline ? t('error.offline') : t('error.action', { msg: (e && e.message) || '' });
    if (ctx.toast) ctx.toast(msg);
    return { ok: false, error: e };
  }
}

export const lang = () => (ctx.session ? ctx.session.current.lang : 'en');
export const t = (key, vars) => translate(lang(), key, vars).text;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Set text and mark English fallbacks with lang="en" for correct screen-reader pronunciation. */
export function setText(node, key, vars) {
  const r = translate(lang(), key, vars);
  node.textContent = r.text;
  if (r.lang !== lang()) node.setAttribute('lang', r.lang);
  else node.removeAttribute('lang');
  return node;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'i18n') setText(node, v[0], v[1]);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
export function icon(id, cls = '') {
  const s = svg('svg', { 'aria-hidden': 'true', focusable: 'false' });
  if (cls) s.setAttribute('class', cls);
  s.append(svg('use', { href: `#${id}` }));
  return s;
}

export const locale = () => (lang() === 'fr' ? 'fr-CA' : 'en-CA');

export function listJoin(items) {
  try {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export function relativeTime(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return t('time.never');
  const mins = Math.max(0, Math.floor((now - ts) / 60_000));
  if (mins < 1) return t('time.justNow');
  if (mins === 1) return t('time.minute');
  if (mins < 60) return t('time.minutes', { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return hrs === 1 ? t('time.hour') : t('time.hours', { n: hrs });
  return t('time.days', { n: Math.floor(hrs / 24) });
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export const clockTime = (ts) => new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return t('time.today');
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return t('time.yesterday');
  const tm = new Date(now);
  tm.setDate(now.getDate() + 1);
  if (sameDay(d, tm)) return t('time.tomorrow');
  return d.toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric' });
}
/** "12:42 p.m." today, otherwise "Yesterday · 9:42 a.m." */
export const shortWhen = (ts) => (sameDay(new Date(ts), new Date()) ? clockTime(ts) : `${dayLabel(ts)} · ${clockTime(ts)}`);

export const litres = (v) => `${new Intl.NumberFormat(locale()).format(Math.round(v))} L`;
export const pct = (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '—');

export const STATUS_ICON = {
  [STATUS.NORMAL]: 'i-normal',
  [STATUS.CHECK]: 'i-check',
  [STATUS.ACTION]: 'i-action',
  [STATUS.SYSTEM_CHECK]: 'i-system',
};
export const PARAM_VISUAL = {
  [PARAM.NORMAL]: { icon: 'i-normal', tone: 'normal' },
  [PARAM.CHANGED]: { icon: 'i-check', tone: 'check' },
  [PARAM.MAJOR]: { icon: 'i-action', tone: 'action' },
  [PARAM.INVALID]: { icon: 'i-system', tone: 'system' },
};
export const PRIORITY_ICON = { CRITICAL: 'i-action', HIGH: 'i-action', MEDIUM: 'i-check', LOW: 'i-normal' };

/** Status as icon + word (never colour alone). */
export function statusBadge(status, { short = false } = {}) {
  return el('span', { class: 'badge', 'data-status': status }, icon(STATUS_ICON[status], 'badge-icon'),
    el('span', { i18n: [short ? `status.${status}.short` : `status.${status}.word`] }));
}
export function priorityBadge(level) {
  return el('span', { class: 'badge', 'data-priority': level }, icon(PRIORITY_ICON[level], 'badge-icon'), el('span', { i18n: [`priority.${level}`] }));
}

/** Days of water: "About 6 days" · "About 1 day" · "Less than 1 day" · "Unknown" (never 0 for unknown). */
export function daysText(days) {
  const b = daysBucket(days);
  if (b.kind === 'unknown') return t('days.unknown');
  if (b.kind === 'lessThanOne') return t('days.less');
  return b.n === 1 ? t('days.one') : t('days.many', { n: b.n });
}

export const SENSOR_ICON = { ONLINE: 'i-normal', STALE: 'i-check', OFFLINE: 'i-system', SERVICE_REQUIRED: 'i-system', NOT_INSTALLED: 'i-info', UNASSIGNED: 'i-info' };
/** Monitor status as icon + word. */
export function sensorBadge(status) {
  return el('span', { class: 'badge', 'data-sensor': status }, icon(SENSOR_ICON[status] || 'i-info', 'badge-icon'), el('span', { i18n: [`sensor.${status}`] }));
}

/** Next delivery for a household, e.g. "Tomorrow morning · Truck T2". */
export function deliveryText(plan) {
  if (!plan) return '—';
  if (plan.when === 'delayed' && !plan.truckId) return t('delivery.delayedNoTruck');
  const truck = t('truck.label', { id: plan.truckId });
  let when;
  if (plan.when === 'today') when = plan.position ? t('delivery.todayStop', { n: plan.position, total: plan.stops }) : t('time.today');
  else if (plan.when === 'tomorrow') when = plan.delayed ? t('delivery.delayedTomorrow') : t('delivery.tomorrow');
  else when = dayLabel(plan.dueTs);
  return plan.reassigned ? t('delivery.reassigned', { truck, when }) : `${when} · ${truck}`;
}

export function reasonText(reason, h) {
  if (reason === 'days') return t('reason.days', { days: daysText(h.days) });
  if (reason === 'vulnerability') return t(`vuln.${h.meta.vulnerability}`);
  return t(`reason.${reason}`);
}

/** Simple, accessible tank bar. */
export function tankBar(level, { large = false } = {}) {
  const known = typeof level === 'number';
  return el('div', {
    class: `tank${large ? ' tank-lg' : ''}${known && level < 25 ? ' is-low' : ''}`, role: 'img',
    'aria-label': known ? t('tank.aria', { pct: Math.round(level) }) : t('tank.unknown'),
    style: `--level:${known ? Math.round(level) : 0}%`,
  }, el('div', { class: 'tank-fill' }), el('div', { class: 'tank-ticks', 'aria-hidden': 'true' }));
}
