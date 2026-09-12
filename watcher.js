const fs = require('fs');
const path = require('path');
const player = require('./player.js');

const DIR = 'C:\\Users\\Adil\\AppData\\Local\\fast-tts';
const PID_FILE = path.join(DIR, 'watcher.pid');
const LOG_FILE = path.join(DIR, 'watcher.log');
const BRAIN_DIR = 'C:\\Users\\Adil\\.gemini\\antigravity-ide\\brain';

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\n';
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch(e) {}
}

// 1. Single-instance PID check
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        console.log('Watcher already running on PID ' + oldPid);
        process.exit(0);
      } catch (e) {
        // Stale PID, continue
      }
    }
  }
  fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf8');
} catch (e) {}

process.on('exit', () => {
  try {
    if (fs.existsSync(PID_FILE)) {
      const p = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (p === process.pid) fs.unlinkSync(PID_FILE);
    }
  } catch(e) {}
});

const playedStepKeys = new Set();
let lastSpokenContent = '';

// 2. Seed existing step keys so historic turns are not spoken on startup
try {
  if (fs.existsSync(BRAIN_DIR)) {
    const dirs = fs.readdirSync(BRAIN_DIR);
    for (const d of dirs) {
      const p = path.join(BRAIN_DIR, d, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        const chunkSize = Math.min(stat.size, 64 * 1024);
        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(p, 'r');
        fs.readSync(fd, buffer, 0, chunkSize, Math.max(0, stat.size - chunkSize));
        fs.closeSync(fd);
        const lines = buffer.toString('utf8').split('\n');
        for (const l of lines) {
          if (l.includes('"PLANNER_RESPONSE"')) {
            try {
              const obj = JSON.parse(l.trim());
              if (obj.step_index !== undefined) {
                playedStepKeys.add(d + ':' + obj.step_index);
              }
            } catch (e) {}
          }
        }
      }
    }
  }
} catch (e) {
  log('Seed error: ' + e.message);
}

log('Watcher started. Seeded ' + playedStepKeys.size + ' historic steps. PID ' + process.pid);
console.log('Watcher active. Seeded ' + playedStepKeys.size + ' steps. Watching ' + BRAIN_DIR);

function checkTranscripts() {
  const cfg = player.loadConfig();
  if (cfg.enabled === false) return;

  try {
    if (!fs.existsSync(BRAIN_DIR)) return;
    const dirs = fs.readdirSync(BRAIN_DIR);
    for (const d of dirs) {
      const p = path.join(BRAIN_DIR, d, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        // Only inspect transcripts modified in the last 3 minutes
        if (Date.now() - stat.mtimeMs > 180000) continue;

        const chunkSize = Math.min(stat.size, 64 * 1024);
        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(p, 'r');
        fs.readSync(fd, buffer, 0, chunkSize, Math.max(0, stat.size - chunkSize));
        fs.closeSync(fd);

        const lines = buffer.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.includes('"PLANNER_RESPONSE"')) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'PLANNER_RESPONSE' && obj.content && obj.content.trim()) {
                const key = d + ':' + obj.step_index;
                if (!playedStepKeys.has(key)) {
                  playedStepKeys.add(key);

                  const clean = obj.content.trim();
                  if (clean !== lastSpokenContent) {
                    lastSpokenContent = clean;
                    log('Speaking response from ' + d.slice(0, 8) + ' step ' + obj.step_index);
                    player.enqueueSpeech(clean, cfg.voice, cfg.rate);
                  }
                }
                break;
              }
            } catch (e) {}
          }
        }
      }
    }
  } catch (e) {
    log('Check error: ' + e.message);
  }
}

setInterval(checkTranscripts, 350);
