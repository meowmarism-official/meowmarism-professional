// Loads the real instance page in a browser and looks for script errors and pages that render nothing.
// Skipped when puppeteer-core or Chrome is missing (npm ci --prefix test/browser installs the first, CI has the second).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
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

test('nothing went wrong in the browser', opts, async () => {
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('shut down', async () => {
  if (browser) await browser.close();
  if (h) await h.stop();
});
