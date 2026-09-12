const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// State and storage paths
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'fast-tts');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const DEDUP_PATH = path.join(DIR, 'last_speech.json');

function checkAndSetDeduplication(spokenText) {
  try {
    const now = Date.now();
    if (fs.existsSync(DEDUP_PATH)) {
      const data = JSON.parse(fs.readFileSync(DEDUP_PATH, 'utf8'));
      if (data && data.text === spokenText && (now - data.time) < 8000) {
        return true; // Duplicate!
      }
    }
    fs.writeFileSync(DEDUP_PATH, JSON.stringify({ text: spokenText, time: now }), 'utf8');
  } catch (e) {}
  return false;
}

const PID_PATH = path.join(DATA_DIR, 'active_pid.txt');
const TEXT_PATH = path.join(DATA_DIR, 'current_speech.txt');
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Normalizes rich technical markdown into natural, fluent human speech.
 * Strips headers, URLs, links, emojis, long code blocks, and markdown noise.
 */
function cleanTextForSpeech(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw;

  // 1. Code blocks: summarize long blocks
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    const inner = match.replace(/^```[a-zA-Z0-9_\-\+]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
    if (inner.split(/\r?\n/).length <= 2 && inner.length < 60) {
      return ' ' + inner + '. ';
    }
    return ' as shown in the code snippet. ';
  });

  // 2. Strip HTML tags: <tag ...>
  text = text.replace(/<[^>]+>/g, ' ');

  // 3. Format markdown links & images: [Display Text](url) or ![alt](url) -> Display Text
  text = text.replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1');

  // 4. Remove raw URLs and file URIs: file:///..., http://..., https://...
  text = text.replace(/(?:file:\/\/\/|https?:\/\/)[^\s)>]+/gi, ' ');

  // 5. Clean C# to C Sharp
  text = text.replace(/\bC#\b/g, 'C Sharp');

  // 6. Normalize Windows file paths with backslashes
  // e.g. C:\Users\Adil\antigravity-voice-assistant\ -> antigravity-voice-assistant
  // e.g. C:\Projects\MyApp -> MyApp
  text = text.replace(/[A-Za-z]:\\[^\s\r\n\(\)\[\]"'`*]+/g, (match) => {
    const parts = match.replace(/\\+$/, '').split('\\').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  });

  // 7. Normalize Unix file paths: e.g. src/components/App.html -> App.html
  text = text.replace(/(?:[\w.-]+\/)+([\w.-]+)/g, '$1');

  // 8. Remove ALL hashtags / hashes (#) everywhere so SpeechSynthesizer never says 'number number number'
  text = text.replace(/#+/g, '');

  // 9. Remove decorative emojis
  text = text.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}]/gu, '');

  // 10. Normalize keyboard shortcuts
  text = text.replace(/Ctrl\s*\+\s*Shift\s*\+\s*P/gi, 'Control Shift P');
  text = text.replace(/Ctrl\s*\+\s*([A-Za-z0-9])/gi, 'Control $1');
  text = text.replace(/Alt\s*\+\s*([A-Za-z0-9])/gi, 'Alt $1');

  // 11. Clean up markdown bold, italics, strikethrough, backticks
  text = text.replace(/[*_~`]/g, ' ');

  // 12. Shorten git commit hex hashes (e.g. acbe0d8 or 40-char hashes) to avoid spelling hex chars
  text = text.replace(/\b[0-9a-f]{7,40}\b/gi, 'commit');

  // 13. Remove remaining backslashes completely so 'backslash' is never spoken!
  text = text.replace(/\\+/g, ' ');

  // 14. Convert file extensions for natural pronunciation
  text = text.replace(/\.js\b/gi, ' JS');
  text = text.replace(/\.ts\b/gi, ' TypeScript');
  text = text.replace(/\.json\b/gi, ' JSON');
  text = text.replace(/\.html\b/gi, ' HTML');
  text = text.replace(/\.aspx\b/gi, ' ASPX');
  text = text.replace(/\.cs\b/gi, ' C Sharp');
  text = text.replace(/\.md\b/gi, ' markdown');

  // 15. Clean up list bullets, table bars, dividers
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  text = text.replace(/\|/g, ' ');
  text = text.replace(/---+/g, ' ');

  // 16. Clean up whitespace and punctuation
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\s+([.,;:?!])/g, '$1');

  return text;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {}
  return { enabled: true, voice: 'Zira', rate: 1, history: [], currentIndex: -1 };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {}
  return { isSpeaking: false, currentText: '', activePid: null, queueLength: 0 };
}

function updateState(isSpeaking, currentText = '', activePid = null) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      isSpeaking,
      currentText,
      activePid,
      queueLength: queue.length,
      timestamp: Date.now()
    }, null, 2), 'utf8');
  } catch (e) {}
}

let activeProcess = null;
const queue = [];

function stop() {
  while (queue.length > 0) {
    const item = queue.shift();
    if (item.resolve) item.resolve({ played: false, stopped: true });
  }

  if (activeProcess) {
    try {
      execSync('taskkill /F /T /PID ' + activeProcess.pid, { stdio: 'ignore' });
    } catch (e) {}
    activeProcess = null;
  }

  try {
    if (fs.existsSync(PID_PATH)) {
      const pidStr = fs.readFileSync(PID_PATH, 'utf8').trim();
      if (pidStr) {
        try {
          execSync('taskkill /F /T /PID ' + pidStr, { stdio: 'ignore' });
        } catch (e) {}
      }
      fs.unlinkSync(PID_PATH);
    }
  } catch (e) {}

  updateState(false, '', null);
}

function _startPlayback(spokenText, voiceName, rate) {
  return new Promise((resolve) => {
    if (!spokenText || !spokenText.trim()) {
      resolve({ played: false, reason: 'Empty text' });
      _playNextInQueue();
      return;
    }

    const cfg = loadConfig();
    const voice = voiceName || cfg.voice || 'Zira';
    const spd = typeof rate === 'number' ? rate : (cfg.rate || 1);

    fs.writeFileSync(TEXT_PATH, spokenText, 'utf8');

    let voiceSelect = "$s.SelectVoice('Microsoft Zira Desktop');";
    if (voice) {
      const v = voice.toLowerCase();
      if (v.includes('david')) {
        voiceSelect = "$s.SelectVoice('Microsoft David Desktop');";
      } else if (v.includes('hazel')) {
        voiceSelect = "$s.SelectVoice('Microsoft Hazel Desktop');";
      }
    }

    const clampedRate = Math.max(-10, Math.min(10, Math.round(spd)));
    const escapedTextPath = TEXT_PATH.replace(/\\/g, '\\\\');

    const psScript = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voiceSelect}
$s.Rate = ${clampedRate}
$txt = [System.IO.File]::ReadAllText('${escapedTextPath}', [System.Text.Encoding]::UTF8)
$s.Speak($txt)
`;

    try {
      if (fs.existsSync(PID_PATH)) {
        try {
          const oldPid = fs.readFileSync(PID_PATH, 'utf8').trim();
          if (oldPid) execSync('taskkill /F /T /PID ' + oldPid, { stdio: 'ignore' });
        } catch (e) {}
      }
      activeProcess = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
        stdio: 'ignore'
      });

      const pid = activeProcess.pid;
      fs.writeFileSync(PID_PATH, String(pid), 'utf8');
      updateState(true, spokenText, pid);

      activeProcess.on('exit', () => {
        if (activeProcess && activeProcess.pid === pid) {
          activeProcess = null;
        }
        try {
          if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
        } catch (e) {}
        resolve({ played: true });
        _playNextInQueue();
      });

      activeProcess.on('error', () => {
        activeProcess = null;
        resolve({ played: false, error: true });
        _playNextInQueue();
      });
    } catch (err) {
      activeProcess = null;
      resolve({ played: false, error: err.message });
      _playNextInQueue();
    }
  });
}

