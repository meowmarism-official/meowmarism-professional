// meowmarism PROFESSIONAL controller: one Docker container per Minecraft instance.
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const docker = require('./lib/docker');
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
  '/core/tokens/tokens.css': ['core/tokens/tokens.css', 'text/css; charset=utf-8'],
  '/core/brand/logo.svg': ['core/brand/logo.svg', 'image/svg+xml'],
};

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16 * 1024) { reject(new Error('body too large')); req.destroy(); } });
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
    const [st, stats] = await Promise.all([docker.states(), url.searchParams.get('stats') === '1' ? docker.stats() : {}]);
    return json(res, 200, instances.list().map((i) => publicInstance(i, st[docker.containerName(i)], stats[docker.containerName(i)])));
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
    try { await docker.create(inst, OWNER); await docker.start(inst); } catch (err) {
      await docker.remove(inst);
      return json(res, 500, { error: err.message });
    }
    list.push(inst);
    instances.save(list);
    return json(res, 201, { ok: true, id: inst.id });
  }

  const m = /^\/api\/instances\/([a-f0-9]{8})(?:\/([a-z-]+))?$/.exec(p);
  if (!m) return json(res, 404, { error: 'not found' });
  const inst = findInstance(m[1]);
  if (!inst) return json(res, 404, { error: 'unknown instance' });
  const action = m[2];

  if (!action && method === 'DELETE') {
    const data = await readBody(req).catch(() => ({}));
    await docker.remove(inst);
    instances.save(instances.list().filter((i) => i.id !== inst.id));
    if (data.deleteData === true && inst.dir.startsWith(INSTANCES_DIR + path.sep)) fs.rmSync(inst.dir, { recursive: true, force: true });
    return json(res, 200, { ok: true });
  }
  if (action === 'logs' && method === 'GET') {
    return json(res, 200, { logs: await docker.logs(inst, Number(url.searchParams.get('tail')) || 300) });
  }
  if (action === 'command' && method === 'POST') {
    const data = await readBody(req);
    const cmd = String(data.command || '').trim();
    if (!cmd || cmd.length > 500) return json(res, 400, { error: 'empty or too long command' });
    return json(res, 200, { output: await docker.command(inst, cmd) });
  }
  if (action === 'limits' && method === 'POST') {
    const { spec, error } = validateSpec({ ...inst, ...(await readBody(req)) }, inst);
    if (error) return json(res, 400, { error });
    if (spec.port !== inst.port && (instances.list().some((i) => i.port === spec.port) || !(await portFree(spec.port)))) return json(res, 409, { error: `port ${spec.port} is in use` });
    const st = (await docker.states())[docker.containerName(inst)];
    const wasRunning = st && st.state === 'running';
    if (wasRunning) await docker.stop(inst);
    await docker.remove(inst);
    Object.assign(inst, { port: spec.port, memoryMB: spec.memoryMB, cpus: spec.cpus });
    await docker.create(inst, OWNER);
    if (wasRunning) await docker.start(inst);
    instances.save(instances.list().map((i) => (i.id === inst.id ? inst : i)));
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && ['start', 'stop', 'restart', 'kill'].includes(action)) {
    if (action === 'start') await docker.start(inst);
    else if (action === 'stop') await docker.stop(inst);
    else if (action === 'kill') await docker.kill(inst);
    else { await docker.stop(inst); await docker.start(inst); }
    return json(res, 200, { ok: true });
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

server.listen(PORT, HOST, () => console.log(`meowmarism PROFESSIONAL listening on ${HOST}:${PORT}`));
