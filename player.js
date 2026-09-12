const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = 'C:\\Users\\Adil\\AppData\\Local\\fast-tts';
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const DEDUP_PATH = path.join(DIR, 'last_speech.json');
const PID_PATH = path.join(DIR, 'active_pid.txt');
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

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

  // 12. Shorten git commit hex hashes to avoid spelling hex chars
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
  return { isSpeaking: false, isPaused: false, currentText: '', activePid: null, queueLength: 0 };
}

function updateState(isSpeaking, isPaused = false, currentText = '', activePid = null) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      isSpeaking,
      isPaused,
      currentText,
      activePid,
      queueLength: queue.length,
      timestamp: Date.now()
    }, null, 2), 'utf8');
  } catch (e) {}
}

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

// Persistent interactive PowerShell speech worker
let workerProcess = null;
let currentResolve = null;
let activeText = '';
const queue = [];

const PS_WORKER_SCRIPT = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
$s.Rate = 1

Register-ObjectEvent -InputObject $s -EventName SpeakCompleted -Action {
  [Console]::WriteLine("EVENT:DONE")
} | Out-Null

[Console]::WriteLine("EVENT:READY")

while ($line = [Console]::ReadLine()) {
  if ($line.StartsWith("SPEAK_B64:")) {
    try {
      $b64 = $line.Substring(10)
      $bytes = [System.Convert]::FromBase64String($b64)
      $text = [System.Text.Encoding]::UTF8.GetString($bytes)
      $s.SpeakAsyncCancelAll()
      $s.SpeakAsync($text) | Out-Null
      [Console]::WriteLine("STATE:SPEAKING")
    } catch {
      [Console]::WriteLine("ERROR:" + $_.Exception.Message)
    }
  }
  elseif ($line.StartsWith("VOICE:")) {
    $v = $line.Substring(6).Trim().ToLower()
    if ($v.Contains('david')) {
      $s.SelectVoice('Microsoft David Desktop')
    } elseif ($v.Contains('hazel')) {
      $s.SelectVoice('Microsoft Hazel Desktop')
    } else {
      $s.SelectVoice('Microsoft Zira Desktop')
    }
  }
  elseif ($line.StartsWith("RATE:")) {
    try {
      $s.Rate = [int]$line.Substring(5).Trim()
    } catch {}
  }
  elseif ($line -eq "PAUSE") {
    if ($s.State -eq [System.Speech.Synthesis.SynthesizerState]::Speaking) {
      $s.Pause()
      [Console]::WriteLine("STATE:PAUSED")
    }
  }
  elseif ($line -eq "RESUME") {
    if ($s.State -eq [System.Speech.Synthesis.SynthesizerState]::Paused) {
      $s.Resume()
      [Console]::WriteLine("STATE:SPEAKING")
    }
  }
  elseif ($line -eq "STOP") {
    $s.SpeakAsyncCancelAll()
    [Console]::WriteLine("STATE:STOPPED")
  }
  elseif ($line -eq "EXIT") {
    break
  }
}
`;

function ensureWorker() {
  if (workerProcess && !workerProcess.killed) return;

  try {
    workerProcess = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', PS_WORKER_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const pid = workerProcess.pid;
    fs.writeFileSync(PID_PATH, String(pid), 'utf8');

    workerProcess.stdout.on('data', (buf) => {
      const lines = buf.toString('utf8').trim().split('\n');
      for (const line of lines) {
        const l = line.trim();
        if (l === 'STATE:SPEAKING') {
          updateState(true, false, activeText, pid);
        } else if (l === 'STATE:PAUSED') {
          updateState(false, true, activeText, pid);
        } else if (l === 'STATE:STOPPED' || l === 'EVENT:DONE') {
          updateState(false, false, '', null);
          if (currentResolve) {
            const res = currentResolve;
            currentResolve = null;
            res({ played: true });
          }
          _playNextInQueue();
        }
      }
    });

    workerProcess.on('exit', () => {
      workerProcess = null;
      updateState(false, false, '', null);
      try { if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH); } catch (e) {}
      if (currentResolve) {
        const res = currentResolve;
        currentResolve = null;
        res({ played: false, exit: true });
      }
      _playNextInQueue();
    });

    workerProcess.on('error', () => {
      workerProcess = null;
      updateState(false, false, '', null);
      if (currentResolve) {
        const res = currentResolve;
        currentResolve = null;
        res({ played: false, error: true });
      }
      _playNextInQueue();
    });
  } catch (err) {
    workerProcess = null;
    updateState(false, false, '', null);
  }
}

function _startPlayback(spokenText, voiceName, rate) {
  return new Promise((resolve) => {
    if (!spokenText || !spokenText.trim()) {
      resolve({ played: false, reason: 'Empty text' });
      _playNextInQueue();
      return;
    }

    ensureWorker();
    if (!workerProcess || !workerProcess.stdin) {
      resolve({ played: false, error: 'Worker unavailable' });
      _playNextInQueue();
      return;
    }

    currentResolve = resolve;
    activeText = spokenText;

    const cfg = loadConfig();
    const voice = voiceName || cfg.voice || 'Zira';
    const spd = typeof rate === 'number' ? rate : (cfg.rate || 1);

    try {
      workerProcess.stdin.write('VOICE:' + voice + '\n');
      workerProcess.stdin.write('RATE:' + spd + '\n');

      const b64 = Buffer.from(spokenText, 'utf8').toString('base64');
      workerProcess.stdin.write('SPEAK_B64:' + b64 + '\n');
    } catch (e) {
      resolve({ played: false, error: e.message });
      _playNextInQueue();
    }
  });
}

function _playNextInQueue() {
  const st = loadState();
  if (st.isSpeaking || st.isPaused || queue.length === 0) {
    return;
  }
  const next = queue.shift();
  _startPlayback(next.text, next.voice, next.rate).then((res) => {
    if (next.resolve) next.resolve(res);
  });
}

// Pause active speech right where it is
function pause() {
  if (workerProcess && workerProcess.stdin) {
    try { workerProcess.stdin.write('PAUSE\n'); } catch (e) {}
  }
  updateState(false, true, activeText, workerProcess ? workerProcess.pid : null);
}

// Resume paused speech from exact paused word
function resume() {
  if (workerProcess && workerProcess.stdin) {
    try { workerProcess.stdin.write('RESUME\n'); } catch (e) {}
  }
  updateState(true, false, activeText, workerProcess ? workerProcess.pid : null);
}

// Toggle Pause/Resume, or Replay if stopped
function togglePlayPause() {
  const st = loadState();
  if (st.isSpeaking) {
    pause();
    return 'PAUSED';
  } else if (st.isPaused) {
    resume();
    return 'RESUMED';
  } else {
    // Idle -> Replay last
    const cfg = loadConfig();
    if (cfg.history && cfg.history.length > 0) {
      const last = cfg.history[cfg.history.length - 1];
      playDirect(last.text, last.voice, last.rate);
      return 'REPLAYING';
    }
  }
  return 'IDLE';
}

function stop() {
  // Clear queue
  while (queue.length > 0) {
    const item = queue.shift();
    if (item.resolve) item.resolve({ played: false, stopped: true });
  }

  if (workerProcess && workerProcess.stdin) {
    try { workerProcess.stdin.write('STOP\n'); } catch (e) {}
  }

  updateState(false, false, '', null);
}

function playDirect(text, voiceName, rate) {
  stop();
  const spokenText = cleanTextForSpeech(text);
  return _startPlayback(spokenText, voiceName, rate);
}

function enqueueSpeech(text, voiceName, rate) {
  return new Promise((resolve) => {
    const spokenText = cleanTextForSpeech(text);
    if (!spokenText || !spokenText.trim()) {
      resolve({ played: false, reason: 'Empty text' });
      return;
    }

    if (checkAndSetDeduplication(spokenText)) {
      resolve({ played: false, reason: 'Duplicate speech prevented' });
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

    const st = loadState();
    if (st.isSpeaking || st.isPaused) {
      queue.push({ text: spokenText, voice, rate: spd, resolve });
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
  pause,
  resume,
  togglePlayPause,
  stop,
  playDirect,
  enqueueSpeech
};
