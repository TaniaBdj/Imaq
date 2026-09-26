/**
 * Welcome + role entry. Role selection stands in for real sign-in (see session.js).
 */
import { ctx, t, $, el, icon, pct, statusBadge } from './common.js';

export function renderWelcome() {
  const card = (role, iconId, titleKey, subKey) =>
    el('a', { class: 'role-card', href: `#/${role}`, 'data-role': role }, icon(iconId, 'role-icon'),
      el('span', { class: 'role-text' }, el('span', { class: 'role-title', i18n: [titleKey] }), el('span', { class: 'role-sub', i18n: [subKey] })),
      icon('i-forward', 'role-chevron'));
  $('#welcome-root').replaceChildren(
    el('div', { class: 'welcome' },
      el('div', { class: 'welcome-brand' },
        icon('i-logo', 'welcome-mark'),
        el('h1', { class: 'welcome-title', tabindex: '-1' }, 'Imaq ', el('span', { lang: 'iu', class: 'brand-syll' }, 'ᐃᒪᖅ')),
        el('p', { class: 'welcome-tag', i18n: ['welcome.tagline'] })),
      el('h2', { class: 'welcome-q', i18n: ['welcome.question'] }),
      el('nav', { class: 'roles', 'aria-label': t('welcome.question') },
        card('resident', 'i-home', 'role.resident', 'role.resident.sub'),
        card('driver', 'i-truck', 'role.driver', 'role.driver.sub'),
        card('municipality', 'i-building', 'role.municipality', 'role.municipality.sub')),
      el('p', { class: 'welcome-foot' }, icon('i-offline', 'inline-icon'), el('span', { i18n: ['welcome.offline'] }))),
  );
}

function entryShell(titleKey, introKey, body) {
  return [
    el('a', { class: 'btn btn-back', href: '#/' }, icon('i-back'), el('span', { i18n: ['back'] })),
    el('div', { class: 'entry card' }, el('h1', { tabindex: '-1', i18n: [titleKey] }), el('p', { class: 'lead', i18n: [introKey] }), body),
  ];
}

export function renderResidentSelect(snap) {
  const last = ctx.session.current.lastHouseholdId;
  const ids = Object.keys(snap.households).sort();
  const form = el('form', { id: 'resident-form', onsubmit: (e) => {
    e.preventDefault();
    const id = new FormData(e.currentTarget).get('household');
    if (!id) {
      $('#resident-error').textContent = t('entry.chooseHousehold');
      e.currentTarget.querySelector('input').focus();
      return;
    }
    ctx.session.signInResident(id);
    location.hash = '#/home';
  } },
  el('fieldset', { class: 'choice-group plain' }, el('legend', { i18n: ['entry.household'] }),
    el('div', { class: 'choices choices-grid' }, ...ids.map((id) => el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'household', value: id, checked: id === last }), el('span', {}, t('house.label', { id })))))),
  el('p', { class: 'form-error', id: 'resident-error', role: 'alert' }),
  el('button', { type: 'submit', class: 'btn btn-primary btn-block btn-xl', id: 'resident-continue', i18n: ['entry.continue'] }));
  $('#resident-select-root').replaceChildren(...entryShell('entry.residentTitle', 'entry.residentIntro', form));
}

export function renderDriverSelect(snap) {
  const last = ctx.session.current.lastTruckId;
  const form = el('form', { id: 'driver-form', onsubmit: (e) => {
    e.preventDefault();
    const id = new FormData(e.currentTarget).get('truck');
    if (!id) {
      $('#driver-error').textContent = t('entry.chooseTruck');
      e.currentTarget.querySelector('input').focus();
      return;
    }
    ctx.session.signInDriver(id);
    location.hash = '#/route';
  } },
  el('fieldset', { class: 'choice-group plain' }, el('legend', { i18n: ['entry.truck'] }),
    el('div', { class: 'choices choices-trucks' }, ...snap.trucks.map((tr) => el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'truck', value: tr.id, checked: tr.id === last }),
      el('span', { class: 'choice-truck' }, icon('i-truck', 'btn-icon'), el('span', {}, t('truck.label', { id: tr.id })),
        el('small', { class: 'choice-sub' }, tr.status === 'OPERATING' ? t('entry.stopsToday', { n: tr.today.length }) : t(`truck.status.${tr.status}`))))))),
  el('p', { class: 'form-error', id: 'driver-error', role: 'alert' }),
  el('button', { type: 'submit', class: 'btn btn-primary btn-block btn-xl', id: 'driver-start', i18n: ['entry.startRoute'] }));
  $('#driver-select-root').replaceChildren(...entryShell('entry.driverTitle', 'entry.driverIntro', form));
}

export function renderAdminLogin() {
  const form = el('form', { id: 'admin-form', onsubmit: async (e) => {
    e.preventDefault();
    const pin = String(new FormData(e.currentTarget).get('pin') || '');
    const err = $('#pin-error');
    const input = $('#pin');
    try {
      // Verified by the API (server-side). Prototype access only — not authentication.
      await ctx.ops.verifyAdminPin(pin);
      ctx.session.signInMunicipality(pin);
      location.hash = '#/admin';
    } catch (x) {
      err.textContent = x && x.offline ? t('error.offlineSignIn') : t('entry.pinError');
      input.setAttribute('aria-invalid', 'true');
      input.select();
      input.focus();
    }
  } },
  el('label', { class: 'field', for: 'pin' }, el('span', { i18n: ['entry.pin'] })),
  el('input', { id: 'pin', name: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', class: 'pin-input', 'aria-describedby': 'pin-hint pin-error' }),
  el('p', { class: 'hint', id: 'pin-hint', i18n: ['entry.pinHint'] }),
  el('p', { class: 'form-error', id: 'pin-error', role: 'alert' }),
  el('button', { type: 'submit', class: 'btn btn-primary btn-block btn-xl', id: 'admin-signin', i18n: ['entry.signIn'] }));
  $('#admin-login-root').replaceChildren(...entryShell('entry.adminTitle', 'entry.adminIntro', form));
}
