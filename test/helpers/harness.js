// Starts a real PRO controller with a temporary HOME and one instance record (no Docker needed for the panel itself).
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function start() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-pro-int-'));
  const port = await freePort();
  const dir = path.join(home, 'meowmarism-pro', 'instances', 'inst1');
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\nlevel-name=world\n');
  const inst = { id: 'abcd1234', name: 'inst1', type: 'VANILLA', version: '1.21.1', port: await freePort(), memoryMB: 1024, cpus: 1, dir, createdAt: 1 };
  fs.writeFileSync(path.join(home, '.meowmarism-pro-instances.json'), JSON.stringify([inst]));
  const { createUserStore } = require(path.join(REPO, 'panel', 'core', 'modules', 'users'));
  createUserStore(path.join(home, '.meowmarism-pro-users.json')).resetOwner('owner', 'ownerpass123');

  const child = spawn(process.execPath, [path.join(REPO, 'panel', 'controller.js')], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CONTROLLER_PORT: String(port) },
    cwd: path.join(REPO, 'panel'),
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/'); break; } catch (_) { await sleep(200); } }

  async function login(username = 'owner', password = 'ownerpass123', extra = {}) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, ...extra }) });
    if (!r.ok) throw new Error(`login failed for ${username}: ${r.status}`);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], setCookie: r.headers.get('set-cookie') || '' };
  }
  // A dropped connection counts as status 0 (the request was refused before it got an answer).
  const json = async (cookie, method, p, body) => {
    try {
      const r = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (_) { return { status: 0, body: {} }; }
  };
  const stop = async () => { child.kill(); await sleep(300); fs.rmSync(home, { recursive: true, force: true }); };
  return { home, base, inst, dir, login, json, stop };
}

module.exports = { start, sleep };
