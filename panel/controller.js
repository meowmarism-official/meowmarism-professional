// meowmarism PROFESSIONAL controller: one Docker container per Minecraft instance.
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { docker, stateCache, refreshStates, startPolling, runtimeFor, forget: forgetRuntime } = require('./runtime');
const backups = require('./lib/backups');
const schedule = require('./lib/schedule');
const { createModrinth, fetchImage } = require('./core/modules/modrinth');
const { createMods } = require('./core/modules/mods');
const { createFiles } = require('./core/modules/files');
const { createProperties } = require('./core/modules/properties');
const { createAccess } = require('./core/modules/access');
const { createUsersApi } = require('./core/modules/users-api');
const { createUpdater } = require('./core/modules/updater');
const { createPanelSettings } = require('./core/modules/panel-settings');
const { effectiveCaps, hasPanelCap } = require('./core/modules/users');
const systemInfo = require('./core/modules/system-info');
const events = require('./lib/events');
const { createServerIcon } = require('./core/modules/server-icon');
const startup = require('./lib/startup');
const schedulerCore = require('./core/modules/scheduler');
const { createUpgrades, listVersions, removeRecord } = require('./lib/upgrade');
const { createMetrics } = require('./core/modules/metrics');
const { createPlayerTracker, buildPlayerCommand, playerName } = require('./core/modules/players');
const { HOME, DATA_DIR, INSTANCES_DIR, users, sessions, instances, SESSION_MAX_AGE_MS } = require('./lib/store');

const PORT = Number(process.env.CONTROLLER_PORT) || 8090;
const HOST = process.env.MEOWMARISM_HOST || '0.0.0.0';
const SECURE_COOKIE = process.env.MEOWMARISM_SECURE_COOKIES === '1';
const updater = createUpdater({ repo: 'meowmarism-official/meowmarism-professional', panelDir: __dirname, statePrefix: '.meowmarism-pro', probePath: '/' });
try { updater.bootCheck(); } catch (_) {}
const panelSettings = createPanelSettings({ file: path.join(HOME, '.meowmarism-pro-settings.json') });
const { clientIp, isHttps } = panelSettings;
const COOKIE = 'meow_pro_session';
const TYPES = ['VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'NEOFORGE', 'FORGE'];
const OWNER = { uid: os.userInfo().uid, gid: os.userInfo().gid };
const HOST_MEM_MB = Math.floor(os.totalmem() / 1024 / 1024);
const HOST_CPUS = os.cpus().length;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
};
const PANEL_PAGES = ['/server', '/users', '/settings', '/system', '/update'];
const CORE_FILE = /^\/core\/(tokens\/tokens\.css|brand\/[\w.-]+\.(?:svg|png)|ui\/[\w.-]+\.(?:js|css))$/;
const CORE_TYPES = { css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', js: 'application/javascript; charset=utf-8' };

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function cookieToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

const loginLimiter = require('./core/modules/ratelimit').createLoginLimiter();

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '0.0.0.0');
});

const findInstance = (id) => instances.list().find((i) => i.id === id);

