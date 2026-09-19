const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const USERS_FILE = path.join(HOME, '.meowmarism-pro-users.json');
const INSTANCES_FILE = path.join(HOME, '.meowmarism-pro-instances.json');
const SESSIONS_FILE = path.join(HOME, '.meowmarism-pro-sessions.json');
const DATA_DIR = path.join(HOME, 'meowmarism-pro');
const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function checkPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const users = {
  hasOwner: () => readJson(USERS_FILE, []).some((u) => u.role === 'owner'),
  setOwner(username, password) {
    const list = readJson(USERS_FILE, []).filter((u) => u.role !== 'owner');
    list.push({ username, passwordHash: hashPassword(password), role: 'owner', createdAt: Date.now() });
    writeJson(USERS_FILE, list);
  },
  verify(username, password) {
    const u = readJson(USERS_FILE, []).find((x) => x.username === username);
    if (!u) { checkPassword(password, `${'00'.repeat(16)}:${'00'.repeat(64)}`); return null; }
    return checkPassword(password, u.passwordHash) ? { username: u.username, role: u.role } : null;
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
  };
})();

const instances = {
  list: () => readJson(INSTANCES_FILE, []),
  save: (list) => writeJson(INSTANCES_FILE, list),
};

module.exports = { HOME, DATA_DIR, INSTANCES_DIR, SESSION_MAX_AGE_MS, users, sessions, instances };
