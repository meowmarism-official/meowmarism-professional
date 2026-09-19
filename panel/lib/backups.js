// World backups per instance, using the shared backup module from core.
const path = require('path');
const { createBackups } = require('../core/modules/backup');
const { DATA_DIR } = require('./store');
const { runtimeFor } = require('../runtime');

const DEFAULTS = { maxBackups: 10, backupIntervalHours: 6, backupMinFreeGB: 5 };
const cache = new Map();

function forInstance(inst, owner) {
  let entry = cache.get(inst.id);
  if (entry) return entry;
  const settings = { ...DEFAULTS, ...(inst.backup || {}) };
  const backupDir = path.join(DATA_DIR, 'backups', inst.name);
  const api = createBackups({ SERVER_DIR: inst.dir, WORLD_DIR: path.join(inst.dir, 'world'), BACKUP_DIR: backupDir, panelConfig: settings });
  const log = [];
  const note = (line) => { log.push({ at: Date.now(), line }); if (log.length > 100) log.shift(); };
  const deps = {
    broadcast: note,
    broadcastEvent: () => {},
    pushTimeline: (type, title, detail) => note(`${title}${detail ? `: ${detail}` : ''}`),
    runtime: runtimeFor(inst, owner),
  };
  api.rescheduleAutoBackup(deps);
  api.startPruneTimer(deps);
  entry = { api, deps, log, settings, backupDir };
  cache.set(inst.id, entry);
  return entry;
}

const forget = (id) => cache.delete(id);

module.exports = { forInstance, forget, DEFAULTS };
