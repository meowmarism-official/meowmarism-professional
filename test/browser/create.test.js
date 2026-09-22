// The create dialog in a real browser with fake Modrinth and a fake docker CLI: from the source choice through the phases to Ready.
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
const HOOKS = path.join(__dirname, '..', '..', 'test-support', 'modpack-hooks.js');

let h, browser, page, problems;
const waitFor = (fn, arg) => page.waitForFunction(fn, { timeout: 20000 }, arg);
const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());

async function open(env) {
  h = await harness.start({ hooks: HOOKS, fakeDocker: true, env });
  const { cookie } = await h.login();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 900 });
  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 404/.test(msg.text())) problems.push(`console: ${msg.text()}`); });
  page.on('response', (res) => { if (res.status() === 404) problems.push(`404: ${res.url()}`); });
  page.on('dialog', (dialog) => { problems.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });
  const [name, value] = cookie.split('=');
  await page.setCookie({ name, value, url: h.base });
  await page.goto(`${h.base}/server`, { waitUntil: 'networkidle2' });
  await waitFor(() => document.getElementById('newBtn'));
  await page.click('#newBtn');
}
async function close() {
  if (browser) await browser.close();
  if (h) await h.stop();
  browser = h = null;
}

test('the dialog starts at the source choice and the blank server flow is intact', opts, async () => {
  await open({});
  await waitFor(() => document.querySelector('#w-source .source-card'));
  assert.ok(await page.$eval('#step1', (el) => el.style.display !== 'none'));
  await page.click('#w-next1');
  assert.ok(await page.$eval('#step2', (el) => el.style.display !== 'none'), 'Blank server is the default and leads to the blank step');
  await page.click('#w-back2');
  assert.ok(await page.$eval('#step1', (el) => el.style.display !== 'none'));
  assert.deepEqual(problems, []);
  await close();
});

test('creating from a modpack: search, pick, memory, phases, Ready, open the instance', opts, async () => {
  await open({});
  const hold = path.join(h.home, '.hold-create');
  fs.writeFileSync(hold, '');
  const instancesRoot = path.join(h.home, 'meowmarism-pro', 'instances');
  const cookieHeader = async () => (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const listed = async () => (await (await fetch(`${h.base}/api/instances`, { headers: { Cookie: await cookieHeader() } })).json()).map((i) => i.name);

  await waitFor(() => document.querySelector('#w-source .source-card'));
  await page.click('[data-mode="modpack"]');
  await page.click('#w-next1');
  await waitFor(() => document.querySelectorAll('.mp-card').length === 2);
  await page.click('.mp-card[data-id="pq"]');
  await waitFor(() => document.querySelector('.mp-summary'));
  assert.match(await text('#mp-version'), /Quilt.*not supported here/);
  await page.click('.mp-back');
  await page.click('.mp-card[data-id="p1"]');
  await waitFor(() => document.querySelector('#mp-ram'));
  await page.$eval('#mp-ram', (el) => { el.value = '4096'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#mp-name', (el) => { el.value = 'e2epack'; });
  await page.click('#w-next3');
  await waitFor(() => document.getElementById('step4').style.display !== 'none');
  assert.equal(await page.$eval('#w-mem', (el) => el.value), '4096', 'the chosen memory reaches the resources step');
  await page.$eval('#w-port', (el) => { el.value = '25620'; });
  await page.click('#w-next4');
  await waitFor(() => document.getElementById('step5').style.display !== 'none');
  await page.click('#w-create');

  await waitFor(() => document.getElementById('step6').style.display !== 'none');
  await waitFor(() => document.getElementById('creatingHint').textContent.includes('Downloading modpack files'));
  assert.ok(!(await listed()).includes('e2epack'), 'not listed while installing');
  assert.ok(!fs.existsSync(path.join(instancesRoot, 'e2epack')), 'no final folder while installing');
  assert.ok(fs.existsSync(path.join(instancesRoot, 'e2epack.creating')), 'work happens in the staging folder');
  assert.equal(h.dockerCalls().filter((a) => a[0] === 'create').length, 0, 'no container before the files are in');

  fs.rmSync(hold);
  await waitFor(() => document.getElementById('creatingTitle').textContent.includes('is ready'));
  assert.ok((await listed()).includes('e2epack'));
  assert.ok(!fs.existsSync(path.join(instancesRoot, 'e2epack.creating')));
  const args = h.dockerCalls().find((a) => a[0] === 'create');
  const env = args.filter((a, i) => args[i - 1] === '-e');
  assert.ok(env.includes('NEOFORGE_VERSION=21.1.5') && env.includes('MEMORY=4096m') && env.includes('TYPE=NEOFORGE') && env.includes('VERSION=1.21.1'));
  assert.ok(args.includes('25620:25565'));
  const entry = JSON.parse(fs.readFileSync(path.join(h.home, '.meowmarism-pro-instances.json'), 'utf8')).find((i) => i.name === 'e2epack');
  assert.deepEqual([entry.memoryMB, entry.type, entry.version, entry.loaderVersion, entry.port], [4096, 'NEOFORGE', '1.21.1', '21.1.5', 25620]);

  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#creatingOpen')]);
  await waitFor(() => document.getElementById('page-overview').classList.contains('active'));
  assert.ok(await page.$eval('#shellSidebar', (el) => el.getBoundingClientRect().width > 30), 'the new instance page renders');
  assert.deepEqual(problems, []);
  await close();
});
