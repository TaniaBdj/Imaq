/**
 * DRIVER views — used inside a truck, possibly with gloves: very large targets,
 * one primary action per screen, confirmation before anything irreversible.
 */
import { ctx, t, $, el, icon, litres, pct, shortWhen, clockTime, priorityBadge, statusBadge, reasonText, tankBar, runAction } from './common.js';
import { STATUS } from '../detection.js';

function truckHeader(truck, snap) {
  const out = truck.status !== 'OPERATING';
  return el('section', { class: `card truck-head${out ? ' is-out' : ''}`, 'aria-labelledby': 'truck-h' },
    el('div', { class: 'truck-head-row' },
      el('div', {}, el('p', { class: 'eyebrow', i18n: ['driver.truck'] }), el('h1', { id: 'truck-h', class: 'truck-id', tabindex: '-1' }, t('truck.label', { id: truck.id }))),
      el('span', { class: 'badge', 'data-truck': truck.status }, icon(out ? 'i-system' : 'i-normal', 'badge-icon'), el('span', { i18n: [`truck.status.${truck.status}`] }))),
    el('dl', { class: 'truck-facts' },
      el('div', {}, el('dt', { i18n: ['driver.capacity'] }), el('dd', {}, litres(truck.capacityLitres))),
      el('div', {}, el('dt', { i18n: ['driver.remaining'] }), el('dd', { id: 'truck-remaining' }, litres(truck.remainingLitres))),
      el('div', {}, el('dt', { i18n: ['driver.trip'] }), el('dd', {}, t('driver.tripN', { n: truck.trip })))),
    el('div', { class: 'truck-water', role: 'img', 'aria-label': t('driver.waterAria', { pct: Math.round((truck.remainingLitres / truck.capacityLitres) * 100) }), style: `--level:${Math.round((truck.remainingLitres / truck.capacityLitres) * 100)}%` }, el('div', { class: 'tank-fill' })));
}

function outOfServiceBanner(truck) {
  return el('section', { class: 'out-banner', role: 'alert' }, icon('i-system', 'out-icon'),
    el('div', {}, el('h2', { i18n: ['driver.outTitle'] }), el('p', { i18n: ['driver.outBody'] }),
      el('button', { type: 'button', class: 'btn btn-secondary btn-xl', id: 'restore-truck', onclick: () => onRestore(truck) }, el('span', { i18n: ['driver.restore'] }))));
}

export function renderDriverRoute(truck, snap) {
  const root = $('#driver-route-root');
  const stops = truck.today.map((id) => snap.households[id]);
  const next = stops[0];
  const parts = [truckHeader(truck, snap)];
  if (truck.status !== 'OPERATING') {
    parts.push(outOfServiceBanner(truck));
  } else if (!next) {
    parts.push(el('section', { class: 'card next-empty' }, icon('i-normal', 'next-empty-icon'), el('h2', { i18n: ['driver.noStops'] }), el('p', { class: 'hint', i18n: ['driver.noStopsHint'] })));
  } else {
    const shortfall = next.estLitres != null && next.estLitres > truck.remainingLitres;
    parts.push(el('section', { class: 'card next-stop', 'aria-labelledby': 'next-h', 'data-priority': next.priority.level },
      el('div', { class: 'next-top' }, el('p', { class: 'eyebrow', i18n: ['driver.next'] }), priorityBadge(next.priority.level)),
      el('h2', { class: 'next-house', id: 'next-h' }, t('house.label', { id: next.id })),
      next.plan.reassigned ? el('p', { class: 'reassigned-chip' }, t('driver.fromTruck', { id: next.plan.originalTruck })) : null,
      el('ul', { class: 'reasons' }, ...next.priority.reasons.filter((r) => r !== 'days').map((r) => el('li', {}, reasonText(r, next)))),
      el('dl', { class: 'next-facts' },
        el('div', {}, el('dt', { i18n: ['driver.tankEst'] }), el('dd', {}, pct(next.level), tankBar(next.level))),
        el('div', {}, el('dt', { i18n: ['driver.people'] }), el('dd', {}, String(next.meta.occupants))),
        el('div', {}, el('dt', { i18n: ['driver.vulnerability'] }), el('dd', {}, next.meta.vulnerability ? t(`vuln.${next.meta.vulnerability}`) : t('driver.none'))),
        el('div', {}, el('dt', { i18n: ['driver.deliver'] }), el('dd', { class: 'deliver-amount' }, next.estLitres != null ? `~${litres(next.estLitres)}` : t('driver.fillTank')))),
      next.status !== STATUS.NORMAL ? el('p', { class: 'hint' }, t('driver.waterStatus'), ' ', statusBadge(next.status)) : null,
      shortfall ? el('p', { class: 'warn-line', role: 'note' }, icon('i-check', 'inline-icon'), el('span', { i18n: ['driver.shortfall'] })) : null,
      el('button', { type: 'button', class: 'btn btn-primary btn-xl btn-deliver', id: 'deliver-btn', onclick: () => onDeliver(truck, next) },
        icon('i-normal', 'btn-icon'), el('span', { i18n: ['driver.delivered'] }))));
    if (stops.length > 1) {
      parts.push(el('section', { class: 'card', 'aria-labelledby': 'upnext-h' }, el('h2', { class: 'eyebrow', id: 'upnext-h', i18n: ['driver.upNext'] }),
        el('ol', { class: 'upnext' }, ...stops.slice(1).map((h) => el('li', {},
          el('span', { class: 'upnext-house' }, h.id), priorityBadge(h.priority.level),
          el('span', { class: 'upnext-meta' }, `${pct(h.level)} · ${h.estLitres != null ? `~${litres(h.estLitres)}` : '—'}`),
          h.plan.reassigned ? el('span', { class: 'reassigned-chip' }, t('driver.fromTruck', { id: h.plan.originalTruck })) : null)))));
    }
  }
  if (truck.deliveredToday.length) {
    parts.push(el('section', { class: 'card', 'aria-labelledby': 'done-h' }, el('h2', { class: 'eyebrow', id: 'done-h', i18n: ['driver.doneToday'] }),
      el('ol', { class: 'done-list' }, ...truck.deliveredToday.map((d) => el('li', {}, icon('i-normal', 'inline-icon'),
        el('span', { class: 'upnext-house' }, d.householdId), el('span', { class: 'upnext-meta' }, `${clockTime(d.ts)} · ${litres(d.litres)}`))))));
  }
  if (truck.status === 'OPERATING') {
    parts.push(el('div', { class: 'driver-actions' },
      el('button', { type: 'button', class: 'btn btn-secondary btn-xl', id: 'plant-btn', onclick: () => onReturnToPlant(truck) }, icon('i-plant', 'btn-icon'), el('span', { i18n: ['driver.returnPlant'] })),
      el('button', { type: 'button', class: 'btn btn-danger btn-xl', id: 'problem-btn', onclick: () => onProblem(truck) }, icon('i-check', 'btn-icon'), el('span', { i18n: ['driver.reportProblem'] }))));
  }
  root.replaceChildren(...parts);
}

