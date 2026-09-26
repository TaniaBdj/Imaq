/**
 * End-to-end acceptance test in real Chromium against the real Imaq server + API +
 * PostgreSQL engine (embedded PGlite, fresh in-memory database per run): the exact
 * cross-role judge demo, admin CRUD, offline, role navigation, accessibility and wording audits.
 * Run: npm run test:e2e   (dev-only; the app itself has no dependencies)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8123;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS_DIR || '';
const axeSource = await readFile(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8').catch(() => null);

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}

const server = spawn(process.execPath, ['serve.mjs', String(PORT)], {
  cwd: ROOT, stdio: 'pipe', env: { ...process.env, DATABASE_URL: '', IMAQ_LOCAL_DB_DIR: '', NODE_ENV: 'test', IMAQ_ADMIN_PIN: '2026' },
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => /Imaq running/.test(String(d)) && resolve());
  server.stderr.on('data', (d) => console.error(String(d)));
  server.on('exit', (c) => reject(new Error('server exited ' + c)));
});
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } };
const ready = () => page.waitForSelector('body.is-ready');
const text = (sel) => page.locator(sel).innerText();
const bodyText = () => page.evaluate(() => document.body.innerText);
const visibleView = () => page.evaluate(() => document.querySelector('.view:not([hidden])')?.dataset.view);
const navLabels = () => page.locator('#tabbar a').allInnerTexts();

async function switchRole() {
  await page.click('#switch-role');
  await page.waitForFunction(() => document.querySelector('.view:not([hidden])')?.dataset.view === 'welcome');
}
async function asResident(id) {
  await page.click('[data-role="resident"]');
  await page.click(`label.choice:has-text("${id}")`);
  await page.click('#resident-continue');
  await page.waitForSelector('#status-word');
}
async function asDriver(id) {
  await page.click('[data-role="driver"]');
  await page.click(`label.choice:has-text("Truck ${id}")`);
  await page.click('#driver-start');
  await page.waitForSelector('#truck-h');
}
async function asMunicipality() {
  await page.click('[data-role="municipality"]');
  await page.fill('#pin', '2026');
  await page.click('#admin-signin');
  await page.waitForSelector('#kpi-trucks');
}
async function confirm() {
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
}

try {
  // ================= START: welcome page =================
  await page.goto(BASE + '?reset=1');
  await ready();
  check('Welcome page is the first screen', (await visibleView()) === 'welcome');
  const w = await bodyText();
  check('Welcome shows Resident / Driver / Municipality', /RESIDENT/i.test(w) && /DRIVER/i.test(w) && /MUNICIPALITY/i.test(w));
  check('No demo / scenario / simulation wording in the product UI', !/\b(demo|scenario|simulat)/i.test(w));
  check('No navigation bar before a role is chosen', !(await page.locator('#tabbar').isVisible()));
  await shot('01-welcome');

  // ================= FLOW 1: resident H-031 reports low water =================
  await asResident('H-031');
  check('Resident header shows House H-031', (await text('#brand-context')) === 'House H-031');
  check('7. Resident navigation: Home · Water · History · Help', JSON.stringify(await navLabels()) === JSON.stringify(['Home', 'Water', 'History', 'Help']));
  check('H-031 status NORMAL (no unusual change)', (await text('#status-word')) === 'NORMAL');
  check('H-031 low tank shown', (await text('#tank-pct')) === '25%' && (await page.getByText('Tank is getting low').isVisible()));
  check('H-031 next delivery: today, Truck T2, stop 3', /Today · stop 3 of 3 · Truck T2/.test(await text('#next-delivery')), await text('#next-delivery'));
  await shot('02-resident-h031');
  await page.click('#low-water-btn');
  check('Low-water report asks for confirmation', await page.locator('#confirm-dialog[open]').isVisible());
  await confirm();
  await page.waitForSelector('.low-reported-title');
  check('Low-water report confirmed on household screen (persisted via API)', await page.locator('.low-reported-title').isVisible());

  await switchRole();
  await page.click('[data-role="municipality"]');
  await page.fill('#pin', '0000');
  await page.click('#admin-signin');
  await page.waitForFunction(() => document.querySelector('#pin-error')?.textContent.length > 0);
  check('Wrong PIN is rejected', /not correct/.test(await text('#pin-error')));
  await page.fill('#pin', '2026');
  await page.click('#admin-signin');
  await page.waitForSelector('#kpi-trucks');
  check('7. Municipality navigation: Overview · Households · Trucks · Sensors · Alerts', JSON.stringify(await navLabels()) === JSON.stringify(['Overview', 'Households', 'Trucks', 'Sensors', 'Alerts']));
  check('Admin KPIs: households, attention, trucks, sensors, community water, alerts', (await page.locator('.kpi').count()) === 6 && /L$/.test((await text('#kpi-water .kpi-value')).trim()) && (await text('#kpi-sensors .kpi-value')) === '11 / 12');
  const firstRow = page.locator('.data-table tbody tr').first();
  check('1. Admin: H-031 is now first and HIGH priority', (await firstRow.getAttribute('data-house')) === 'H-031' && (await firstRow.getAttribute('data-priority')) === 'HIGH');
  check('Admin: H-031 row shows the low-water report', /Low-water report/.test(await firstRow.innerText()));
  check('Admin KPI: high-priority count shown', /high priority/.test(await text('#kpi-attention')));
  await shot('03-admin-after-report');
  await page.click('.row-link:has-text("H-031")');
  await page.waitForSelector('#detail-low');
  check('Admin household detail: low-water report YES', /^Yes/.test(await text('#detail-low dd')));
  check('Admin household detail: priority reasons explained', /Low-water light reported/.test(await bodyText()) && /Elder in household/.test(await bodyText()));
  await page.click('#ai-assess');
  await page.waitForSelector('#ai-source');
  check('AI risk assessment: button works; without a key it falls back to rule-based priority', /rule-based/.test(await text('#ai-source')) && /Decision support only/.test(await text('#ai-card')), await text('#ai-card'));
  check('Admin household detail: estimated litres, consumption, days remaining', /^[\d,]+ L$/.test(await text('#detail-litres dd')) && /L\/day/.test(await text('#detail-use dd')) && /About|Less than/.test(await text('#detail-days dd')));
  await shot('04-admin-h031');

  await switchRole();
  await asDriver('T2');
  check('7. Driver navigation: Route · Truck · Deliveries', JSON.stringify(await navLabels()) === JSON.stringify(['Route', 'Truck', 'Deliveries']));
  check('1. Driver T2: H-031 is the next stop', (await text('#next-h')) === 'House H-031');
  check('Driver sees priority reasons + vulnerability', /Low-water light reported/.test(await text('.next-stop')) && /Elder/.test(await text('.next-stop')));
  const deliverBox = await page.locator('#deliver-btn').boundingBox();
  check('Driver DELIVERED button is glove-sized (≥ 88 px tall)', deliverBox.height >= 88, JSON.stringify(deliverBox));
  await shot('05-driver-t2');

  // ================= FLOW 2: delivery =================
  await page.click('#deliver-btn');
  await page.waitForSelector('#confirm-dialog[open]');
  check('Delivery dialog pre-fills the estimated litres', (await page.inputValue('#confirm-input')) === '1150');
  await page.fill('#confirm-input', '99999');
  await page.click('#confirm-ok');
  check('Delivery amount is validated', /Enter an amount/.test(await text('#confirm-error')) && (await page.locator('#confirm-dialog[open]').isVisible()));
  await page.fill('#confirm-input', '1150');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
  await page.waitForFunction(() => document.querySelector('#truck-remaining')?.textContent === '5,650 L');
  check('2. Driver: next stop moves on after delivery', (await text('#next-h')) !== 'House H-031');
  check('2. Driver: truck water decreased (6,800 → 5,650 L)', (await text('#truck-remaining')) === '5,650 L', await text('#truck-remaining'));
  check('2. Driver: delivery listed as completed today', /H-031/.test(await text('.done-list')));

  await switchRole();
  await asResident('H-031');
  const pctAfter = parseInt(await text('#tank-pct'), 10);
  check('2. Household H-031: tank is now high', pctAfter >= 95, String(pctAfter));
  check('2. Household: low-water report cleared', await page.locator('#low-water-btn').isVisible());
  check('2. Household: last delivery is today', !/Sep|Yesterday/.test(await text('#tank-delivery')));
  await page.click('#tabbar >> text=History');
  await page.waitForSelector('[data-view="history"]:not([hidden])');
  check('2. Household history shows the confirmed delivery', /Water delivered[\s\S]*Truck T2 · 1,150 L/.test(await text('#timeline')), (await text('#timeline')).slice(0, 300));
  await shot('06-resident-after-delivery');

  await switchRole();
  await asMunicipality();
  check('2. Admin: H-031 no longer high priority', !(await page.locator('.data-table tr[data-house="H-031"][data-priority="HIGH"]').count()));

  // ================= FLOW 3: truck breakdown =================
  await switchRole();
  await asDriver('T2');
  await page.click('#problem-btn');
  check('Truck problem asks for confirmation', await page.locator('#confirm-dialog[open]').isVisible());
  await confirm();
  await page.waitForSelector('.out-banner');
  check('3. Driver sees truck out of service', await page.getByRole('heading', { name: 'Truck out of service' }).isVisible());
  await shot('07-driver-out');

  await switchRole();
  await asMunicipality();
  check('3. Admin KPI: 2 / 3 trucks operating', (await text('#kpi-trucks .kpi-value')) === '2 / 3');
  check('3. Admin: truck-down alert lists affected households', /Truck T2 out of service/.test(await bodyText()) && /H-012/.test(await text('.ops-alert')));
  await shot('08-admin-truck-down');
  await page.click('#tabbar >> text=Trucks');
  await page.waitForSelector('[data-truck-card="T2"]');
  check('3. Admin trucks: T2 out of service, routes recalculated', /Out of service/.test(await text('[data-truck-card="T2"]')) && (await page.locator('[data-truck-card="T1"] .stop-chips li, [data-truck-card="T3"] .stop-chips li').count()) >= 5);

  // ================= FLOW 4: municipal alert =================
  await page.click('#tabbar >> text=Alerts');
  await page.waitForSelector('#alert-form');
  await page.click('label.choice:has-text("Delivery delay")');
  await page.fill('#alert-form textarea[name="note"]', 'Truck T2 is being repaired.');
  await page.click('#send-alert');
  await confirm();
  await page.waitForSelector('.alert-list');
  check('4. Admin: notice is active', /Delivery delay/.test(await text('.alert-list')));
  await shot('09-admin-alert');

  await switchRole();
  await asResident('H-012');
  check('4. Household H-012 sees the municipal notice', (await page.locator('.notice-delay').isVisible()) && /Water deliveries are delayed today/.test(await text('#notices')));
  check('4. Household sees the municipality’s note', /Truck T2 is being repaired\./.test(await text('#notices')));
  check('Synthetic-data label visible for every role', await page.locator('#data-note').isVisible());
  check('3. Household H-012 delivery reassigned', /Reassigned to Truck T[13]/.test(await text('#next-delivery')), await text('#next-delivery'));
  await shot('10-resident-h012-notice');

  // ================= ADMIN CRUD through the UI =================
  await switchRole();
  await asMunicipality();
  await page.click('#tabbar >> text=Trucks');
  await page.click('#add-truck');
  await page.waitForSelector('#f-id');
  await page.fill('#f-id', 'T4');
  await page.fill('#f-displayName', 'Truck T4');
  await page.fill('#f-capacityL', '8000');
  await page.fill('#f-currentWaterL', '8000');
  await page.click('#form-save');
  await page.waitForSelector('[data-truck-card="T4"]');
  check('CRUD: admin adds truck T4 through the form', await page.locator('[data-truck-card="T4"]').isVisible());
  await page.click('#tabbar >> text=Households');
  await page.click('#add-household');
  await page.waitForSelector('#f-id');
  await page.fill('#f-id', 'H-103');
  await page.fill('#f-residentsCount', '3');
  await page.selectOption('#f-assignedTruckId', 'T4');
  await page.click('#form-save');
  await page.waitForFunction(() => location.hash === '#/admin/household/H-103');
  await page.waitForSelector('#detail-level');
  check('CRUD: new household H-103 appears; no sensor → tank UNKNOWN, monitor NOT INSTALLED', (await text('#detail-level')) === '—' && /Not installed/.test(await text('#admin-household-root')) && /Unknown/.test(await text('#detail-days dd')));
  await page.click('#edit-household');
  await page.waitForSelector('#f-residentsCount');
  await page.fill('#f-residentsCount', '4');
  await page.click('#form-save');
  await page.waitForSelector('#detail-level');
  check('CRUD: household edited', /4/.test(await text('#admin-household-root')));
  await page.click('#tabbar >> text=Sensors');
  await page.waitForSelector('#sensor-table');
  await page.selectOption('tr[data-sensor="IMQ-0100"] select', 'H-103');
  await page.click('[data-assign="IMQ-0100"]');
  await confirm();
  await page.waitForFunction(() => /Online/.test(document.querySelector('tr[data-sensor="IMQ-0100"]')?.innerText || ''));
  check('SENSORS: spare IMQ-0100 assigned to H-103 → online', /H-103/.test(await text('tr[data-sensor="IMQ-0100"]')));
  await page.goto(BASE + '#/admin/household/H-103');
  await page.waitForSelector('#detail-level');
  check('SENSORS: H-103 is now monitored with a measured tank level', /%$/.test(await text('#detail-level')));
  await shot('09b-admin-sensors');
  await switchRole();
  await page.click('[data-role="driver"]');
  await page.waitForSelector('#driver-form');
  check('CRUD: new truck T4 is selectable by drivers', await page.locator('label.choice:has-text("Truck T4")').isVisible());
  await page.goto(BASE + '#/');
  await ready();

  // ================= OFFLINE: last synced data, read-only, honest =================
  await asResident('H-012');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await ready();
  check('Service worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload();
  await ready();
  check('6. OFFLINE reload: app shell loads from the device', (await text('#brand-context')) === 'House H-012');
  check('6. OFFLINE: resident sees last synced data, labelled as offline', (await page.locator('#sync-banner').isVisible()) && /Offline/.test(await text('#sync-banner')) && /Water deliveries are delayed/.test(await text('#notices')));
  await switchRole();
  await asDriver('T1');
  check('6. OFFLINE: driver route is viewable (last synced)', (await text('#truck-h')) === 'Truck T1' && (await page.locator('#deliver-btn').isVisible()));
  await page.click('#deliver-btn');
  await confirm();
  await page.waitForSelector('#toast:not([hidden])');
  check('6. OFFLINE: a delivery is NOT faked — the driver is told it was not sent', /No connection/.test(await text('#toast')));
  await context.setOffline(false);
  await page.reload();
  await ready();
  await page.waitForFunction(() => document.querySelector('#sync-banner')?.hidden === true);
  check('5. Back online: state reloads from the API', !(await page.locator('#sync-banner').isVisible()));

  // ================= Role guard, invalid sensors, filters =================
  await switchRole();
  await asMunicipality();
  await page.goto(BASE + '#/home');
  await page.waitForFunction(() => document.querySelector('.view:not([hidden])')?.dataset.view === 'admin-overview');
  check('7. Role guard: municipality cannot open resident screens', (await visibleView()) === 'admin-overview');
  await page.goto(BASE + '#/admin/households');
  await page.waitForSelector('#hh-table');
  await page.click('.chip[data-filter="monitor"]');
  const monitorRows = await page.locator('#hh-table tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.house));
  check('Admin filter "Monitor issue" → H-044 and H-057', JSON.stringify(monitorRows.sort()) === JSON.stringify(['H-044', 'H-057']), JSON.stringify(monitorRows));
  await page.click('.chip[data-filter="all"]');
  await page.fill('#hh-search', 'H-03');
  check('Admin search narrows the table', (await page.locator('#hh-table tbody tr').count()) === 2);
  await switchRole();
  await asResident('H-057');
  check('8. Invalid sensor (H-057) → SYSTEM CHECK', (await text('#status-word')) === 'SYSTEM CHECK' && /No valid reading/.test(await text('#cond-list')));
  await switchRole();
  await asResident('H-044');
  check('8. Offline monitor (H-044) → SYSTEM CHECK, no recent reading', (await text('#status-word')) === 'SYSTEM CHECK' && /No recent reading/.test(await text('#meta-monitor')));
  await shot('11-resident-h044');
  // ================= Language =================
  await page.selectOption('#lang-select', 'fr');
  check('FR: role UI translated', (await text('#brand-context')) === 'Maison H-044' && /Accueil/.test((await navLabels()).join(' ')));
  await page.selectOption('#lang-select', 'iu');
  check('IU: English fallback marked lang="en" + note', (await page.locator('#iu-note').isVisible()) && (await page.getAttribute('#status-msg', 'lang')) === 'en');
  await page.selectOption('#lang-select', 'en');

  // ================= Layout: overflow & touch targets on every role screen =================
  const SCREENS = {
    none: ['#/', '#/resident', '#/driver', '#/municipality'],
    resident: ['#/home', '#/water', '#/check', '#/history', '#/help'],
    driver: ['#/route', '#/truck', '#/deliveries'],
    municipality: ['#/admin', '#/admin/households', '#/admin/household/H-031', '#/admin/household/H-044', '#/admin/trucks', '#/admin/sensors', '#/admin/alerts', '#/admin/household-new', '#/admin/truck/T1/edit'],
  };
  const setRole = async (role) => page.evaluate((r) => {
    const s = window.__imaq.session;
    if (r === 'resident') s.signInResident('H-012');
    else if (r === 'driver') s.signInDriver('T1');
    else if (r === 'municipality') s.signInMunicipality('2026');
    else s.signOut();
  }, role);
  const overflow = [];
  const small = new Set();
  for (const [vw, vh] of [[1280, 800], [800, 1280], [390, 844], [360, 640]]) {
    await page.setViewportSize({ width: vw, height: vh });
    for (const [role, routes] of Object.entries(SCREENS)) {
      await setRole(role);
      for (const r of routes) {
        await page.goto(BASE + r);
        await ready();
        await page.waitForTimeout(50);
        const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (o > 0) overflow.push(`${vw}x${vh} ${role}${r} +${o}px`);
        (await page.evaluate(() => Array.from(document.querySelectorAll('a[href], button, select, summary, .choice, input:not([type=radio]), textarea'))
          .filter((n) => n.offsetParent !== null && !n.classList.contains('skip-link') && !n.closest('.table-wrap .hint'))
          .map((n) => ({ n, r: n.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.width < 48 || r.height < 48))
          .map(({ n, r }) => `${n.tagName}.${n.className}"${(n.textContent || '').trim().slice(0, 18)}" ${Math.round(r.width)}x${Math.round(r.height)}`))).forEach((s) => small.add(`${role}${r}: ${s}`));
      }
    }
  }
  check('No horizontal overflow on any role screen (4 viewports)', overflow.length === 0, overflow.join(', '));
  check('All touch targets ≥ 48×48 on every role screen', small.size === 0, [...small].slice(0, 12).join(' | '));
  await page.setViewportSize({ width: 390, height: 844 });
  await setRole('driver');
  await page.goto(BASE + '#/route');
  await ready();
  await shot('12-driver-phone');
  await setRole('resident');
  await page.goto(BASE + '#/home');
  await ready();
  await shot('13-resident-phone');
  await page.setViewportSize({ width: 1280, height: 800 });

  // ================= Accessibility (axe) on every role screen =================
  if (axeSource) {
    const violations = [];
    for (const [role, routes] of Object.entries(SCREENS)) {
      await setRole(role);
      for (const r of routes) {
        await page.goto(BASE + r);
        await ready();
        if (r === '#/water') await page.click('.tech summary');
        await page.addScriptTag({ content: axeSource });
        (await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
          .map((v) => `${v.id}(${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 2).join(', ')}`)))
          .forEach((v) => violations.push(`${role}${r} ${v}`));
      }
    }
    // Dialogs too
    await setRole('driver');
    await page.goto(BASE + '#/route');
    await ready();
    await page.click('#plant-btn');
    await page.addScriptTag({ content: axeSource });
    (await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => v.id))).forEach((v) => violations.push(`dialog ${v}`));
    await page.click('#confirm-cancel');
    check('10. axe-core: zero accessibility violations on all role screens + dialog', violations.length === 0, [...new Set(violations)].join('\n   '));
  }

  // ================= Scientific wording audit (all roles × languages) =================
  const DANGER = /\b(safe|unsafe|drinkable|bacteria-free|contaminated|potable)\b|safe to drink|contamination detected|pathogen detected|no e\. ?coli|sécuritaire|sans danger|contaminée/i;
  const ALLOWED = [/does not confirm contamination/i, /ne confirme pas une contamination/i];
  const hits = new Set();
  for (const lng of ['en', 'fr']) {
    await page.evaluate((l) => window.__imaq.session.setLang(l), lng);
    for (const [role, routes] of Object.entries(SCREENS)) {
      await setRole(role);
      for (const r of routes) {
        await page.goto(BASE + r);
        await ready();
        for (const line of (await bodyText()).split('\n')) if (DANGER.test(line) && !ALLOWED.some((a) => a.test(line))) hits.add(`${lng} ${role}${r}: ${line.trim()}`);
      }
    }
  }
  await page.evaluate(() => window.__imaq.session.setLang('en'));
  check('9. Wording audit: no safety/contamination claims anywhere', hits.size === 0, [...hits].join('\n   '));

  // ================= Hidden reset =================
  await page.goto(BASE + '?reset=1');
  await ready();
  check('Hidden ?reset=1 signs the device out to the welcome screen', (await visibleView()) === 'welcome');

  // Chrome logs every failed request as a console error. Two are deliberate in this test:
  // the wrong-PIN attempt (401) and requests made while the network is switched off.
  const EXPECTED = /Failed to load resource: (the server responded with a status of 401|net::ERR_INTERNET_DISCONNECTED)/;
  const unexpected = errors.filter((e) => !EXPECTED.test(e));
  console.log(`  (expected network logs from the deliberate wrong-PIN / offline steps: ${errors.length - unexpected.length})`);
  check('No unexpected console errors or warnings', unexpected.length === 0, unexpected.join(' | '));
} catch (e) {
  check('e2e script completed', false, e.stack);
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
