// Scheduled tasks per instance, stored on the instance record and run with the shared runner from core.
const scheduler = require('../core/modules/scheduler');
const { runTask } = require('../core/modules/schedule-run');
const { instances } = require('./store');
const { runtimeFor } = require('../runtime');
const backups = require('./backups');

function mutate(id, fn) {
  const list = instances.list();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new Error('unknown instance');
  const out = fn(inst);
  instances.save(list);
  return out;
}

const tasksOf = (inst) => inst.schedule || [];
const publicTasks = (inst) => tasksOf(inst).map((t) => ({ ...t, nextRunAt: scheduler.nextRunAt(t) }));

function restartWithWarning(inst, owner, sec, reason) {
  const rt = runtimeFor(inst, owner);
  if (sec > 0) {
    rt.command(`say ${reason}: restarting in ${sec}s`);
    setTimeout(() => rt.restart(), sec * 1000);
  } else rt.restart();
}

function execute(inst, owner, task) {
  const b = backups.forInstance(inst, owner);
  const result = runTask(task, {
    runtime: runtimeFor(inst, owner),
    createBackup: (reason) => b.api.createBackup(reason, b.deps),
    restart: (sec, reason) => restartWithWarning(inst, owner, sec, reason),
    onError: () => {},
  });
  mutate(inst.id, (rec) => {
    const t = tasksOf(rec).find((x) => x.id === task.id);
    if (t) { t.lastRunAt = Date.now(); t.lastResult = result; }
  });
  return result;
}

module.exports = {
  list: (inst) => ({ tasks: publicTasks(inst), now: Date.now() }),
  save(inst, data) {
    return mutate(inst.id, (rec) => {
      rec.schedule = rec.schedule || [];
      const existing = data.id ? rec.schedule.find((t) => t.id === data.id) : null;
      const task = scheduler.cleanTask(data, existing);
      if (existing) Object.assign(existing, task); else rec.schedule.push(task);
      return task;
    });
  },
  remove: (inst, taskId) => mutate(inst.id, (rec) => { rec.schedule = tasksOf(rec).filter((t) => t.id !== taskId); }),
  run(inst, owner, taskId) {
    const task = tasksOf(inst).find((t) => t.id === taskId);
    if (!task) throw new Error('task not found');
    return execute(inst, owner, task);
  },
  // Called every few seconds for all instances.
  tick(owner) {
    for (const inst of instances.list()) {
      for (const task of tasksOf(inst)) {
        if (scheduler.isDue(task)) { try { execute(inst, owner, task); } catch (_) {} }
      }
    }
  },
};
