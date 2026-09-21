// A stand-in for the docker CLI: containers are files in FAKE_DOCKER_DIR, every call is logged to calls.jsonl.
// FAKE_DOCKER_FAIL: create | start | exited makes that step fail (exited: the container dies right after start).
const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_DOCKER_DIR;
const args = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
const fail = process.env.FAKE_DOCKER_FAIL;
const file = (name) => path.join(dir, `${name}.json`);
const read = (name) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (_) { return null; } };
const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value));
const die = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };
const hold = path.join(dir, '.hold-start');

async function main() {
  const [cmd] = args;
  if (cmd === 'version') return console.log('27.0.0');
  if (cmd === 'create') {
    if (fail === 'create') die('Error response from daemon: fake create failure');
    const name = args[args.indexOf('--name') + 1];
    return write(name, { state: 'created', args });
  }
  if (cmd === 'start') {
    const name = args[1];
    if (fail === 'start') die('Error response from daemon: fake start failure');
    while (fs.existsSync(hold)) await new Promise((r) => setTimeout(r, 100));
    const c = read(name);
    if (!c) die(`Error: No such container: ${name}`);
    write(name, { ...c, state: fail === 'exited' ? 'exited' : 'running' });
    return;
  }
  if (cmd === 'stop' || cmd === 'kill') { const name = args[args.length - 1]; const c = read(name); if (c) write(name, { ...c, state: 'exited' }); return; }
  if (cmd === 'rm') { fs.rmSync(file(args[args.length - 1]), { force: true }); return; }
  if (cmd === 'ps') {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const name = f.slice(0, -5);
      const c = read(name);
      console.log(`${name}|${c.state}|${c.state === 'running' ? 'Up 5 seconds (healthy)' : 'Exited (0) 1 second ago'}`);
    }
    return;
  }
  if (cmd === 'logs') return console.log('[00:00:01] [Server thread/INFO]: Done (1.0s)! For help, type "help"');
  // stats, inspect, exec: nothing to report
}
main();
