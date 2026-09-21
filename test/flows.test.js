const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('./helpers/harness');
const docker = require('../panel/runtime/docker');

const unix = { skip: process.platform === 'win32' ? 'needs symlinks' : false };
let h;
let owner;
let id;
const I = () => `/api/instances/${id}`;

test('the container gets hard limits, a port mapping and the data mount', () => {
  const args = docker.createArgs({ id: 'abcd1234', name: 'inst1', type: 'PAPER', version: '1.21.1', port: 25570, memoryMB: 2048, cpus: 1.5, dir: '/srv/inst1' }, { uid: 1000, gid: 1000 });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--memory'), '2816m');
  assert.equal(after('--memory-swap'), '2816m', 'no swap beyond the limit');
  assert.equal(after('--cpus'), '1.5');
  assert.equal(after('-p'), '25570:25565');
  assert.equal(after('-v'), '/srv/inst1:/data');
  assert.equal(after('--restart'), 'unless-stopped');
  assert.ok(args.includes('TYPE=PAPER') && args.includes('VERSION=1.21.1') && args.includes('MEMORY=2048m'));
  assert.ok(args.includes('UID=1000') && args.includes('GID=1000'));
  assert.match(args[args.length - 1], /^itzg\/minecraft-server:java\d+$/);
});

test('boot the panel', async () => {
  h = await harness.start();
  owner = (await h.login()).cookie;
  id = h.inst.id;
  const list = await h.json(owner, 'GET', '/api/instances');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});

test('login: remember me sets a 30 day cookie, otherwise a session cookie', async () => {
  const remembered = (await h.login('owner', 'ownerpass123', { remember: true })).setCookie;
  const session = (await h.login('owner', 'ownerpass123', { remember: false })).setCookie;
  assert.match(remembered, /Max-Age=2592000/);
  assert.doesNotMatch(session, /Max-Age/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /HttpOnly/);
});

test('permissions: a settings-only account cannot schedule power, console or backup actions', async () => {
  const made = await h.json(owner, 'POST', '/api/users', { username: 'setonly', password: 'setonlypass1', panel: {}, access: { global: [], instances: { inst1: ['view', 'settings'] } } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const member = (await h.login('setonly', 'setonlypass1')).cookie;
  const task = (type, extra = {}) => ({ name: 't', trigger: { type: 'interval', everyMinutes: 60 }, action: { type, ...extra }, enabled: true });
  for (const action of [task('command', { command: 'say hi' }), task('restart'), task('backup'), task('stop'), task('start')]) {
    assert.equal((await h.json(member, 'POST', `${I()}/schedule`, action)).status, 403, action.action.type);
  }
  assert.equal((await h.json(owner, 'GET', `${I()}/schedule`)).body.tasks.length, 0, 'the refused requests created nothing');
  const created = await h.json(owner, 'POST', `${I()}/schedule`, task('command', { command: 'say hi' }));
  assert.equal(created.status, 200);
  const [t] = (await h.json(owner, 'GET', `${I()}/schedule`)).body.tasks;
  assert.equal((await h.json(member, 'POST', `${I()}/schedule/${t.id}/run`)).status, 403);
  assert.equal((await h.json(member, 'DELETE', `${I()}/schedule/${t.id}`)).status, 403);
  assert.equal((await h.json(owner, 'GET', `${I()}/schedule`)).body.tasks.length, 1, 'the refused run and delete changed nothing');
  assert.equal((await h.json(owner, 'DELETE', `${I()}/schedule/${t.id}`)).status, 200);
});

test('permissions: a viewer cannot read logs, use the console or change settings', async () => {
  await h.json(owner, 'POST', '/api/users', { username: 'viewer', password: 'viewerpass123', panel: {}, access: { global: [], instances: { inst1: ['view'] } } });
  const viewer = (await h.login('viewer', 'viewerpass123')).cookie;
  assert.equal((await h.json(viewer, 'GET', `${I()}/logs`)).status, 403);
  assert.equal((await h.json(viewer, 'POST', `${I()}/command`, { command: 'stop' })).status, 403);
  assert.equal((await h.json(viewer, 'POST', `${I()}/start`)).status, 403);
  assert.equal((await h.json(viewer, 'POST', `${I()}/limits`, { memoryMB: 1024 })).status, 403);
  assert.equal((await h.json(viewer, 'GET', `${I()}/files?path=.`)).status, 403);
  assert.equal((await h.json(viewer, 'GET', '/api/instances')).status, 200);
});

test('files: paths and symlinks cannot leave the instance folder', unix, async () => {
  fs.writeFileSync(path.join(h.home, 'secret.txt'), 'top secret');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-pro-out-'));
  fs.symlinkSync(outside, path.join(h.dir, 'link'));
  const F = `${I()}/files`;
  for (const p of ['../../../secret.txt', '..', 'link/none.txt']) {
    const r = await h.json(owner, 'GET', `${F}/content?path=${encodeURIComponent(p)}`);
    assert.ok(r.status === 0 || r.status >= 400, `${p} returned ${r.status}`);
  }
  const w = await h.json(owner, 'POST', `${F}/save`, { path: 'link/new/file.txt', text: 'x' });
  assert.ok(w.status === 0 || w.status >= 400);
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('files: an upload replaces a file completely', async () => {
  fs.writeFileSync(path.join(h.dir, 'a.txt'), 'old');
  const r = await fetch(`${h.base}${I()}/files/upload?path=.&name=a.txt`, { method: 'POST', headers: { Cookie: owner }, body: 'new content' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(h.dir, 'a.txt'), 'utf8'), 'new content');
  assert.equal(fs.readdirSync(h.dir).filter((n) => n.endsWith('.part')).length, 0);
});

test('server icon: a 64x64 PNG is accepted, anything else is refused', async () => {
  const png = (w, hgt) => { const b = Buffer.alloc(40); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(hgt, 20); return b.toString('base64'); };
  assert.equal((await h.json(owner, 'POST', `${I()}/server-icon`, { png: png(32, 32) })).status, 400);
  assert.equal((await h.json(owner, 'POST', `${I()}/server-icon`, { png: 'garbage' })).status, 400);
  assert.equal((await h.json(owner, 'POST', `${I()}/server-icon`, { png: png(64, 64) })).status, 200);
  assert.ok(fs.existsSync(path.join(h.dir, 'server-icon.png')));
});

test('the audit log records who changed what', async () => {
  await h.json(owner, 'POST', `${I()}/backups/settings`, { backupIntervalHours: 8, maxBackups: 7, backupMinFreeGB: 2 });
  await new Promise((r) => setTimeout(r, 300));
  const ev = await h.json(owner, 'GET', `${I()}/events`);
  assert.equal(ev.status, 200);
  assert.ok(ev.body.audit.some((e) => e.user === 'owner' && /backups/i.test(e.title)), JSON.stringify(ev.body.audit));
});

test("changing a password ends that account's sessions", async () => {
  const victim = (await h.login('viewer', 'viewerpass123')).cookie;
  assert.equal((await h.json(victim, 'GET', '/api/instances')).status, 200);
  assert.equal((await h.json(owner, 'POST', '/api/users/viewer/password', { password: 'brandnewpass1' })).status, 200);
  assert.equal((await h.json(victim, 'GET', '/api/instances')).status, 401);
});

test('shut down', async () => { await h.stop(); });
