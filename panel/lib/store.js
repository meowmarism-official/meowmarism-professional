const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createUserStore } = require('../core/modules/users');

const HOME = os.homedir();
const USERS_FILE = path.join(HOME, '.meowmarism-pro-users.json');
const INSTANCES_FILE = path.join(HOME, '.meowmarism-pro-instances.json');
const SESSIONS_FILE = path.join(HOME, '.meowmarism-pro-sessions.json');
const DATA_DIR = path.join(HOME, 'meowmarism-pro');
const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const userStore = createUserStore(USERS_FILE);
const users = {
  store: userStore,
  hasOwner: () => userStore.hasOwner(),
  setOwner: (username, password) => userStore.resetOwner(username, password),
  verify(username, password) {
    if (!userStore.verifyUser(username, password)) return null;
    const u = userStore.findUser(username);
    return { username: u.username, role: u.role };
  },
};

const sessions = (() => {
  const map = new Map();
  const saved = readJson(SESSIONS_FILE, {});
  for (const [k, v] of Object.entries(saved)) if (Date.now() - v.createdAt < SESSION_MAX_AGE_MS) map.set(k, v);
  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { writeJson(SESSIONS_FILE, Object.fromEntries(map)); } catch (_) {} }, 200);
  };
  const key = (token) => crypto.createHash('sha256').update(token).digest('hex');
  return {
    create(user) {
      const token = crypto.randomBytes(32).toString('hex');
      map.set(key(token), { username: user.username, role: user.role, createdAt: Date.now() });
      persist();
      return token;
    },
    get(token) {
      if (!token) return null;
      const s = map.get(key(token));
      if (!s) return null;
      if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) { map.delete(key(token)); return null; }
      return s;
    },
    destroy(token) { map.delete(key(token)); persist(); },
    destroyUser(username) { for (const [k, s] of map) if (s.username === username) map.delete(k); persist(); },
  };
})();

const instances = {
  list: () => readJson(INSTANCES_FILE, []),
  save: (list) => writeJson(INSTANCES_FILE, list),
};

module.exports = { HOME, DATA_DIR, INSTANCES_DIR, SESSION_MAX_AGE_MS, users, sessions, instances };