function _playNextInQueue() {
  if (activeProcess || queue.length === 0) {
    if (!activeProcess) {
      updateState(false, '', null);
    }
    return;
  }
  const next = queue.shift();
  _startPlayback(next.text, next.voice, next.rate).then((res) => {
    if (next.resolve) next.resolve(res);
  });
}

function playDirect(text, voiceName, rate) {
  stop();
  const spokenText = cleanTextForSpeech(text);
  return _startPlayback(spokenText, voiceName, rate);
}

function enqueueSpeech(text, voiceName, rate) {
  return new Promise((resolve) => {
    const spokenText = cleanTextForSpeech(text);
    if (checkAndSetDeduplication(spokenText)) {
      resolve({ played: false, reason: 'Duplicate speech prevented' });
      return;
    }
    if (!spokenText || !spokenText.trim()) {
      resolve({ played: false, reason: 'Empty text' });
      return;
    }

    const cfg = loadConfig();
    const voice = voiceName || cfg.voice || 'Zira';
    const spd = typeof rate === 'number' ? rate : (cfg.rate || 1);

    if (!Array.isArray(cfg.history)) cfg.history = [];
    cfg.history.push({
      id: Date.now(),
      text,
      time: new Date().toISOString(),
      voice,
      rate: spd
    });
    if (cfg.history.length > 50) cfg.history.shift();
    cfg.currentIndex = cfg.history.length - 1;
    saveConfig(cfg);

    if (activeProcess) {
      queue.push({ text: spokenText, voice, rate: spd, resolve });
      updateState(true, loadState().currentText, activeProcess.pid);
    } else {
      _startPlayback(spokenText, voice, spd).then(resolve);
    }
  });
}

module.exports = {
  cleanTextForSpeech,
  loadConfig,
  saveConfig,
  loadState,
  updateState,
  stop,
  playDirect,
  enqueueSpeech
};
