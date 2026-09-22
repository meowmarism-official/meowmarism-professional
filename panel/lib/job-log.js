// A create/upgrade job's log: a capped ring buffer plus a small, separately-capped list of lines that matter
// (modpack environment decisions, loader version, errors) so a noisy installer can't push them out unseen.
const { isImportantCreateLine } = require('../core/modules/create-log');

const MAX_LINES = 300;
const MAX_IMPORTANT_LINES = 100;

function pushJobLog(job, line) {
  job.lines.push(line);
  if (job.lines.length > MAX_LINES) job.lines.shift();
  if (isImportantCreateLine(line)) {
    job.important = job.important || [];
    job.important.push(line);
    if (job.important.length > MAX_IMPORTANT_LINES) job.important.shift();
  }
}

module.exports = { pushJobLog, MAX_LINES, MAX_IMPORTANT_LINES };
