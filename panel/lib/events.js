// Per-instance event timeline and audit log, kept as JSON files.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const MAX = 400;
const cache = new Map();
const file = (name) => path.join(DATA_DIR, 'events', `${name}.json`);

function load(name) {
  if (!cache.has(name)) {
    let data = { seq: 0, events: [], audit: [] };
    try { data = { ...data, ...JSON.parse(fs.readFileSync(file(name), 'utf8')) }; } catch (_) {}
    cache.set(name, data);
  }
  return cache.get(name);
}

function add(name, kind, entry) {
  const data = load(name);
  data[kind].push({ seq: ++data.seq, at: Date.now(), ...entry });
  if (data[kind].length > MAX) data[kind].shift();
  try {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify(data));
  } catch (_) {}
}

const list = (name) => {
  const data = load(name);
  return { events: data.events.slice(-200), audit: data.audit.slice(-200) };
};

function recent(name, kind, types, withinMs) {
  const since = Date.now() - withinMs;
  return load(name)[kind].some((e) => e.at >= since && types.includes(e.type));
}

function forget(name) {
  cache.delete(name);
  fs.rmSync(file(name), { force: true });
}

module.exports = { add, list, recent, forget };