// Files, mods and Modrinth for one instance, built on the shared modules from core.
const toolCache = new Map();
const playersFile = (inst) => path.join(DATA_DIR, 'players', `${inst.name}.json`);
function loadPlayers(inst) {
  const tracker = createPlayerTracker({
    onJoin: (name) => events.add(inst.name, 'events', { type: 'join', title: `${name} joined`, severity: 'good' }),
    onLeave: (name, ms) => events.add(inst.name, 'events', { type: 'leave', title: `${name} left`, detail: `${Math.max(1, Math.round((ms || 0) / 60000))} min played` }),
  });
  try { tracker.restore(JSON.parse(fs.readFileSync(playersFile(inst), 'utf8'))); } catch (_) {}
  return tracker;
}
function savePlayers(inst, tracker) {
  try {
    fs.mkdirSync(path.dirname(playersFile(inst)), { recursive: true });
    fs.writeFileSync(playersFile(inst), JSON.stringify(tracker.snapshot()));
  } catch (_) {}
}
function toolsFor(inst) {
  let t = toolCache.get(inst.id);
  if (!t) {
    const kindDir = ['PAPER', 'PURPUR'].includes(inst.type) ? 'plugins' : 'mods';
    const modsDir = path.join(inst.dir, kindDir);
    const disabledDir = path.join(inst.dir, 'disabled_mods');
    t = {
      files: createFiles({ root: inst.dir }),
      players: loadPlayers(inst),
      metrics: createMetrics({ keys: ['cpu', 'memMB', 'players'], file: path.join(DATA_DIR, 'metrics', `${inst.name}.json`) }),
      access: createAccess({ dir: inst.dir, isRunning: () => runtimeFor(inst, OWNER).isRunning(), command: (text) => runtimeFor(inst, OWNER).command(text) }),
      props: createProperties({ file: path.join(inst.dir, 'server.properties'), isRunning: () => runtimeFor(inst, OWNER).isRunning(), command: (text) => runtimeFor(inst, OWNER).command(text) }),
      mods: createMods({ modsDir, disabledDir }),
      modrinth: createModrinth({ modsDir, disabledDir, oldDir: path.join(inst.dir, `${kindDir}-old`), datapackDir: path.join(inst.dir, 'world', 'datapacks'), mcVersion: inst.version, loader: inst.type.toLowerCase() }),
    };
    toolCache.set(inst.id, t);
  }
  return t;
}
const startupInfo = (i) => startup.info(docker.containerName(i));
const publicInstance = (i, st, stat, caps) => ({
  caps, id: i.id, name: i.name, type: i.type, version: i.version, port: i.port, memoryMB: i.memoryMB, cpus: i.cpus,
  state: st ? st.state : 'missing', health: st ? st.health : 'none',
  cpuUsage: stat ? stat.cpu : null, memUsage: stat ? stat.mem : null,
  startedAt: stat ? stat.startedAt || null : null, ...startupInfo(i),
});

function validateSpec(data, current) {
  const spec = {
    name: current ? current.name : String(data.name || '').trim(),
    type: current ? current.type : String(data.type || '').toUpperCase(),
    version: current ? current.version : String(data.version || '').trim(),
    port: Number(data.port),
    memoryMB: Math.round(Number(data.memoryMB)),
    cpus: Math.round(Number(data.cpus) * 100) / 100,
  };
  if (!current) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(spec.name)) return { error: 'name: 1-32 letters, digits, - or _' };
    if (!TYPES.includes(spec.type)) return { error: 'unknown server type' };
    if (!/^\d+\.\d+(\.\d+)?$/.test(spec.version)) return { error: 'version must look like 1.21.1' };
  }
  if (!Number.isInteger(spec.port) || spec.port < 1024 || spec.port > 65535) return { error: 'port must be 1024-65535' };
  if (!Number.isFinite(spec.memoryMB) || spec.memoryMB < 512 || spec.memoryMB > HOST_MEM_MB) return { error: `memory must be 512-${HOST_MEM_MB} MB` };
  if (!Number.isFinite(spec.cpus) || spec.cpus < 0.25 || spec.cpus > HOST_CPUS) return { error: `CPUs must be 0.25-${HOST_CPUS}` };
  return { spec };
}

const AUDIT_TITLES = {
  start: 'Started the server', stop: 'Stopped the server', restart: 'Restarted the server', kill: 'Killed the server', command: 'Ran a console command',
  settings: 'Changed server settings', limits: 'Changed resource limits', upgrade: 'Changed the Minecraft version', backups: 'Changed backups',
  files: 'Changed files', mods: 'Changed mods', modrinth: 'Changed mods', access: 'Changed access lists', schedule: 'Changed the scheduler', players: 'Managed a player',
};
const ACTION_CAP = {
  logs: 'console', command: 'console', players: 'console', access: 'console',
  start: 'power', stop: 'power', restart: 'power', kill: 'power',
  files: 'files', mods: 'mods', modrinth: 'mods', backups: 'backups',
  events: 'settings', 'server-icon': 'settings', settings: 'settings', schedule: 'settings', limits: 'settings', upgrade: 'settings', metrics: 'view',
};
const usersApi = createUsersApi({ store: users.store, session: (req) => sessions.get(cookieToken(req)), revokeSessions: (u) => sessions.destroyUser(u) });

const upgrades = createUpgrades({
  save: (inst) => instances.save(instances.list().map((i) => (i.id === inst.id ? inst : i))),
  isRunning: (inst) => runtimeFor(inst, OWNER).isRunning(),
  backups: (inst) => backups.forInstance(inst, OWNER),
  async recreate(inst, wasRunning) {
    await refreshStates();
    const old = runtimeFor(inst, OWNER);
    if (old.isRunning()) await old.stopAsync();
    await old.removeContainer();
    forgetRuntime(inst.id);
    const fresh = runtimeFor(inst, OWNER);
    await fresh.createContainer();
    if (wasRunning) await fresh.startAsync();
  },
});

