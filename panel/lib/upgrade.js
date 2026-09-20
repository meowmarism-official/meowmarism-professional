// Minecraft version upgrade and rollback: back up the world, recreate the container on the new version.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const MOJANG = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const SOURCES = {
  PAPER: 'https://api.papermc.io/v2/projects/paper',
  PURPUR: 'https://api.purpurmc.org/v2/purpur',
  FABRIC: 'https://meta.fabricmc.net/v2/versions/game',
};
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const cache = new Map();

const parts = (v) => v.split('.').map(Number);
function compare(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'meowmarism-professional' } });
  if (!r.ok) throw new Error(`version list request failed (${r.status})`);
  return r.json();
}

async function listVersions(type) {
  const hit = cache.get(type);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  let list;
  if (type === 'PAPER' || type === 'PURPUR') list = (await getJson(SOURCES[type])).versions;
  else if (type === 'FABRIC') list = (await getJson(SOURCES.FABRIC)).filter((v) => v.stable).map((v) => v.version);
  else list = (await getJson(MOJANG)).versions.filter((v) => v.type === 'release').map((v) => v.id);
  list = [...new Set(list.filter((v) => VERSION_RE.test(v)))].sort((a, b) => compare(b, a));
  cache.set(type, { at: Date.now(), list });
  return list;
}

const recordFile = (inst) => path.join(DATA_DIR, 'upgrades', `${inst.name}.json`);
function readRecord(inst) {
  try { return JSON.parse(fs.readFileSync(recordFile(inst), 'utf8')); } catch (_) { return null; }
}
function writeRecord(inst, rec) {
  fs.mkdirSync(path.dirname(recordFile(inst)), { recursive: true });
  fs.writeFileSync(recordFile(inst), JSON.stringify(rec, null, 2));
}
const removeRecord = (inst) => fs.rmSync(recordFile(inst), { force: true });

// deps: { save(inst), recreate(inst, wasRunning), backups(inst) -> { api, deps }, isRunning(inst), stop(inst) }
function createUpgrades(deps) {
  const jobs = new Map();

  function start(inst, kind, work) {
    const cur = jobs.get(inst.id);
    if (cur && cur.running) throw Object.assign(new Error('an upgrade is already running for this instance'), { status: 409 });
    const job = { running: true, done: false, error: null, lines: [], kind };
    jobs.set(inst.id, job);
    const log = (line) => job.lines.push(line);
    work(log)
      .then(() => log('done'))
      .catch((err) => { job.error = err.message; log(`failed: ${err.message}`); })
      .finally(() => { job.running = false; job.done = true; });
  }

  async function newestBackup(b) {
    const list = b.api.listBackups();
    return list.length ? list.sort((a, c) => c.createdAt - a.createdAt)[0].name : null;
  }

  async function upgrade(inst, version, allowDowngrade) {
    if (!VERSION_RE.test(version)) throw new Error('pick a Minecraft version');
    if (version === inst.version) throw new Error('that is already the installed version');
    if (compare(version, inst.version) < 0 && !allowDowngrade) throw new Error('going to an older Minecraft version can damage the world, confirm it explicitly');
    const versions = await listVersions(inst.type);
    if (!versions.includes(version)) throw new Error('that Minecraft version is not available for this server type');
    start(inst, 'upgrade', async (log) => {
      const wasRunning = deps.isRunning(inst);
      const b = deps.backups(inst);
      log('taking a world backup first');
      const before = await newestBackup(b);
      const ok = await b.api.createBackup('pre-upgrade', b.deps);
      const backup = ok ? await newestBackup(b) : null;
      if (!ok && b.api.worldDirNames().length) throw new Error('backup failed, nothing was changed');
      log(backup && backup !== before ? `backup done: ${backup}` : 'no world yet, nothing to back up');
      writeRecord(inst, { at: Date.now(), from: inst.version, to: version, backup: backup !== before ? backup : null, rolledBack: false });
      log(`recreating the container on Minecraft ${version}`);
      inst.version = version;
      deps.save(inst);
      await deps.recreate(inst, wasRunning);
    });
  }

  async function rollback(inst, restoreWorld) {
    const rec = readRecord(inst);
    if (!rec || rec.rolledBack) throw new Error('nothing to roll back');
    start(inst, 'rollback', async (log) => {
      const wasRunning = deps.isRunning(inst);
      log(`restoring Minecraft ${rec.from}`);
      inst.version = rec.from;
      deps.save(inst);
      await deps.recreate(inst, false);
      if (restoreWorld && rec.backup) {
        log('restoring the world from the backup taken before the upgrade');
        const b = deps.backups(inst);
        const restored = await b.api.restoreBackup(rec.backup, b.deps);
        if (restored === false) throw new Error('the world restore failed');
      }
      rec.rolledBack = true;
      writeRecord(inst, rec);
      if (wasRunning) await deps.recreate(inst, true);
    });
  }

  function status(inst) {
    const job = jobs.get(inst.id);
    return {
      running: !!(job && job.running), done: !!(job && job.done), error: job ? job.error : null, lines: job ? job.lines : [], kind: job ? job.kind : null,
      latest: readRecord(inst), current: { type: inst.type, version: inst.version },
    };
  }

  return { upgrade, rollback, status, isBusy: (inst) => !!jobs.get(inst.id)?.running };
}

module.exports = { createUpgrades, listVersions, removeRecord };
