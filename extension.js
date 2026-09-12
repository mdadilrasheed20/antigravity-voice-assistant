const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const player = require('C:\\Users\\Adil\\AppData\\Local\\fast-tts\\player.js');


const BRAIN_DIR = 'C:\\Users\\Adil\\.gemini\\antigravity-ide\\brain';
const playedStepKeys = new Set();
let lastSpokenContent = '';

// Seed existing step keys so we don't speak historic turns on IDE boot
try {
  if (fs.existsSync(BRAIN_DIR)) {
    const dirs = fs.readdirSync(BRAIN_DIR);
    for (const d of dirs) {
      const p = path.join(BRAIN_DIR, d, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        const chunkSize = Math.min(stat.size, 32 * 1024);
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
} catch (e) {}



function ensureBackgroundWatcher() {
  try {
    const watcherPath = 'C:\\Users\\Adil\\AppData\\Local\\fast-tts\\watcher.js';
    const pidFile = 'C:\\Users\\Adil\\AppData\\Local\\fast-tts\\watcher.pid';
    let running = false;
    if (fs.existsSync(pidFile)) {
      const p = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (p) {
        try { process.kill(p, 0); running = true; } catch(e) {}
      }
    }
    if (!running && fs.existsSync(watcherPath)) {
      const cp = require('child_process');
      const child = cp.spawn('node', [watcherPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    }
  } catch (e) {}
}

function activate(context) {
  ensureBackgroundWatcher();
  // Status Bar: Toggle Voice ON/OFF (Permanent mute)
  const barToggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105);
  barToggle.command = 'fastTts.togglePermanent';
  context.subscriptions.push(barToggle);

  // Status Bar: Dynamic Pause / Resume / Play button
  const barAction = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
  context.subscriptions.push(barAction);

  // Status Bar: Dedicated Stop button
  const barStop = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103.5);
  barStop.command = 'fastTts.stop';
  barStop.text = '$(primitive-square) Stop';
  barStop.tooltip = 'Stop and cancel spoken audio';
  context.subscriptions.push(barStop);

  // Status Bar: Prev button
  const barPrev = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
  barPrev.command = 'fastTts.prev';
  barPrev.text = '$(chevron-left) Prev Line';
  barPrev.tooltip = 'Skip backward to previous line in current response';
  context.subscriptions.push(barPrev);

  // Status Bar: Next button
  const barNext = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  barNext.command = 'fastTts.next';
  barNext.text = '$(chevron-right) Next Line';
  barNext.tooltip = 'Skip forward to next line in current response';
  context.subscriptions.push(barNext);

  // Status Bar: Settings button
  const barSettings = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  barSettings.command = 'fastTts.settings';
  context.subscriptions.push(barSettings);

  let currentWebview = null;

  function refreshUI() {
    const cfg = player.loadConfig();
    const st = player.loadState();

    if (cfg.enabled !== false) {
      barToggle.text = '$(unmute) Voice: ON';
      barToggle.tooltip = 'Voice speech is ENABLED. Click to permanently stop/mute automated voice.';
      barToggle.backgroundColor = undefined;
    } else {
      barToggle.text = '$(mute) Voice: OFF';
      barToggle.tooltip = 'Voice speech is MUTED. Click to re-enable automated voice.';
      barToggle.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    if (st.isSpeaking) {
      barAction.text = '$(debug-pause) Pause';
      barAction.tooltip = 'Voice is speaking right now. Click to PAUSE speech immediately.';
      barAction.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      barAction.command = 'fastTts.pause';
      if (typeof barStop !== 'undefined') barStop.show();
    } else if (st.isPaused) {
      barAction.text = '$(play) Resume';
      barAction.tooltip = 'Voice is paused. Click to RESUME speech from where it was paused.';
      barAction.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
      barAction.command = 'fastTts.resume';
      if (typeof barStop !== 'undefined') barStop.show();
    } else {
      barAction.text = '$(play) Play';
      barAction.tooltip = 'Click to replay the last spoken assistant response.';
      barAction.backgroundColor = undefined;
      barAction.command = 'fastTts.replayLast';
      if (typeof barStop !== 'undefined') barStop.hide();
    }

    barSettings.text = '$(gear) ' + (cfg.voice || 'Zira') + ' (' + (cfg.rate >= 0 ? '+' : '') + (cfg.rate || 1) + ')';
    barSettings.tooltip = 'Current voice: ' + cfg.voice + ', Speed: ' + cfg.rate + '. Click to change.';

    barToggle.show();
    barAction.show();
    barPrev.show();
    barNext.show();
    barSettings.show();

    if (currentWebview) {
      currentWebview.webview.postMessage({
        type: 'sync',
        config: cfg,
        state: st
      });
    }
  }

  refreshUI();

  // Watch for completed model responses across ALL chats in the IDE!
  function pollTranscriptsForNewResponses() {
    const cfg = player.loadConfig();
    if (cfg.enabled === false) return;

    try {
      if (!fs.existsSync(BRAIN_DIR)) return;
      const dirs = fs.readdirSync(BRAIN_DIR);
      for (const d of dirs) {
        const p = path.join(BRAIN_DIR, d, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          // Only check transcripts updated in the last 2 minutes
          if (Date.now() - stat.mtimeMs > 120000) continue;

          const chunkSize = Math.min(stat.size, 16 * 1024);
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

                    // Check deduplication with lastSpokenContent
                    const clean = obj.content.trim();
                    if (clean !== lastSpokenContent) {
                      lastSpokenContent = clean;
                      player.enqueueSpeech(clean, cfg.voice, cfg.rate);
                      refreshUI();
                    }
                  }
                  break;
                }
              } catch (e) {}
            }
          }
        }
      }
    } catch (e) {}
  }

  const watcherInterval = setInterval(() => {
    refreshUI();
    pollTranscriptsForNewResponses();
  }, 400);

  context.subscriptions.push({ dispose: () => clearInterval(watcherInterval) });

  // Registered Commands
    context.subscriptions.push(vscode.commands.registerCommand('fastTts.pause', () => {
    player.pause();
    vscode.window.showInformationMessage('Spoken audio paused.');
    refreshUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.resume', () => {
    player.resume();
    vscode.window.showInformationMessage('Spoken audio resumed.');
    refreshUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.togglePlayPause', () => {
    const res = player.togglePlayPause();
    if (res === 'PAUSED') vscode.window.showInformationMessage('Spoken audio paused.');
    else if (res === 'RESUMED') vscode.window.showInformationMessage('Spoken audio resumed.');
    refreshUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.stop', () => {
    player.stop();
    vscode.window.showInformationMessage('Spoken audio cancelled.');
    refreshUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.replayLast', () => {
    const cfg = player.loadConfig();
    if (cfg.history && cfg.history.length > 0) {
      let idx = cfg.currentIndex;
      if (typeof idx !== 'number' || idx < 0 || idx >= cfg.history.length) {
        idx = cfg.history.length - 1;
        cfg.currentIndex = idx;
        player.saveConfig(cfg);
      }
      const item = cfg.history[idx];
      vscode.window.showInformationMessage('Replaying: "' + item.text.substring(0, 45) + '..."');
      lastSpokenContent = item.text.trim();
      player.playDirect(item.text, cfg.voice, cfg.rate);
      refreshUI();
    } else {
      vscode.window.showInformationMessage('No speech history available to replay.');
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.togglePermanent', () => {
    const cfg = player.loadConfig();
    cfg.enabled = !cfg.enabled;
    player.saveConfig(cfg);
    if (!cfg.enabled) {
      player.stop();
      vscode.window.showWarningMessage('AI Voice permanently disabled. Incoming chat text will not be spoken.');
    } else {
      vscode.window.showInformationMessage('AI Voice enabled. Incoming chat responses will be spoken aloud.');
    }
    refreshUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.prev', () => {
    const res = player.prevLine();
    if (res && res.text) {
      vscode.window.showInformationMessage('Line (' + (res.index + 1) + '/' + res.total + '): "' + res.text.substring(0, 45) + '..."');
    } else {
      vscode.window.showInformationMessage('Already at the start of current response.');
    }
    refreshUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.next', () => {
    const res = player.nextLine();
    if (res && res.text) {
      vscode.window.showInformationMessage('Line (' + (res.index + 1) + '/' + res.total + '): "' + res.text.substring(0, 45) + '..."');
    } else {
      vscode.window.showInformationMessage('Already at the end of current response.');
    }
    refreshUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastTts.settings', async () => {
    const cfg = player.loadConfig();
    const action = await vscode.window.showQuickPick([
      { label: '$(mic) Change Voice', description: 'Current: ' + cfg.voice, target: 'voice' },
      { label: '$(dashboard) Change Speed', description: 'Current: ' + cfg.rate, target: 'speed' }
    ], { placeHolder: 'Select Voice Setting' });

    if (!action) return;

    if (action.target === 'voice') {
      const v = await vscode.window.showQuickPick([
        { label: 'Zira', description: 'Female US English (Crisp, Natural)' },
        { label: 'David', description: 'Male US English (Deep, Professional)' },
        { label: 'Hazel', description: 'Female UK English (Clear, British)' }
      ], { placeHolder: 'Choose default speaking voice' });
      if (v) {
        cfg.voice = v.label;
        player.saveConfig(cfg);
        refreshUI();
        player.playDirect('Voice changed to ' + v.label, cfg.voice, cfg.rate);
      }
    } else if (action.target === 'speed') {
      const spd = await vscode.window.showQuickPick([
        { label: '-2', description: 'Slow pace' },
        { label: '0', description: 'Normal pace' },
        { label: '+1', description: 'Brisk pace (Default)' },
        { label: '+2', description: 'Fast pace' },
        { label: '+3', description: 'Very fast pace' }
      ], { placeHolder: 'Choose speaking speed rate' });
      if (spd) {
        cfg.rate = parseInt(spd.label.replace('+', ''), 10);
        player.saveConfig(cfg);
        refreshUI();
        player.playDirect('Speed set to ' + spd.label, cfg.voice, cfg.rate);
      }
    }
  }));

  // Sidebar Webview Provider
  const provider = {
    resolveWebviewView(webviewView) {
      currentWebview = webviewView;
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getWebviewContent(player.loadConfig(), player.loadState());

      webviewView.webview.onDidReceiveMessage(message => {
        const cfg = player.loadConfig();
        if (message.command === 'pause') {
          player.pause();
          refreshUI();
        } else if (message.command === 'resume') {
          player.resume();
          refreshUI();
        } else if (message.command === 'togglePlayPause') {
          player.togglePlayPause();
          refreshUI();
        } else if (message.command === 'toggle') {
          vscode.commands.executeCommand('fastTts.togglePermanent');
        } else if (message.command === 'stop') {
          vscode.commands.executeCommand('fastTts.stop');
        } else if (message.command === 'replayLast') {
          vscode.commands.executeCommand('fastTts.replayLast');
        } else if (message.command === 'prev') {
          vscode.commands.executeCommand('fastTts.prev');
        } else if (message.command === 'next') {
          vscode.commands.executeCommand('fastTts.next');
        } else if (message.command === 'setVoice') {
          cfg.voice = message.value;
          player.saveConfig(cfg);
          refreshUI();
          player.playDirect('Voice set to ' + cfg.voice, cfg.voice, cfg.rate);
        } else if (message.command === 'setSpeed') {
          cfg.rate = parseFloat(message.value);
          player.saveConfig(cfg);
          refreshUI();
          player.playDirect('Speed set to ' + cfg.rate, cfg.voice, cfg.rate);
        } else if (message.command === 'replayItem') {
          const item = cfg.history.find(h => h.id === message.id);
          if (item) {
            lastSpokenContent = item.text.trim();
            player.playDirect(item.text, cfg.voice, cfg.rate);
            refreshUI();
          }
        }
      });
    }
  };

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('fastTtsView', provider));
}

