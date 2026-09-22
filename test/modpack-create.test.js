// Creating an instance from a modpack against the real controller, with fake Modrinth and a fake docker CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../test-support/harness');
const docker = require('../panel/runtime/docker');

const HOOKS = path.join(__dirname, '..', 'test-support', 'modpack-hooks.js');
const opts = {};

async function withController(env, fn) {
  const h = await harness.start({ hooks: HOOKS, fakeDocker: true, env: { MEOW_EXPERIMENTAL_MODPACKS: '1', ...env } });
  try {
    const { cookie } = await h.login();
    const instancesRoot = path.join(h.home, 'meowmarism-pro', 'instances');
    const registry = () => JSON.parse(fs.readFileSync(path.join(h.home, '.meowmarism-pro-instances.json'), 'utf8'));
    const start = async (body) => {
      const r = await h.json(cookie, 'POST', '/api/instances', { name: 'packone', port: 25610, memoryMB: 3072, cpus: 2, ...body });
      return r;
    };
    const finish = () => h.until(async () => { const l = (await h.json(cookie, 'GET', '/api/create-log')).body; return l.done && l; }, 'the creation to finish', 30000);
    const create = async (body) => { const r = await start(body); assert.equal(r.status, 201, JSON.stringify(r.body)); return finish(); };
    const dirOf = (name) => path.join(instancesRoot, name);
    const createCalls = () => h.dockerCalls().filter((a) => a[0] === 'create');
    const containers = () => fs.existsSync(h.dockerDir) ? fs.readdirSync(h.dockerDir).filter((f) => f.endsWith('.json')) : [];
    const listed = async (name) => (await h.json(cookie, 'GET', '/api/instances')).body.some((i) => i.name === name);
    await fn({ h, cookie, create, start, finish, dirOf, createCalls, containers, listed, registry });
  } finally { await h.stop(); }
}
const nothingLeft = (dirOf, name) => {
  assert.ok(!fs.existsSync(dirOf(name)), 'no final folder');
  assert.ok(!fs.existsSync(`${dirOf(name)}.creating`), 'no staging folder');
};
const envOf = (args) => args.filter((a, i) => args[i - 1] === '-e');

test('the loader versions are pinned exactly for each pack type', opts, async () => {
  for (const [versionId, pins] of [['v1', ['TYPE=NEOFORGE', 'VERSION=1.21.1', 'NEOFORGE_VERSION=21.1.5']], ['vf', ['TYPE=FABRIC', 'VERSION=1.20.1', 'FABRIC_LOADER_VERSION=0.16.9']], ['vg', ['TYPE=FORGE', 'VERSION=1.20.1', 'FORGE_VERSION=47.4.0']]]) {
    await withController({}, async ({ create, createCalls, listed }) => {
      const log = await create({ modpack: { versionId } });
      assert.equal(log.error, null);
      assert.equal(log.phase, 'Ready');
      const args = createCalls()[0];
      const env = envOf(args);
      for (const pin of pins) assert.ok(env.includes(pin), `${pin} is set`);
      const others = env.filter((e) => /^(FABRIC_LOADER|FORGE|NEOFORGE)_VERSION=/.test(e));
      assert.equal(others.length, 1, 'exactly one loader pin');
      assert.ok(args.includes('25610:25565'), 'the wizard port is only the host side');
      assert.ok(env.includes('MEMORY=3072m'));
      assert.equal(args[args.indexOf('--cpus') + 1], '2');
      assert.ok(await listed('packone'));
    });
  }
});