// Creating a container can take minutes on the first run (image download), so it runs in the background with a log.
let createJob = null;
let creatingNow = false;
function createInstanceInBackground(inst) {
  const job = { lines: [], progress: 5, done: false, error: null, name: inst.name };
  createJob = job;
  const log = (line) => job.lines.push(line);
  (async () => {
    const rt = runtimeFor(inst, OWNER);
    log('Creating the container (the first start downloads the Docker image)');
    await rt.removeContainer();
    await rt.createContainer();
    job.progress = 30;
    log('Starting the server');
    await rt.startAsync();
    job.progress = 45;
    backups.forInstance(inst, OWNER);
    const seen = new Set();
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!instances.list().some((i) => i.id === inst.id)) throw new Error('the instance was removed');
      await refreshStates();
      const st = stateCache.states[docker.containerName(inst)];
      const text = await rt.logs(30).catch(() => '');
      for (const l of text.split(String.fromCharCode(10))) if (l.trim() && !seen.has(l)) { seen.add(l); log(l); }
      job.progress = Math.min(95, 45 + seen.size);
      if (st && st.state === 'running' && st.health === 'healthy') return;
      if (st && (st.state === 'exited' || st.state === 'dead')) throw new Error('the server stopped while starting, see the log');
    }
    throw new Error('the server did not become ready in time');
  })().then(() => {
    job.progress = 100; job.done = true;
    instances.save(instances.list().map((i) => { if (i.id === inst.id) delete i.creating; return i; }));
  })
    .catch(async (err) => {
      job.error = err.message || 'creation failed'; job.done = true;
      const rt = runtimeFor(inst, OWNER);
      await rt.removeContainer().catch(() => {});
      forgetRuntime(inst.id);
      instances.save(instances.list().filter((i) => i.id !== inst.id));
      fs.rmSync(inst.dir, { recursive: true, force: true });
    });
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (p === '/api/login' && method === 'POST') {
    const data = await readBody(req);
    const username = String(data.username || '').slice(0, 64);
    const ip = clientIp(req);
    const gate = loginLimiter.check(ip, username);
    if (!gate.allowed) return json(res, 429, { error: `too many attempts, wait ${gate.retryAfterSec}s` });
    const user = users.verify(username, String(data.password || ''));
    if (!user) { loginLimiter.fail(ip, username); return json(res, 401, { error: 'wrong username or password' }); }
    loginLimiter.success(ip, username);
    const token = sessions.create(user);
    const maxAge = data.remember ? `; Max-Age=${SESSION_MAX_AGE_MS / 1000}` : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${maxAge}${SECURE_COOKIE || isHttps(req) ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }

  const session = sessions.get(cookieToken(req));
  if (!session) return json(res, 401, { error: 'not authenticated' });

  if (p === '/api/logout' && method === 'POST') {
    sessions.destroy(cookieToken(req));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true });
  }
  const me = users.store.findUser(session.username);
  if (!me) return json(res, 401, { error: 'not authenticated' });
  if (usersApi.handle(req, res, url)) return;
  if ((p === '/api/version') && method === 'GET') {
    return json(res, 200, { ...(await updater.versionInfo(url.searchParams.get('refresh') === '1')), canUpdate: hasPanelCap(me, 'update'), running: [] });
  }
  if (p === '/api/update-status' && method === 'GET') return json(res, 200, updater.status());
  if (p === '/api/update' && method === 'POST') {
    if (!hasPanelCap(me, 'update')) return json(res, 403, { error: 'not allowed to update' });
    if (!updater.start()) return json(res, 409, { error: 'an update is already running' });
    return json(res, 202, { ok: true });
  }
  if (p === '/api/panel-settings') {
    if (!hasPanelCap(me, 'users')) return json(res, 403, { error: 'not allowed to change settings' });
    if (method === 'GET') return json(res, 200, panelSettings.load());
    if (method === 'POST') {
      const data = await readBody(req);
      const next = panelSettings.load();
      if (typeof data.trustProxy === 'boolean') next.trustProxy = data.trustProxy;
      panelSettings.save(next);
      return json(res, 200, panelSettings.load());
    }
  }
  if (p === '/api/system-info' && method === 'GET') {
    if (!hasPanelCap(me, 'users')) return json(res, 403, { error: 'not allowed' });
    const d = await docker.info();
    return json(res, 200, systemInfo.collect({ dir: DATA_DIR, extra: { docker: d.ok ? `${d.version || 'running'}` : `not reachable` } }));
  }
  if (p === '/api/system' && method === 'GET') {
    return json(res, 200, { user: session.username, role: me.role, panel: { users: hasPanelCap(me, 'users'), create: hasPanelCap(me, 'create'), update: hasPanelCap(me, 'update') }, docker: await docker.info(), hostMemMB: HOST_MEM_MB, hostCpus: HOST_CPUS, types: TYPES });
  }
  if (p === '/api/instances' && method === 'GET') {
    const withStats = url.searchParams.get('stats') === '1';
    return json(res, 200, instances.list().filter((i) => effectiveCaps(me, i.name).includes('view')).map((i) => publicInstance(i, stateCache.states[docker.containerName(i)], withStats ? stateCache.stats[docker.containerName(i)] : null, effectiveCaps(me, i.name))));
  }
  if (p === '/api/create-log' && method === 'GET') {
    if (!hasPanelCap(me, 'create')) return json(res, 403, { error: 'not allowed' });
    return json(res, 200, createJob || { lines: [], progress: 0, done: true, error: null, name: null });
  }
  if (p === '/api/instances' && method === 'POST') {
    if (!hasPanelCap(me, 'create')) return json(res, 403, { error: 'not allowed to create instances' });
    if (creatingNow || (createJob && !createJob.done)) return json(res, 409, { error: 'another instance is being created' });
    creatingNow = true;
    try {
    const body = await readBody(req);
    const { spec, error } = validateSpec(body, null);
    if (error) return json(res, 400, { error });
    const list = instances.list();
    if (list.some((i) => i.name === spec.name)) return json(res, 409, { error: 'an instance with this name exists' });
    if (list.some((i) => i.port === spec.port) || !(await portFree(spec.port))) return json(res, 409, { error: `port ${spec.port} is in use` });
    const inst = { id: crypto.randomBytes(4).toString('hex'), ...spec, createdAt: Date.now(), creating: true };
    inst.dir = path.join(INSTANCES_DIR, inst.name);
    const hours = Number(body.backupIntervalHours), keep = Number(body.maxBackups);
    if (Number.isFinite(hours) && hours >= 0.25 && hours <= 168 && Number.isInteger(keep) && keep >= 1 && keep <= 100) inst.backup = { backupIntervalHours: hours, maxBackups: keep };
    fs.mkdirSync(inst.dir, { recursive: true });
    list.push(inst);
    instances.save(list);
    createInstanceInBackground(inst);
    return json(res, 201, { ok: true, id: inst.id, name: inst.name });
    } finally { creatingNow = false; }
  }

  const m = /^\/api\/instances\/([a-f0-9]{8})(?:\/([a-z-]+))?(?:\/([\w.-]+))?(?:\/(restore|run))?$/.exec(p);
  if (!m) return json(res, 404, { error: 'not found' });
  const inst = findInstance(m[1]);
  if (!inst) return json(res, 404, { error: 'unknown instance' });
  const action = m[2];
  const caps = effectiveCaps(me, inst.name);
  const need = action ? (ACTION_CAP[action] || 'remove') : (method === 'DELETE' ? 'remove' : 'view');
  if (!caps.includes('view') || !caps.includes(need)) return json(res, 403, { error: 'not allowed' });
  const rt = runtimeFor(inst, OWNER);
  if (method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode >= 300 || !findInstance(inst.id)) return;
      const title = AUDIT_TITLES[action] || 'Changed the instance';
      events.add(inst.name, 'audit', { type: action || 'instance', title, detail: [m[3], m[4]].filter(Boolean).join(' / '), user: me.username });
    });
  }
  if (action === 'events' && method === 'GET') return json(res, 200, events.list(inst.name));
  if (action === 'server-icon') {
    const icon = createServerIcon({ dir: inst.dir, defaultIcon: path.join(__dirname, 'core', 'brand', 'server-icon.png') });
    if (method === 'GET') {
      if (!icon.exists()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return fs.createReadStream(icon.file).pipe(res);
    }
    if (method === 'POST') {
      try { icon.apply(await readBody(req, 512 * 1024)); return json(res, 200, { ok: true }); } catch (err) { return json(res, 400, { ok: false, error: err.message || 'invalid image' }); }
    }
  }

  if (!action && method === 'DELETE') {
    const data = await readBody(req).catch(() => ({}));
    await rt.removeContainer();
    forgetRuntime(inst.id);
    backups.forget(inst.id);
    toolCache.delete(inst.id);
    instances.save(instances.list().filter((i) => i.id !== inst.id));
    if (data.deleteData === true && inst.dir.startsWith(INSTANCES_DIR + path.sep)) {
      fs.rmSync(inst.dir, { recursive: true, force: true });
      fs.rmSync(path.join(DATA_DIR, 'metrics', `${inst.name}.json`), { force: true });
      events.forget(inst.name);
      fs.rmSync(playersFile(inst), { force: true });
      removeRecord(inst);
    }
    return json(res, 200, { ok: true });
  }
  if (action === 'logs' && method === 'GET') {
    const noise = /RCON (Listener|Client)/;
    const logs = (await rt.logs(Number(url.searchParams.get('tail')) || 300)).split(String.fromCharCode(10)).filter((line) => !noise.test(line)).join(String.fromCharCode(10));
    return json(res, 200, { logs });
  }
  if (action === 'command' && method === 'POST') {
    const data = await readBody(req);
    const cmd = String(data.command || '').trim();
    if (!cmd || cmd.length > 500) return json(res, 400, { error: 'empty or too long command' });
    return json(res, 200, { output: await rt.commandAsync(cmd) });
  }
  if (action === 'limits' && method === 'POST') {
    const { spec, error } = validateSpec({ ...inst, ...(await readBody(req)) }, inst);
    if (error) return json(res, 400, { error });
    if (spec.port !== inst.port && (instances.list().some((i) => i.port === spec.port) || !(await portFree(spec.port)))) return json(res, 409, { error: `port ${spec.port} is in use` });
    await refreshStates();
    const wasRunning = rt.isRunning();
    if (wasRunning) await rt.stopAsync();
    await rt.removeContainer();
    Object.assign(inst, { port: spec.port, memoryMB: spec.memoryMB, cpus: spec.cpus });
    instances.save(instances.list().map((i) => (i.id === inst.id ? inst : i)));
    forgetRuntime(inst.id);
    const fresh = runtimeFor(inst, OWNER);
    await fresh.createContainer();
    if (wasRunning) await fresh.startAsync();
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && ['start', 'stop', 'restart', 'kill'].includes(action)) {
    if (upgrades.isBusy(inst)) return json(res, 409, { error: 'an upgrade is running' });
    if (action === 'start' || action === 'restart') {
      await refreshStates();
      if (!stateCache.states[docker.containerName(inst)]) await rt.createContainer();
    }
    if (action === 'start') await rt.startAsync();
    else if (action === 'stop') await rt.stopAsync();
    else if (action === 'kill') await rt.killAsync();
    else { if (rt.isRunning()) await rt.stopAsync(); await rt.startAsync(); }
    if (action !== 'stop' && action !== 'kill') toolsFor(inst).props.clearPending();
    return json(res, 200, { ok: true });
  }

  if (action === 'upgrade') {
    if (method === 'GET') {
      const versions = await listVersions(inst.type).catch(() => []);
      return json(res, 200, { ...upgrades.status(inst), versions });
    }
    if (method === 'POST') {
      const data = await readBody(req);
      try {
        if (m[3] === 'rollback') await upgrades.rollback(inst, data.restoreWorld === true);
        else await upgrades.upgrade(inst, String(data.version || ''), data.allowDowngrade === true);
        return json(res, 202, { ok: true });
      } catch (err) { return json(res, err.status || 400, { ok: false, error: err.message }); }
    }
  }

  if (action === 'metrics' && method === 'GET') {
    const range = Math.min(Math.max(Number(url.searchParams.get('range')) || 300000, 60000), 7 * 86400000);
    return json(res, 200, { points: toolsFor(inst).metrics.series(range), limits: { cpu: inst.cpus * 100, memMB: inst.memoryMB + 768 } });
  }

  if (action === 'players') {
    const pl = toolsFor(inst).players;
    if (!m[3] && method === 'GET') return json(res, 200, pl.stats(Number(toolsFor(inst).props.read()['max-players']) || 20));
    if (m[3] === 'detail' && method === 'GET') {
      try { return json(res, 200, pl.detail(url.searchParams.get('name'))); } catch (err) { return json(res, 400, { error: err.message }); }
    }
    if (m[3] === 'action' && method === 'POST') {
      const data = await readBody(req);
      try {
        const name = playerName(data.player);
        if (!pl.players.has(name)) return json(res, 409, { ok: false, error: 'player is no longer online' });
        if (!rt.isRunning()) return json(res, 409, { ok: false, error: 'server is not running' });
        await rt.commandAsync(buildPlayerCommand(String(data.action || ''), name, data.value, data.reason));
        return json(res, 200, { ok: true });
      } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
    }
  }

  if (action === 'access') {
    const ac = toolsFor(inst).access;
    if (method === 'GET') return json(res, 200, ac.list());
    if (method === 'POST') {
      const data = await readBody(req);
      try { ac.act(data.list, data.action, data.name, data.reason); return json(res, 200, { ok: true }); } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
    }
  }

  if (action === 'settings') {
    const pr = toolsFor(inst).props;
    if (method === 'GET') return json(res, 200, pr.state());
    if (method === 'POST') {
      const data = await readBody(req);
      try { return json(res, 200, { ok: true, settings: pr.apply(data.settings) }); } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
    }
  }

  if (action === 'mods') {
    const tl = toolsFor(inst);
    if (!m[3] && method === 'GET') return json(res, 200, tl.mods.list());
    if (m[3] === 'toggle' && method === 'POST') {
      const data = await readBody(req);
      try { tl.mods.toggle(data.name, !!data.enable); } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      return json(res, 200, { ok: true });
    }
  }

  if (action === 'modrinth') {
    const mr = toolsFor(inst).modrinth;
    const fail = (err) => json(res, 502, { ok: false, error: err.message || 'Modrinth request failed' });
    const sp = url.searchParams;
    try {
      if (m[3] === 'info' && method === 'GET') {
        return json(res, 200, { supported: mr.supported(), kinds: { mod: mr.supported('mod'), datapack: mr.supported('datapack'), resourcepack: mr.supported('resourcepack'), shader: mr.supported('shader'), modpack: mr.supported('modpack') }, loader: inst.type.toLowerCase(), mcVersion: inst.version, kind: mr.type });
      }
      if (m[3] === 'search' && method === 'GET') return json(res, 200, await mr.search(sp.get('q') || '', sp.get('offset'), sp.get('sort'), sp.get('kind')));
      if (m[3] === 'project' && method === 'GET') return json(res, 200, await mr.project(String(sp.get('id') || '')));
      if (m[3] === 'versions' && method === 'GET') return json(res, 200, { versions: await mr.projectVersions(String(sp.get('project') || ''), sp.get('kind')) });
      if (m[3] === 'updates' && method === 'GET') return json(res, 200, await mr.updates());
      if (m[3] === 'img' && method === 'GET') {
        try {
          const { type, buf } = await fetchImage(String(sp.get('u') || ''));
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Length': buf.length });
          return res.end(buf);
        } catch (_) { res.writeHead(404); return res.end(); }
      }
      if ((m[3] === 'install' || m[3] === 'update') && method === 'POST') {
        const data = await readBody(req);
        const installed = m[3] === 'install'
          ? await mr.install(String(data.projectId || ''), data.versionId ? String(data.versionId) : null, data.kind ? String(data.kind) : null)
          : await mr.applyUpdates(data.all ? 'all' : (Array.isArray(data.files) ? data.files.map(String) : []));
        return json(res, 200, { ok: true, installed });
      }
    } catch (err) { return fail(err); }
  }

  if (action === 'files') {
    const fl = toolsFor(inst).files;
    const rel = url.searchParams.get('path') || '.';
    const bad = (err) => json(res, err.status || 500, { ok: false, error: err.message });
    try {
      if (!m[3] && method === 'GET') return json(res, 200, fl.list(rel));
      if (m[3] === 'content' && method === 'GET') return json(res, 200, fl.read(rel));
      if (m[3] === 'download' && method === 'GET') {
        const info = fl.fileInfo(rel);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${info.name.replace(/[\r\n"]/g, '_')}"`, 'Content-Length': info.size });
        return fs.createReadStream(info.resolved).pipe(res);
      }
      if (m[3] === 'save' && method === 'POST') {
        const data = await readBody(req, fl.MAX_EDIT_BYTES * 2);
        return json(res, 200, { ok: true, ...fl.write(String(data.path || ''), data.text, { expectedMtime: Number(data.mtime) }) });
      }
      if (m[3] === 'upload' && method === 'POST') {
        const dest = fl.uploadTarget(rel, url.searchParams.get('name') || '');
        fl.receiveUpload(req, dest, (err, size) => {
          if (err) return json(res, err.status || 500, { ok: false, error: err.message });
          json(res, 200, { ok: true, name: url.searchParams.get('name'), sizeMB: +(size / 1024 / 1024).toFixed(2) });
        });
        return;
      }
      if (!m[3] && method === 'DELETE') { fl.remove(rel); return json(res, 200, { ok: true }); }
    } catch (err) { return bad(err instanceof SyntaxError ? Object.assign(err, { status: 400, message: 'bad json' }) : err); }
  }

  if (action === 'schedule') {
    const bad = (err) => json(res, 400, { ok: false, error: err.message });
    try {
      if (!m[3] && method === 'GET') return json(res, 200, schedule.list(inst));
      const denied = (type) => {
        const need = schedulerCore.ACTION_CAP[type];
        if (need && caps.includes(need)) return false;
        json(res, 403, { ok: false, error: `missing permission: ${need || 'unknown action'}` });
        return true;
      };
      const stored = (id) => (inst.schedule || []).find((t) => t.id === id);
      if (!m[3] && method === 'POST') {
        const body = await readBody(req);
        const old = body.id && stored(body.id);
        if (denied(body.action && body.action.type) || (old && denied(old.action.type))) return;
        schedule.save(inst, body);
        return json(res, 200, { ok: true });
      }
      if (m[3] && (m[4] === 'run' || !m[4]) && (method === 'POST' || method === 'DELETE')) {
        const task = stored(m[3]);
        if (!task) throw new Error('task not found');
        if (denied(task.action.type)) return;
        if (method === 'DELETE') { schedule.remove(inst, m[3]); return json(res, 200, { ok: true }); }
        if (m[4] === 'run') return json(res, 200, { ok: true, result: schedule.run(inst, OWNER, m[3]) });
      }
    } catch (err) { return bad(err); }
  }

  if (action === 'backups') {
    const b = backups.forInstance(inst, OWNER);
    const name = m[3];
    if (!name && method === 'GET') {
      return json(res, 200, { backups: b.api.listBackups(), ...b.api.state, settings: b.settings, log: b.log.slice(-20) });
    }
    if (!name && method === 'POST') {
      if (b.api.state.backupInProgress) return json(res, 409, { error: 'a backup is already running' });
      b.api.createBackup('manual', b.deps).catch(() => {});
      return json(res, 202, { ok: true });
    }
    if (name === 'settings' && method === 'POST') {
      const data = await readBody(req);
      const max = Math.round(Number(data.maxBackups)), hours = Number(data.backupIntervalHours), free = Number(data.backupMinFreeGB);
      if (!(max >= 1 && max <= 100)) return json(res, 400, { error: 'keep 1-100 backups' });
      if (!(hours >= 0.25 && hours <= 168)) return json(res, 400, { error: 'interval must be 0.25-168 hours' });
      if (!(free >= 0 && free <= 1000)) return json(res, 400, { error: 'free space must be 0-1000 GB' });
      Object.assign(b.settings, { maxBackups: max, backupIntervalHours: hours, backupMinFreeGB: free });
      instances.save(instances.list().map((i) => (i.id === inst.id ? { ...i, backup: { ...b.settings } } : i)));
      b.api.rescheduleAutoBackup(b.deps);
      return json(res, 200, { ok: true });
    }
    if (name && !b.api.BACKUP_NAME_RE.test(name)) return json(res, 400, { error: 'invalid backup name' });
    const file = name && path.join(b.backupDir, name);
    if (name && m[4] === 'restore' && method === 'POST') {
      if (!fs.existsSync(file)) return json(res, 404, { error: 'backup not found' });
      if (b.api.state.backupInProgress) return json(res, 409, { error: 'a backup is running' });
      try { await b.api.restoreBackup(name, b.deps); } catch (err) { return json(res, 500, { error: err.message }); }
      return json(res, 200, { ok: true });
    }
    if (name && !m[4] && method === 'GET') {
      if (!fs.existsSync(file)) return json(res, 404, { error: 'backup not found' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': fs.statSync(file).size });
      return fs.createReadStream(file).pipe(res);
    }
    if (name && method === 'DELETE') {
      if (!fs.existsSync(file)) return json(res, 404, { error: 'backup not found' });
      fs.unlinkSync(file);
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); res.end('bad request'); return; }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' });
      }
      return await handleApi(req, res, url);
    }
    const lang = req.method === 'GET' && /^\/lang\/(de|fr|es)\.json$/.exec(url.pathname);
    if (lang) {
      const read = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, dir, `${lang[1]}.json`), 'utf8')); } catch (_) { return { dict: {}, patterns: [] }; } };
      const base = read('core/lang'), own = read('lang');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ dict: { ...base.dict, ...own.dict }, patterns: [...(base.patterns || []), ...(own.patterns || [])] }));
    }
    if (req.method === 'GET' && url.pathname === '/i18n.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'core', 'ui', 'i18n.js')));
    }
    const core = req.method === 'GET' && CORE_FILE.exec(url.pathname);
    if (core) {
      const file = path.join(__dirname, 'core', core[1]);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': CORE_TYPES[path.extname(file).slice(1)], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && /^\/instance\/[a-f0-9]{8}(\/[a-z]*)?\/?$/.test(url.pathname)) {
      if (!sessions.get(cookieToken(req))) { res.writeHead(302, { Location: '/' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'instance.html')));
    }
    let entry = STATIC[url.pathname] || (PANEL_PAGES.includes(url.pathname) ? STATIC['/'] : null);
    if (entry && !sessions.get(cookieToken(req))) entry = ['login.html', 'text/html; charset=utf-8'];
    if (req.method === 'GET' && entry) {
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, entry[0])));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message || 'internal error' });
    else res.end();
  }
});

startPolling();
// A creation that was interrupted by a restart of the panel is resumed.
for (const inst of instances.list()) if (inst.creating && !createJob) createInstanceInBackground(inst);
setInterval(() => schedule.tick(OWNER), 20000).unref();
for (const inst of instances.list()) backups.forInstance(inst, OWNER);

// Online players come from the game's own `list` output.
async function pollPlayers() {
  for (const inst of instances.list()) {
    const tracker = toolsFor(inst).players;
    const rt = runtimeFor(inst, OWNER);
    if (!rt.isReady()) { tracker.reset(); continue; }
    try {
      const out = await rt.commandAsync('list');
      for (const line of String(out).replace(/§./g, '').split('\n')) tracker.parseLine(line);
    } catch (_) {}
  }
}
setInterval(pollPlayers, 10000).unref();

const lastState = new Map();
const lastReady = new Map();
function trackLifecycle() {
  for (const inst of instances.list()) {
    const st = stateCache.states[docker.containerName(inst)];
    const now = st ? st.state : 'missing';
    const before = lastState.get(inst.id);
    lastState.set(inst.id, now);
    const info = startup.info(docker.containerName(inst));
    if (info.readyAt && lastReady.get(inst.id) !== info.readyAt) {
      lastReady.set(inst.id, info.readyAt);
      if (info.startupMs != null) events.add(inst.name, 'events', { type: 'ready', title: 'Server ready', detail: `Startup ${(info.startupMs / 1000).toFixed(1)}s`, severity: 'good' });
    }
    if (!before || before === now) continue;
    if (now === 'running') events.add(inst.name, 'events', { type: 'start', title: 'Server started', severity: 'good' });
    else if (before === 'running' && (now === 'exited' || now === 'dead')) {
      const planned = events.recent(inst.name, 'audit', ['stop', 'restart', 'kill', 'upgrade', 'limits'], 90000);
      events.add(inst.name, 'events', planned ? { type: 'stop', title: 'Server stopped' } : { type: 'crash', title: 'Server stopped unexpectedly', severity: 'error' });
    }
  }
}

function sampleMetrics() {
  trackLifecycle();
  for (const inst of instances.list()) {
    const st = stateCache.states[docker.containerName(inst)];
    if (!st || st.state !== 'running') continue;
    const stat = stateCache.stats[docker.containerName(inst)];
    if (!stat || !Number.isFinite(stat.cpu) || !Number.isFinite(stat.memMB)) continue;
    const tl = toolsFor(inst);
    tl.metrics.add({ cpu: stat.cpu, memMB: stat.memMB, players: tl.players.players.size });
  }
}
function saveMetrics() {
  for (const inst of instances.list()) {
    const tl = toolsFor(inst);
    tl.metrics.save();
    savePlayers(inst, tl.players);
  }
}
setInterval(sampleMetrics, 5000).unref();
setInterval(saveMetrics, 60000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveMetrics(); process.exit(0); });

server.listen(PORT, HOST, () => { console.log(`meowmarism PROFESSIONAL listening on ${HOST}:${PORT}`); updater.confirmHealthy(); });
