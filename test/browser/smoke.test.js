// Loads the real instance page in a browser and looks for script errors and pages that render nothing.
// Skipped when puppeteer-core or Chrome is missing (npm ci --prefix test/browser installs the first, CI has the second).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../../test-support/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) {}
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .find((p) => p && fs.existsSync(p));
const opts = { skip: puppeteer && CHROME ? false : 'needs puppeteer-core (npm ci --prefix test/browser) and Chrome' };

let h;
let browser;
let page;
const problems = [];
const waitFor = (fn, arg) => page.waitForFunction(fn, { timeout: 15000 }, arg);
const text = (selector) => page.$eval(selector, (el) => el.textContent.trim());

test('open the instance page in a browser', opts, async () => {
  h = await harness.start();
  const { cookie } = await h.login();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 900 });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 404/.test(msg.text())) problems.push(`console: ${msg.text()}`); });
  page.on('response', (res) => { if (res.status() === 404) problems.push(`404: ${res.url()}`); });
  page.on('dialog', (dialog) => { problems.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });
  const [name, value] = cookie.split('=');
  await page.setCookie({ name, value, url: h.base });
  await page.goto(`${h.base}/instance/${h.inst.id}/overview`, { waitUntil: 'networkidle2' });
  await waitFor(() => document.getElementById('page-overview').classList.contains('active'));
  assert.ok(await page.$eval('#shellSidebar', (el) => el.getBoundingClientRect().width > 30), 'the sidebar is visible');
});

test('the Overview and Performance pages are built by the shared component', opts, async () => {
  await waitFor(() => (document.getElementById('statusState') || {}).textContent.trim() !== '-');
  assert.ok(await page.$('#overviewCpu'), 'status strip has the CPU cell');
  await page.click('[data-page="performance"]');
  await waitFor(() => document.getElementById('page-performance').classList.contains('active'));
  assert.ok(await page.$('#perfCpu') && await page.$('#perfRam'), 'CPU and RAM cards exist');
  assert.equal(await page.$('#perfDisk'), null, 'no Disk card without disk data');
  assert.ok(await page.$('#perfRoot canvas, #perfRoot .card'), 'the history chart is mounted');
});

test('navigating between pages works', opts, async () => {
  for (const id of ['players', 'console', 'overview']) {
    await page.click(`[data-page="${id}"]`);
    await waitFor((x) => document.getElementById(`page-${x}`).classList.contains('active'), id);
  }
});

test('the Update page shows the panel version and the core version', opts, async () => {
  await page.goto(`${h.base}/update`, { waitUntil: 'networkidle2' });
  const core = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'panel', 'core', 'core.json'), 'utf8'));
  await waitFor((expected) => (document.getElementById('upd-core') || {}).textContent === expected, `v${core.version}`);
  assert.match(await text('#upd-current'), /^v\d/);
  assert.equal(await text('#upd-core-commit'), `commit ${core.commit.slice(0, 8)}`);
});

test('nothing went wrong in the browser', opts, async () => {
  assert.deepEqual(problems, [], problems.join('\n'));
});

// A separate, self-contained instance: the installed product is already the latest, but a newer compatible
// core exists. The UI must still say "update available" and show the core as the thing that changed.
test('a core-only update is offered when only the core is behind, even though the product is current', opts, async () => {
  const HOOKS = path.join(__dirname, '..', '..', 'test-support', 'modpack-hooks.js');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  const core = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'panel', 'core', 'core.json'), 'utf8'));
  const update = { releaseTag: `v${pkgVersion}`, publishedAt: '2026-01-01T00:00:00Z', core: { version: '9.9.9', commit: 'f'.repeat(40) }, branchProductVersion: pkgVersion };
  const h2 = await harness.start({ hooks: HOOKS, env: { MEOW_TEST_UPDATE: JSON.stringify(update) } });
  const { cookie } = await h2.login();
  const b2 = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const p2 = await b2.newPage();
    const [name, value] = cookie.split('=');
    await p2.setCookie({ name, value, url: h2.base });
    await p2.goto(`${h2.base}/update`, { waitUntil: 'networkidle2' });
    const esc = pkgVersion.replace(/\./g, '\\.');
    await p2.waitForFunction((v) => new RegExp(`^v${v}`).test((document.getElementById('upd-current') || {}).textContent || ''), { timeout: 15000 }, esc);
    assert.match(await p2.$eval('#upd-current', (el) => el.textContent), new RegExp(`^v${esc}`), 'the product itself is already current');
    const diffs = await p2.$eval('#upd-diffs', (el) => el.textContent);
    assert.match(diffs, /9\.9\.9/, 'the update page names the newer core version');
    assert.match(diffs, new RegExp(core.version.replace(/\./g, '\\.')), 'and the currently installed core version');
    assert.equal(await p2.$eval('#upd-uptodate', (el) => el.style.display), 'none');
    assert.equal(await p2.$eval('#upd-now', (el) => el.style.display), '', 'the single Update now button is offered');
  } finally {
    await b2.close();
    await h2.stop();
  }
});

test('shut down', async () => {
  if (browser) await browser.close();
  if (h) await h.stop();
});
