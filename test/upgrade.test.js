const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The upgrade module keeps its records under HOME, so HOME is set before it is loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-pro-upg-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { createUpgrades } = require('../panel/lib/upgrade');
const { createBackups } = require('../panel/core/modules/backup');

const unix = { skip: process.platform === 'win32' ? 'needs GNU tar' : false };
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (p) => fs.readFileSync(p, 'utf8');
const finished = async (upgrades, inst) => {
  for (let i = 0; i < 200; i++) { const s = upgrades.status(inst); if (s.done && !s.running) return s; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('the job did not finish');
};

// One instance with a real world folder and real backups, and a fake container runtime that records what it is asked to do.
function setup({ running = false, backupDisk = 0, recreateFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(home, 'inst-'));
  write(path.join(dir, 'world', 'level.dat'), 'level v1');
  write(path.join(dir, 'server.properties'), 'level-name=world\n');
  const inst = { id: 'abcd1234', name: `inst-${path.basename(dir)}`, type: 'PAPER', version: '1.21.1', dir };
  const api = createBackups({ SERVER_DIR: dir, WORLD_DIR: path.join(dir, 'world'), BACKUP_DIR: path.join(dir, '.backups'), panelConfig: { backupMinFreeGB: backupDisk } });
  const note = [];
  const backupDeps = { broadcast: () => {}, broadcastEvent: () => {}, pushTimeline: () => {}, runtime: { isReady: () => false, isRunning: () => false, command: () => {}, stopAndWait: async () => {} } };
  const state = { running, saved: [], recreated: [] };
  const upgrades = createUpgrades({
    listVersions: async () => ['1.21.4', '1.21.3', '1.21.1', '1.20.4'],
    save: (i) => state.saved.push(i.version),
    isRunning: () => state.running,
    backups: () => ({ api, deps: backupDeps }),
    recreate: async (i, wasRunning) => {
      state.recreated.push([i.version, wasRunning]);
      if (recreateFails && i.version !== '1.21.1') throw new Error('container did not become healthy');
    },
  });
  return { dir, inst, api, upgrades, state, note };
}

test('a version that is not offered is refused', async () => {
  const s = setup();
  await assert.rejects(s.upgrades.upgrade(s.inst, '9.9.9', false), /not available/);
  await assert.rejects(s.upgrades.upgrade(s.inst, '1.21.1', false), /already the installed version/);
  await assert.rejects(s.upgrades.upgrade(s.inst, 'latest', false), /pick a Minecraft version/);
  assert.equal(s.state.recreated.length, 0);
});

test('going back to an older version needs an explicit confirmation', async () => {
  const s = setup();
  await assert.rejects(s.upgrades.upgrade(s.inst, '1.20.4', false), /older Minecraft version/);
  assert.equal(s.inst.version, '1.21.1');
  assert.equal(s.state.recreated.length, 0);
});

test('a successful upgrade backs up first and recreates the container on the new version', unix, async () => {
  const s = setup();
  await s.upgrades.upgrade(s.inst, '1.21.4', false);
  const status = await finished(s.upgrades, s.inst);
  assert.equal(status.error, null, status.error);
  assert.equal(s.inst.version, '1.21.4');
  assert.deepEqual(s.state.recreated, [['1.21.4', false]]);
  assert.equal(s.api.listBackups().length, 1, 'a world backup was taken');
  assert.equal(status.latest.from, '1.21.1');
  assert.equal(status.latest.to, '1.21.4');
  assert.equal(status.latest.rolledBack, false);
});

test('a server that was running is running again afterwards', unix, async () => {
  const s = setup({ running: true });
  await s.upgrades.upgrade(s.inst, '1.21.3', false);
  await finished(s.upgrades, s.inst);
  assert.deepEqual(s.state.recreated, [['1.21.3', true]]);
});

test('a failing backup stops the upgrade before anything changes', unix, async () => {
  const s = setup({ backupDisk: 999999 });
  await s.upgrades.upgrade(s.inst, '1.21.4', false);
  const status = await finished(s.upgrades, s.inst);
  assert.match(status.error, /backup failed, nothing was changed/);
  assert.equal(s.inst.version, '1.21.1');
  assert.equal(s.state.recreated.length, 0);
  assert.equal(s.state.saved.length, 0);
});

test('a new version that does not start is rolled back automatically', unix, async () => {
  const s = setup({ recreateFails: true, running: true });
  await s.upgrades.upgrade(s.inst, '1.21.4', false);
  const status = await finished(s.upgrades, s.inst);
  assert.match(status.error, /Minecraft 1\.21\.1 was restored/);
  assert.equal(s.inst.version, '1.21.1', 'the instance is back on the old version');
  assert.deepEqual(s.state.recreated, [['1.21.4', true], ['1.21.1', true]], 'the old container is started again because the server was running');
  assert.equal(status.latest.rolledBack, true);
  assert.equal(status.latest.failed, true);
});

test('a second upgrade while one is running is refused with 409', unix, async () => {
  const s = setup();
  s.state.recreate = null;
  await s.upgrades.upgrade(s.inst, '1.21.3', false);
  await assert.rejects(s.upgrades.upgrade(s.inst, '1.21.4', false), (err) => err.status === 409);
  await finished(s.upgrades, s.inst);
});

test('rollback without the world keeps the world, with the world restores it', unix, async () => {
  const s = setup({ running: true });
  await s.upgrades.upgrade(s.inst, '1.21.4', false);
  await finished(s.upgrades, s.inst);
  write(path.join(s.dir, 'world', 'level.dat'), 'played after the upgrade');

  await s.upgrades.rollback(s.inst, false);
  let status = await finished(s.upgrades, s.inst);
  assert.equal(status.error, null, status.error);
  assert.equal(s.inst.version, '1.21.1');
  assert.equal(read(path.join(s.dir, 'world', 'level.dat')), 'played after the upgrade', 'the world was not touched');
  await assert.rejects(s.upgrades.rollback(s.inst, false), /nothing to roll back/, 'a rollback cannot be done twice');

  await s.upgrades.upgrade(s.inst, '1.21.3', false);
  await finished(s.upgrades, s.inst);
  write(path.join(s.dir, 'world', 'level.dat'), 'damaged');
  await s.upgrades.rollback(s.inst, true);
  status = await finished(s.upgrades, s.inst);
  assert.equal(status.error, null, status.error);
  assert.equal(read(path.join(s.dir, 'world', 'level.dat')), 'played after the upgrade', 'the world from right before the upgrade is back');
  assert.equal(s.inst.version, '1.21.1');
});

test('a stopped server stays stopped after a rollback', unix, async () => {
  const s = setup({ running: false });
  await s.upgrades.upgrade(s.inst, '1.21.4', false);
  await finished(s.upgrades, s.inst);
  s.state.recreated.length = 0;
  await s.upgrades.rollback(s.inst, false);
  await finished(s.upgrades, s.inst);
  assert.deepEqual(s.state.recreated, [['1.21.1', false]]);
});
