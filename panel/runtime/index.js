// PROFESSIONAL runtime: every instance is a Docker container. The contract is synchronous where shared modules expect it,
// so container state and stats are cached and refreshed by a poller and after every action.
const docker = require('./docker');
const { assertRuntime } = require('../core/modules/runtime-contract');

const startup = require('../lib/startup');

const stateCache = { states: {}, stats: {} };
const sawDown = new Set();

async function refreshStates() {
  stateCache.states = await docker.states();
  for (const [name, st] of Object.entries(stateCache.states)) {
    const ready = st.state === 'running' && (st.health === 'healthy' || st.health === 'none');
    if (!ready) sawDown.add(name);
    // After a restart request the old container still looks ready for a moment, so wait until it was seen going down.
    if (ready && (!startup.pending(name) || sawDown.has(name))) { startup.ready(name); sawDown.delete(name); }
    if (st.state !== 'running' && !startup.pending(name)) startup.stopped(name);
  }
}

async function refreshStats() {
  stateCache.stats = await docker.stats();
}

let poller = null;
function startPolling() {
  if (poller) return;
  refreshStates();
  poller = setInterval(refreshStates, 2000);
  poller.unref();
  const statsPoller = setInterval(refreshStats, 5000);
  statsPoller.unref();
}

const runtimes = new Map();

// owner: { uid, gid } that files in the instance folder get
function createRuntime(inst, owner) {
  const name = docker.containerName(inst);
  const st = () => stateCache.states[name] || {};
  let queue = Promise.resolve();
  const enqueue = (fn) => { queue = queue.then(fn, fn); return queue; };
  const settle = async (p) => { try { await p; } finally { await refreshStates(); } };

  const rt = {
    isRunning: () => st().state === 'running',
    isReady: () => st().state === 'running' && st().health === 'healthy',
    start() {
      if (st().state === 'running') return false;
      startup.begin(name); sawDown.delete(name);
      settle(docker.start(inst)).catch(() => {});
      return true;
    },
    stop() {
      if (st().state !== 'running') return false;
      settle(docker.stop(inst)).catch(() => {});
      return true;
    },
    restart() {
      startup.begin(name); sawDown.delete(name);
      settle(docker.stop(inst).catch(() => {}).then(() => docker.start(inst))).catch(() => {});
      return true;
    },
    kill() {
      if (st().state !== 'running') return false;
      settle(docker.kill(inst)).catch(() => {});
      return true;
    },
    // Commands run one after another, so save-off always comes before save-all.
    command(text) {
      if (st().state !== 'running') return false;
      enqueue(() => docker.command(inst, text)).catch(() => {});
      return true;
    },
    async stopAndWait() {
      if (st().state !== 'running') return;
      await settle(docker.stop(inst));
    },
    stats() {
      const s = stateCache.stats[name];
      if (!s || st().state !== 'running') return null;
      return { cpuPercent: s.cpu, memoryMB: s.memMB ?? null };
    },
    // Awaitable versions with real errors, for the panel's own actions.
    startAsync: () => { startup.begin(name); sawDown.delete(name); return settle(docker.start(inst)); },
    stopAsync: () => settle(docker.stop(inst)),
    killAsync: () => settle(docker.kill(inst)),
    commandAsync: (text) => enqueue(() => docker.command(inst, text)),
    createContainer: () => docker.create(inst, owner),
    removeContainer: () => docker.remove(inst),
    logs: (tail) => docker.logs(inst, tail),
  };
  return assertRuntime(rt);
}

function runtimeFor(inst, owner) {
  let rt = runtimes.get(inst.id);
  if (!rt) { rt = createRuntime(inst, owner); runtimes.set(inst.id, rt); }
  return rt;
}

// Instance data changed (ports, limits): the next call builds a fresh runtime.
const forget = (id) => runtimes.delete(id);

module.exports = { runtimeFor, forget, refreshStates, refreshStats, startPolling, stateCache, docker };
