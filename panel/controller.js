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
const { INSTANCES_DIR, users, sessions, instances, SESSION_MAX_AGE_MS } = require('./lib/store');

const PORT = Number(process.env.CONTROLLER_PORT) || 8090;
const HOST = process.env.MEOWMARISM_HOST || '0.0.0.0';
const SECURE_COOKIE = process.env.MEOWMARISM_SECURE_COOKIES === '1';
const COOKIE = 'meow_pro_session';
const TYPES = ['VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'NEOFORGE', 'FORGE'];
const OWNER = { uid: os.userInfo().uid, gid: os.userInfo().gid };
const HOST_MEM_MB = Math.floor(os.totalmem() / 1024 / 1024);
const HOST_CPUS = os.cpus().length;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
};
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

const attempts = new Map();
function throttled(key) {
  const a = attempts.get(key);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
function failed(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 3) a.until = Date.now() + Math.min(15 * 60 * 1000, 5000 * 2 ** (a.n - 3));
  attempts.set(key, a);
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '0.0.0.0');
});

const findInstance = (id) => instances.list().find((i) => i.id === id);

// Files, mods and Modrinth for one instance, built on the shared modules from core.
const toolCache = new Map();
function toolsFor(inst) {
  let t = toolCache.get(inst.id);
  if (!t) {
    const kindDir = ['PAPER', 'PURPUR'].includes(inst.type) ? 'plugins' : 'mods';
    const modsDir = path.join(inst.dir, kindDir);
    const disabledDir = path.join(inst.dir, 'disabled_mods');
    t = {
      files: createFiles({ root: inst.dir }),
      access: createAccess({ dir: inst.dir, isRunning: () => runtimeFor(inst, OWNER).isRunning(), command: (text) => runtimeFor(inst, OWNER).command(text) }),
      props: createProperties({ file: path.join(inst.dir, 'server.properties'), isRunning: () => runtimeFor(inst, OWNER).isRunning(), command: (text) => runtimeFor(inst, OWNER).command(text) }),
      mods: createMods({ modsDir, disabledDir }),
      modrinth: createModrinth({ modsDir, disabledDir, oldDir: path.join(inst.dir, `${kindDir}-old`), datapackDir: path.join(inst.dir, 'world', 'datapacks'), mcVersion: inst.version, loader: inst.type.toLowerCase() }),
    };
    toolCache.set(inst.id, t);
  }
  return t;
}
const publicInstance = (i, st, stat) => ({
  id: i.id, name: i.name, type: i.type, version: i.version, port: i.port, memoryMB: i.memoryMB, cpus: i.cpus,
  state: st ? st.state : 'missing', health: st ? st.health : 'none',
  cpuUsage: stat ? stat.cpu : null, memUsage: stat ? stat.mem : null,
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

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (p === '/api/login' && method === 'POST') {
    const data = await readBody(req);
    const username = String(data.username || '').slice(0, 64);
    const key = `${req.socket.remoteAddress}|${username}`;
    const wait = throttled(key);
    if (wait) return json(res, 429, { error: `too many attempts, wait ${wait}s` });
    const user = users.verify(username, String(data.password || ''));
    if (!user) { failed(key); return json(res, 401, { error: 'wrong username or password' }); }
    attempts.delete(key);
    const token = sessions.create(user);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}${SECURE_COOKIE ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }

  const session = sessions.get(cookieToken(req));
  if (!session) return json(res, 401, { error: 'not authenticated' });

  if (p === '/api/logout' && method === 'POST') {
    sessions.destroy(cookieToken(req));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/system' && method === 'GET') {
    return json(res, 200, { user: session.username, docker: await docker.info(), hostMemMB: HOST_MEM_MB, hostCpus: HOST_CPUS, types: TYPES });
  }
  if (p === '/api/instances' && method === 'GET') {
    const withStats = url.searchParams.get('stats') === '1';
    return json(res, 200, instances.list().map((i) => publicInstance(i, stateCache.states[docker.containerName(i)], withStats ? stateCache.stats[docker.containerName(i)] : null)));
  }
  if (p === '/api/instances' && method === 'POST') {
    const { spec, error } = validateSpec(await readBody(req), null);
    if (error) return json(res, 400, { error });
    const list = instances.list();
    if (list.some((i) => i.name === spec.name)) return json(res, 409, { error: 'an instance with this name exists' });
    if (list.some((i) => i.port === spec.port) || !(await portFree(spec.port))) return json(res, 409, { error: `port ${spec.port} is in use` });
    const inst = { id: crypto.randomBytes(4).toString('hex'), ...spec, createdAt: Date.now() };
    inst.dir = path.join(INSTANCES_DIR, inst.name);
    fs.mkdirSync(inst.dir, { recursive: true });
    const rt = runtimeFor(inst, OWNER);
    try { await rt.createContainer(); await rt.startAsync(); } catch (err) {
      await rt.removeContainer();
      forgetRuntime(inst.id);
      return json(res, 500, { error: err.message });
    }
    list.push(inst);
    instances.save(list);
    backups.forInstance(inst, OWNER);
    return json(res, 201, { ok: true, id: inst.id });
  }

  const m = /^\/api\/instances\/([a-f0-9]{8})(?:\/([a-z-]+))?(?:\/([\w.-]+))?(?:\/(restore|run))?$/.exec(p);
  if (!m) return json(res, 404, { error: 'not found' });
  const inst = findInstance(m[1]);
  if (!inst) return json(res, 404, { error: 'unknown instance' });
  const action = m[2];
  const rt = runtimeFor(inst, OWNER);

  if (!action && method === 'DELETE') {
    const data = await readBody(req).catch(() => ({}));
    await rt.removeContainer();
    forgetRuntime(inst.id);
    backups.forget(inst.id);
    toolCache.delete(inst.id);
    instances.save(instances.list().filter((i) => i.id !== inst.id));
    if (data.deleteData === true && inst.dir.startsWith(INSTANCES_DIR + path.sep)) fs.rmSync(inst.dir, { recursive: true, force: true });
    return json(res, 200, { ok: true });
  }
  if (action === 'logs' && method === 'GET') {
    return json(res, 200, { logs: await rt.logs(Number(url.searchParams.get('tail')) || 300) });
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
    if (action === 'start') await rt.startAsync();
    else if (action === 'stop') await rt.stopAsync();
    else if (action === 'kill') await rt.killAsync();
    else { await rt.stopAsync(); await rt.startAsync(); }
    if (action !== 'stop' && action !== 'kill') toolsFor(inst).props.clearPending();
    return json(res, 200, { ok: true });
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
        let size = 0;
        const out = fs.createWriteStream(dest);
        req.on('data', (chunk) => { size += chunk.length; if (size > fl.MAX_UPLOAD_BYTES) { req.destroy(); out.destroy(); try { fs.unlinkSync(dest); } catch (_) {} } });
        req.on('error', () => { out.destroy(); try { fs.unlinkSync(dest); } catch (_) {} });
        req.pipe(out);
        out.on('finish', () => json(res, 200, { ok: true, name: url.searchParams.get('name'), sizeMB: +(size / 1024 / 1024).toFixed(2) }));
        out.on('error', (err) => json(res, 500, { ok: false, error: err.message }));
        return;
      }
      if (!m[3] && method === 'DELETE') { fl.remove(rel); return json(res, 200, { ok: true }); }
    } catch (err) { return bad(err instanceof SyntaxError ? Object.assign(err, { status: 400, message: 'bad json' }) : err); }
  }

  if (action === 'schedule') {
    const bad = (err) => json(res, 400, { ok: false, error: err.message });
    try {
      if (!m[3] && method === 'GET') return json(res, 200, schedule.list(inst));
      if (!m[3] && method === 'POST') { schedule.save(inst, await readBody(req)); return json(res, 200, { ok: true }); }
      if (m[3] && m[4] === 'run' && method === 'POST') return json(res, 200, { ok: true, result: schedule.run(inst, OWNER, m[3]) });
      if (m[3] && !m[4] && method === 'DELETE') { schedule.remove(inst, m[3]); return json(res, 200, { ok: true }); }
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
    if (name && method === 'DELETE') {
      if (!fs.existsSync(file)) return json(res, 404, { error: 'backup not found' });
      fs.unlinkSync(file);
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' });
      }
      return await handleApi(req, res, url);
    }
    const core = req.method === 'GET' && CORE_FILE.exec(url.pathname);
    if (core) {
      const file = path.join(__dirname, 'core', core[1]);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': CORE_TYPES[path.extname(file).slice(1)], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    const entry = STATIC[url.pathname];
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
setInterval(() => schedule.tick(OWNER), 20000).unref();
for (const inst of instances.list()) backups.forInstance(inst, OWNER);

server.listen(PORT, HOST, () => console.log(`meowmarism PROFESSIONAL listening on ${HOST}:${PORT}`));