function getWebviewContent(cfg, st) {
  const isEnabled = cfg.enabled !== false;
  const isSpeaking = st && st.isSpeaking;
  const isPaused = st && st.isPaused;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      padding: 12px;
      margin: 0;
      background: var(--vscode-sideBar-background);
    }
    .panel-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .status-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      background: ${!isEnabled ? '#dc2626' : isPaused ? '#3b82f6' : isSpeaking ? '#eab308' : '#16a34a'};
      color: #fff;
    }
    .btn-toggle {
      width: 100%;
      padding: 8px;
      font-weight: 600;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      background: ${isEnabled ? '#dc2626' : '#2563eb'};
      color: #fff;
      margin-bottom: 8px;
    }
    .btn-toggle:hover {
      opacity: 0.9;
    }
    .controls-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin-bottom: 8px;
    }
    .btn-ctrl {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 8px 4px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
    }
    .btn-ctrl:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-main-action {
      width: 100%;
      padding: 8px;
      font-weight: 600;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-size: 12px;
      background: ${isSpeaking ? '#eab308' : isPaused ? '#16a34a' : '#2563eb'};
      color: #fff;
      margin-bottom: 6px;
    }
    .field-group {
      margin-bottom: 10px;
    }
    label {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    select, input[type="range"] {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      padding: 4px;
    }
    .history-title {
      font-size: 12px;
      font-weight: 600;
      margin: 12px 0 6px;
      color: var(--vscode-descriptionForeground);
    }
    .history-item {
      background: var(--vscode-list-hoverBackground);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 6px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .history-item:hover {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .history-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 190px;
    }
  </style>
</head>
<body>
  <div class="panel-card">
    <div class="status-header">
      <span style="font-weight:600;">AI Voice Assistant</span>
      <span id="badge" class="status-badge">${!isEnabled ? 'MUTED' : isPaused ? 'PAUSED' : isSpeaking ? 'SPEAKING' : 'READY'}</span>
    </div>
    <button id="btnToggle" class="btn-toggle" onclick="send('toggle')">
      ${isEnabled ? 'Permanently Stop Voice' : 'Re-Enable Voice'}
    </button>
    <button id="btnMainAction" class="btn-main-action" onclick="send('${isSpeaking ? 'pause' : isPaused ? 'resume' : 'replayLast'}')">
      ${isSpeaking ? 'Pause Currently Speaking' : isPaused ? 'Resume Speech' : 'Replay Last Response'}
    </button>
    <div class="controls-grid">
      <button class="btn-ctrl" onclick="send('prev')" title="Previous line in current response">Prev Line</button>
      <button class="btn-ctrl" onclick="send('stop')" title="Stop now">Stop</button>
      <button class="btn-ctrl" onclick="send('next')" title="Next line in current response">Next Line</button>
    </div>
  </div>

  <div class="panel-card">
    <div class="field-group">
      <label for="voiceSelect">Voice Style:</label>
      <select id="voiceSelect" onchange="send('setVoice', this.value)">
        <option value="Zira" ${cfg.voice === 'Zira' ? 'selected' : ''}>Zira (Female US)</option>
        <option value="David" ${cfg.voice === 'David' ? 'selected' : ''}>David (Male US)</option>
        <option value="Hazel" ${cfg.voice === 'Hazel' ? 'selected' : ''}>Hazel (Female UK)</option>
      </select>
    </div>

    <div class="field-group">
      <label for="speedRange">Speaking Speed: <span id="speedVal">${cfg.rate || 1}</span></label>
      <input type="range" id="speedRange" min="-5" max="5" value="${cfg.rate || 1}" oninput="document.getElementById('speedVal').innerText = this.value" onchange="send('setSpeed', this.value)">
    </div>
  </div>

  <div class="history-title">Recent Voice History</div>
  <div id="historyList">
    ${(cfg.history || []).slice().reverse().slice(0, 8).map(h => `
      <div class="history-item" onclick="send('replayItem', ${h.id})" title="Click to replay">
        <span class="history-text">${h.text}</span>
        <span>&#9658;</span>
      </div>
    `).join('') || '<div style="font-size:11px;color:gray;">No speech history yet.</div>'}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function send(cmd, val) {
      vscode.postMessage({ command: cmd, value: val, id: typeof val === 'number' ? val : undefined });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'sync') {
        const c = msg.config;
        const s = msg.state;
        const enabled = c.enabled !== false;
        const speaking = s && s.isSpeaking;

        const badge = document.getElementById('badge');
        if (badge) {
          badge.innerText = !enabled ? 'MUTED' : speaking ? 'SPEAKING' : 'READY';
          badge.style.background = !enabled ? '#dc2626' : speaking ? '#eab308' : '#16a34a';
        }

        const btnToggle = document.getElementById('btnToggle');
        if (btnToggle) {
          btnToggle.innerText = enabled ? 'Permanently Stop Voice' : 'Re-Enable Voice';
          btnToggle.style.background = enabled ? '#dc2626' : '#2563eb';
        }

        const btnMain = document.getElementById('btnMainAction');
        if (btnMain) {
          btnMain.innerText = speaking ? 'Stop Currently Speaking' : 'Replay Last Response';
          btnMain.style.background = speaking ? '#b91c1c' : '#2563eb';
          btnMain.onclick = () => send(speaking ? 'stop' : 'replayLast');
        }

        const voiceSelect = document.getElementById('voiceSelect');
        if (voiceSelect && c.voice) voiceSelect.value = c.voice;

        const speedRange = document.getElementById('speedRange');
        const speedVal = document.getElementById('speedVal');
        // Only update slider if user is NOT currently dragging (focused) it
        if (speedRange && c.rate !== undefined && document.activeElement !== speedRange) {
          speedRange.value = c.rate;
          if (speedVal) speedVal.innerText = c.rate;
        }
      }
    });
  </script>
</body>
</html>`;
}

function deactivate() {
  player.stop();
}

module.exports = {
  activate,
  deactivate
};