test('a modpack instance is complete: files, metadata, registry entry and RAM', opts, async () => {
  await withController({}, async ({ create, dirOf, registry, containers }) => {
    const log = await create({ modpack: { versionId: 'v1' } });
    assert.equal(log.error, null);
    const dir = dirOf('packone');
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'a.jar'), 'utf8'), 'jar');
    assert.equal(fs.readFileSync(path.join(dir, 'config', 'a.cfg'), 'utf8'), 'x');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.meowmarism-modpack.json'), 'utf8'));
    assert.deepEqual([meta.source.type, meta.source.projectId, meta.source.versionId, meta.loader, meta.loaderVersion], ['modrinth-modpack', 'p1', 'v1', 'neoforge', '21.1.5']);
    assert.ok(!fs.existsSync(`${dir}.creating`));
    assert.deepEqual(fs.readFileSync(path.join(dir, 'server-icon.png')), fs.readFileSync(path.join(__dirname, '..', 'panel', 'core', 'brand', 'server-icon.png')), 'a pack without an icon gets the Meowmarism one');
    const entry = registry().find((i) => i.name === 'packone');
    assert.deepEqual([entry.type, entry.version, entry.loaderVersion, entry.memoryMB, entry.cpus, entry.port], ['NEOFORGE', '1.21.1', '21.1.5', 3072, 2, 25610]);
    assert.ok(!('source' in entry) && !('modpack' in entry) && !entry.creating, 'the pack source lives only in .meowmarism-modpack.json');
    assert.equal(containers().length, 1);
  });
});

test('a blank server does not get any loader pin', opts, async () => {
  await withController({}, async ({ create, createCalls }) => {
    const log = await create({ type: 'FABRIC', version: '1.21.1' });
    assert.equal(log.error, null);
    const env = envOf(createCalls()[0]);
    assert.ok(env.includes('TYPE=FABRIC') && env.includes('VERSION=1.21.1'));
    assert.deepEqual(env.filter((e) => /^(FABRIC_LOADER|FORGE|NEOFORGE)_VERSION=/.test(e)), []);
  });
});

test('a Quilt pack is refused before anything exists', opts, async () => {
  await withController({}, async ({ create, dirOf, createCalls, containers, listed }) => {
    const log = await create({ modpack: { versionId: 'vq' } });
    assert.match(log.error, /Quilt.*PRO cannot run/i);
    nothingLeft(dirOf, 'packone');
    assert.equal(createCalls().length, 0);
    assert.deepEqual(containers(), []);
    assert.ok(!(await listed('packone')));
  });
});

test('a modpack file failing to download leaves no container, folder or registry entry', opts, async () => {
  await withController({ MEOW_TEST_FAIL: 'file' }, async ({ create, dirOf, createCalls, containers, listed }) => {
    const log = await create({ modpack: { versionId: 'v1' } });
    assert.match(log.error, /mod download failed/);
    nothingLeft(dirOf, 'packone');
    assert.equal(createCalls().length, 0, 'no container was created');
    assert.deepEqual(containers(), []);
    assert.ok(!(await listed('packone')));
  });
});

test('the final rename failing leaves nothing behind', opts, async () => {
  await withController({ MEOW_TEST_FAIL: 'rename' }, async ({ create, dirOf, createCalls, listed }) => {
    const log = await create({ modpack: { versionId: 'v1' } });
    assert.match(log.error, /rename failed/);
    nothingLeft(dirOf, 'packone');
    assert.equal(createCalls().length, 0);
    assert.ok(!(await listed('packone')));
  });
});

for (const [fail, reason] of [['create', /fake create failure/], ['start', /fake start failure/], ['exited', /stopped while starting/]]) {
  test(`docker ${fail} failing rolls everything back`, opts, async () => {
    await withController({ FAKE_DOCKER_FAIL: fail }, async ({ create, dirOf, containers, listed, registry }) => {
      const log = await create({ modpack: { versionId: 'v1' } });
      assert.match(log.error, /Installation completed, but the server could not start./);
      assert.doesNotMatch(log.error, /broken|faulty/i, 'the pack is not blamed');
      assert.ok(log.lines.some((l) => reason.test(l)), 'the reason is in the log');
      nothingLeft(dirOf, 'packone');
      assert.deepEqual(containers(), [], 'the container is removed');
      assert.ok(!(await listed('packone')));
      assert.ok(!registry().some((i) => i.name === 'packone'));
    });
  });
}