export function renderDriverTruck(truck, snap) {
  const root = $('#driver-truck-root');
  root.replaceChildren(
    truckHeader(truck, snap),
    truck.status !== 'OPERATING' ? outOfServiceBanner(truck) : null,
    el('section', { class: 'card' }, el('h2', { class: 'eyebrow', i18n: ['driver.today'] }),
      el('dl', { class: 'truck-facts' },
        el('div', {}, el('dt', { i18n: ['driver.stopsLeft'] }), el('dd', {}, String(truck.today.length))),
        el('div', {}, el('dt', { i18n: ['driver.delivered'] }), el('dd', {}, String(truck.deliveredToday.length))),
        el('div', {}, el('dt', { i18n: ['admin.kpi.village'] }), el('dd', {}, `${snap.kpis.villageWaterCubicMetres} m³`)))),
    truck.status === 'OPERATING' ? el('div', { class: 'driver-actions' },
      el('button', { type: 'button', class: 'btn btn-secondary btn-xl', onclick: () => onReturnToPlant(truck) }, icon('i-plant', 'btn-icon'), el('span', { i18n: ['driver.returnPlant'] })),
      el('button', { type: 'button', class: 'btn btn-danger btn-xl', onclick: () => onProblem(truck) }, icon('i-check', 'btn-icon'), el('span', { i18n: ['driver.reportProblem'] }))) : null,
  );
}

export function renderDriverHistory(truck, snap) {
  const root = $('#driver-history-root');
  const all = snap.deliveries.filter((d) => d.truckId === truck.id && d.ts <= snap.now).sort((a, b) => b.ts - a.ts).slice(0, 30);
  root.replaceChildren(
    el('h1', { tabindex: '-1', i18n: ['driver.historyTitle'] }),
    all.length ? el('ol', { class: 'done-list card' }, ...all.map((d) => el('li', {}, icon('i-truck', 'inline-icon'),
      el('span', { class: 'upnext-house' }, d.householdId), el('span', { class: 'upnext-meta' }, `${shortWhen(d.ts)} · ${litres(d.litres)}`))))
      : el('p', { class: 'hint', i18n: ['history.empty'] }),
  );
}

async function onDeliver(truck, h) {
  const suggested = Math.min(h.estLitres ?? 1000, truck.remainingLitres);
  const res = await ctx.confirm({
    title: t('driver.confirmTitle'),
    body: el('div', {}, el('p', { class: 'confirm-house' }, t('house.label', { id: h.id })),
      el('p', {}, `${t('driver.estimated')}: ${h.estLitres != null ? litres(h.estLitres) : '—'}`)),
    input: { label: t('driver.actual'), value: suggested, min: 1, max: truck.remainingLitres, suffix: 'L', error: t('driver.amountError', { max: litres(truck.remainingLitres) }) },
    confirmLabel: t('driver.confirmDelivery'),
    tone: 'primary',
  });
  if (!res.ok) return;
  const done = await runAction(() => ctx.ops.confirmDelivery({ householdId: h.id, truckId: truck.id, litres: res.value }), t('driver.deliveredAnnounce', { id: h.id }));
  if (!done.ok) return;
  const next = $('#deliver-btn') || $('#truck-h');
  if (next) next.focus();
}

async function onReturnToPlant(truck) {
  const res = await ctx.confirm({ title: t('driver.plantTitle'), body: t('driver.plantBody'), confirmLabel: t('driver.plantYes'), tone: 'primary' });
  if (res.ok) await runAction(() => ctx.ops.returnToPlant(truck.id));
}

async function onProblem(truck) {
  const res = await ctx.confirm({ title: t('driver.problemTitle'), body: t('driver.problemBody'), confirmLabel: t('driver.problemYes'), tone: 'danger' });
  if (!res.ok) return;
  await runAction(() => ctx.ops.reportTruckProblem(truck.id), t('driver.outTitle'));
}

async function onRestore(truck) {
  const res = await ctx.confirm({ title: t('driver.restoreTitle'), body: t('driver.restoreBody'), confirmLabel: t('driver.restore'), tone: 'primary' });
  if (res.ok) await runAction(() => ctx.ops.restoreTruck(truck.id));
}
