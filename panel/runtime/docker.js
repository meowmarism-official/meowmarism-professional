const { spawn } = require('child_process');

const IMAGE = 'itzg/minecraft-server';
const PREFIX = 'meow-';

function run(args, { input, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e.message) }); return; }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeout);
    p.stdout.on('data', (d) => { out += d; if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 1024 * 1024) err = err.slice(-512 * 1024); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e.message) }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: out, stderr: err }); });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

const containerName = (inst) => PREFIX + inst.id;

// Java image tag per Minecraft version.
function javaTag(version) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version));
  if (!m) return 'java21';
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3] || 0);
  if (major >= 26) return 'java25';
  if (minor > 20 || (minor === 20 && patch >= 5)) return 'java21';
  if (minor >= 17) return 'java17';
  return 'java8';
}

async function info() {
  const r = await run(['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || 'docker is not reachable').trim().split('\n')[0] };
  return { ok: true, version: r.stdout.trim() };
}

function createArgs(inst, owner) {
  const args = [
    'create', '--name', containerName(inst),
    '--label', 'meow.managed=1', '--label', `meow.id=${inst.id}`,
    '--restart', 'unless-stopped',
    '--memory', `${inst.memoryMB + 768}m`, '--memory-swap', `${inst.memoryMB + 768}m`,
    '--cpus', String(inst.cpus),
    '-p', `${inst.port}:25565`,
    '-e', 'EULA=TRUE', '-e', `TYPE=${inst.type}`, '-e', `VERSION=${inst.version}`,
    '-e', `MEMORY=${inst.memoryMB}m`, '-e', `UID=${owner.uid}`, '-e', `GID=${owner.gid}`,
    '-v', `${inst.dir}:/data`,
    `${IMAGE}:${javaTag(inst.version)}`,
  ];
  return args;
}

async function create(inst, owner) {
  const r = await run(createArgs(inst, owner), { timeout: 15 * 60 * 1000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'docker create failed');
}

async function start(inst) {
  const r = await run(['start', containerName(inst)]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'docker start failed');
}

async function stop(inst) {
  const r = await run(['stop', '--time', '120', containerName(inst)], { timeout: 150000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'docker stop failed');
}

async function kill(inst) {
  const r = await run(['kill', containerName(inst)]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'docker kill failed');
}

async function remove(inst) {
  await run(['rm', '-f', containerName(inst)]);
}

async function logs(inst, tail = 300) {
  const r = await run(['logs', '--tail', String(Math.max(1, Math.min(2000, tail))), containerName(inst)]);
  return (r.stdout + r.stderr).replace(/\[[0-9;]*m/g, '');
}

async function command(inst, cmd) {
  const r = await run(['exec', containerName(inst), 'rcon-cli', cmd], { timeout: 15000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'command failed');
  return r.stdout.trim();
}

// name -> { state, health } for every managed container
async function states() {
  const r = await run(['ps', '-a', '--filter', 'label=meow.managed=1', '--format', '{{.Names}}|{{.State}}|{{.Status}}']);
  const map = {};
  if (r.code !== 0) return map;
  for (const line of r.stdout.split('\n')) {
    const [name, state, status] = line.split('|');
    if (!name) continue;
    let health = 'none';
    if (/\(healthy\)/.test(status)) health = 'healthy';
    else if (/\(health: starting\)/.test(status)) health = 'starting';
    else if (/\(unhealthy\)/.test(status)) health = 'unhealthy';
    map[name] = { state, health };
  }
  return map;
}

function parseMemMB(text) {
  const m = /^\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(String(text || ''));
  if (!m) return null;
  const unit = { B: 1 / 1048576, KIB: 1 / 1024, MIB: 1, GIB: 1024, TIB: 1048576, KB: 1 / 1000, MB: 0.9537, GB: 953.7 }[m[2].toUpperCase()];
  return unit ? Number((Number(m[1]) * unit).toFixed(1)) : null;
}

async function stats() {
  const r = await run(['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', ...[]], { timeout: 20000 });
  const map = {};
  if (r.code !== 0) return map;
  for (const line of r.stdout.split('\n')) {
    const [name, cpu, mem] = line.split('|');
    if (!name || !name.startsWith(PREFIX)) continue;
    map[name] = { cpu: parseFloat(cpu) || 0, mem: mem || '', memMB: parseMemMB(mem) };
  }
  return map;
}

module.exports = { IMAGE, PREFIX, containerName, javaTag, info, create, start, stop, kill, remove, logs, command, states, stats };