test('a pack\'s own server.properties and icon are kept; the port inside the container stays 25565', opts, async () => {
  await withController({}, async ({ create, dirOf, createCalls }) => {
    const log = await create({ modpack: { versionId: 'vp' }, port: 25580 });
    assert.equal(log.error, null);
    const props = fs.readFileSync(path.join(dirOf('packone'), 'server.properties'), 'utf8');
    assert.match(props, /^motd=from the pack$/m);
    assert.match(props, /^max-players=7$/m);
    assert.match(props, /^server-port=25565$/m, 'the pack\'s 1111 is replaced by the container port');
    assert.equal(fs.readFileSync(path.join(dirOf('packone'), 'server-icon.png'), 'utf8'), 'pack-icon-bytes');
    assert.ok(createCalls()[0].includes('25580:25565'));
  });
});

test('the instance only shows up after it is up: staging first, no container before the files are in', opts, async () => {
  await withController({}, async ({ h, start, finish, dirOf, createCalls, containers, listed }) => {
    const hold = path.join(h.home, '.hold-create');
    fs.writeFileSync(hold, '');
    const r = await start({ modpack: { versionId: 'v1' } });
    assert.equal(r.status, 201);
    await h.until(() => fs.existsSync(`${dirOf('packone')}.creating`), 'the staging folder');
    assert.ok(!fs.existsSync(dirOf('packone')), 'no final folder yet');
    assert.ok(!(await listed('packone')), 'not listed while installing');
    assert.equal(createCalls().length, 0, 'no container yet');
    assert.deepEqual(containers(), []);
    fs.rmSync(hold);
    const log = await finish();
    assert.equal(log.error, null);
    assert.ok(await listed('packone'));
    assert.ok(!fs.existsSync(`${dirOf('packone')}.creating`));
  });
});

test('the container exists but the instance is not listed until it is healthy', opts, async () => {
  await withController({}, async ({ h, start, finish, containers, listed }) => {
    fs.mkdirSync(h.dockerDir, { recursive: true });
    fs.writeFileSync(path.join(h.dockerDir, '.hold-start'), '');
    await start({ modpack: { versionId: 'v1' } });
    await h.until(() => containers().length === 1, 'the container to be created');
    assert.ok(!(await listed('packone')), 'not listed before the server is up');
    fs.rmSync(path.join(h.dockerDir, '.hold-start'));
    assert.equal((await finish()).error, null);
    assert.ok(await listed('packone'));
  });
});

test('modpack requests are refused when the feature is off', opts, async () => {
  const h = await harness.start({ hooks: HOOKS, fakeDocker: true });
  try {
    const { cookie } = await h.login();
    const r = await h.json(cookie, 'POST', '/api/instances', { name: 'packone', port: 25610, memoryMB: 2048, cpus: 1, modpack: { versionId: 'v1' } });
    assert.equal(r.status, 400);
  } finally { await h.stop(); }
});

test('createArgs pins exactly one loader variable, and only when a loader version is known', () => {
  const owner = { uid: 1000, gid: 1000 };
  const args = (over) => docker.createArgs({ id: 'abcd1234', name: 'x', type: 'FABRIC', version: '1.21.1', port: 25565, memoryMB: 1024, cpus: 1, dir: '/tmp/x', ...over }, owner);
  const pins = (a) => a.filter((v, i) => a[i - 1] === '-e' && /^(FABRIC_LOADER|FORGE|NEOFORGE)_VERSION=/.test(v));
  assert.deepEqual(pins(args({ type: 'FABRIC', loaderVersion: '0.16.5' })), ['FABRIC_LOADER_VERSION=0.16.5']);
  assert.deepEqual(pins(args({ type: 'FORGE', loaderVersion: '47.4.0' })), ['FORGE_VERSION=47.4.0']);
  assert.deepEqual(pins(args({ type: 'NEOFORGE', loaderVersion: '21.1.251' })), ['NEOFORGE_VERSION=21.1.251']);
  assert.deepEqual(pins(args({ type: 'FABRIC' })), [], 'a blank server has no pin');
  assert.deepEqual(pins(args({ type: 'PAPER', loaderVersion: '1.2' })), [], 'types without a loader version variable get none');
});
