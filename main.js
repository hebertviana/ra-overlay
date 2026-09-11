const { app, BrowserWindow, ipcMain, globalShortcut, screen, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createBackup, classify } = require('./backup');

const API = 'https://retroachievements.org/API';
const MIN_INTERVAL = 10; // segundos. Nao baixe disso, a API do RA e compartilhada.

let overlayWin = null;
let settingsWin = null;
let pollTimer = null;
let locked = true;          // true = clique atravessa a janela
let lastGameId = null;
let lastPayload = null;
let lastPollAt = 0;         // referencia para saber se o cartao foi regravado desde o ultimo ciclo

// Estado do detector de desbloqueio: qual jogo estamos observando e quais
// conquistas ja estavam ganhas no ciclo anterior.
let watchedGameId = null;
let earnedIds = new Set();
let seeded = false;         // o primeiro ciclo de um jogo so registra a base

// ---------------------------------------------------------------- config

const configPath = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
  username: '',
  apiKey: '',
  gameMode: 'auto',        // 'auto' segue o jogo aberto | 'manual' fixa um ID
  manualGameId: '',
  intervalSec: 15,
  hardcore: true,

  filter: 'locked',        // 'all' | 'locked' | 'unlocked'
  onlyIds: '',             // lista de IDs separada por virgula, tem prioridade
  typeFilter: 'any',       // 'any' | 'progression' | 'missable'
  sort: 'default',         // 'default' | 'points' | 'rarity' | 'recent'
  maxItems: 5,

  backupEnabled: false,
  mcdPath: '',
  backupKeep: 0,           // 0 = guardar tudo
  backupOnGameStart: true,
  backupWaitSec: 40,       // quanto esperar o cartao ser regravado antes de compactar

  showBadges: true,
  showDescription: true,
  showProgressBar: true,
  compact: false,
  scale: 100,
  opacity: 90,
  width: 380,
  x: 40,
  y: 40
};

let config = { ...DEFAULTS };

// A chave de API e sensivel: no disco ela fica cifrada com o safeStorage do
// Electron (DPAPI no Windows), que so decifra sob a mesma conta do SO que
// gravou. Em memoria continua em texto puro, que e como o resto do app usa.
function loadConfig() {
  try {
    const raw = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
    const wasPlainText = !raw.apiKeyEnc && !!raw.apiKey;
    if (raw.apiKeyEnc) {
      try {
        raw.apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
      } catch {
        raw.apiKey = ''; // cifrado em outra maquina/conta: pede pra reinserir
      }
      delete raw.apiKeyEnc;
    }
    config = raw;
    if (wasPlainText) saveConfig(); // migra config antigo pra versao cifrada na hora
  } catch {
    config = { ...DEFAULTS };
  }
}

function saveConfig() {
  try {
    const toWrite = { ...config };
    if (toWrite.apiKey && safeStorage.isEncryptionAvailable()) {
      toWrite.apiKeyEnc = safeStorage.encryptString(toWrite.apiKey).toString('base64');
      delete toWrite.apiKey;
    }
    fs.writeFileSync(configPath(), JSON.stringify(toWrite, null, 2));
  } catch (e) {
    console.error('Nao foi possivel gravar a configuracao:', e.message);
  }
}

// ---------------------------------------------------------------- API RA

async function raGet(endpoint, params) {
  const qs = new URLSearchParams({ y: config.apiKey, ...params });
  const res = await fetch(`${API}/${endpoint}?${qs}`, {
    headers: { 'User-Agent': 'ra-overlay/1.0 (uso pessoal)' }
  });
  if (!res.ok) throw new Error(`${endpoint} respondeu ${res.status}`);
  return res.json();
}

async function resolveGameId() {
  if (config.gameMode === 'manual') {
    const id = parseInt(config.manualGameId, 10);
    return Number.isFinite(id) ? id : null;
  }
  const profile = await raGet('API_GetUserProfile.php', { u: config.username });
  return profile.LastGameID || null;
}

function isEarned(ach) {
  return config.hardcore ? !!ach.DateEarnedHardcore : !!(ach.DateEarned || ach.DateEarnedHardcore);
}

function applyFilters(list) {
  let out = list;

  const ids = config.onlyIds
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(Number.isFinite);

  if (ids.length) {
    // Selecao manual manda: devolve exatamente essas conquistas, na ordem digitada.
    const byId = new Map(out.map(a => [a.ID, a]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  }

  if (config.filter === 'locked') out = out.filter(a => !isEarned(a));
  else if (config.filter === 'unlocked') out = out.filter(a => isEarned(a));

  if (config.typeFilter === 'progression') {
    out = out.filter(a => a.type === 'progression' || a.type === 'win_condition');
  } else if (config.typeFilter === 'missable') {
    out = out.filter(a => a.type === 'missable');
  }

  const sorters = {
    points: (a, b) => a.Points - b.Points,
    rarity: (a, b) => a.NumAwarded - b.NumAwarded,
    recent: (a, b) => new Date(b.DateEarned || 0) - new Date(a.DateEarned || 0),
    default: (a, b) => a.DisplayOrder - b.DisplayOrder
  };
  out = [...out].sort(sorters[config.sort] || sorters.default);

  return out.slice(0, Math.max(1, config.maxItems));
}

async function runBackup(gameId, gameTitle, achievement, alsoUnlocked, since = 0) {
  try {
    const r = await createBackup({
      mcdPath: config.mcdPath,
      gameId,
      gameTitle,
      achievement,
      alsoUnlocked,
      keep: Number(config.backupKeep) || 0,
      since,
      waitTimeoutMs: Math.max(1, Number(config.backupWaitSec) || 40) * 1000
    });
    notify(r.fresh
      ? `Memory card salvo — ${r.name}`
      : `Memory card salvo (save ainda não atualizado?) — ${r.name}`, !r.fresh);
    return r;
  } catch (e) {
    notify(`Backup falhou: ${e.message}`, true);
    throw e;
  }
}

/**
 * Compara o conjunto de conquistas ganhas com o do ciclo anterior.
 * O primeiro ciclo de cada jogo apenas registra a base, senao abriria o
 * emulador e imediatamente geraria um backup por conquista ja existente.
 */
async function detectUnlocks(gameId, data, all, since) {
  const r = classify({ gameId: watchedGameId, earned: earnedIds, seeded }, gameId, all, isEarned);

  watchedGameId = gameId;
  earnedIds = r.earned;
  seeded = true;

  if (!config.backupEnabled) return;

  if (r.action === 'newGame') {
    if (config.backupOnGameStart) await runBackup(gameId, data.Title, null, 0, since).catch(() => {});
    return;
  }
  if (r.action !== 'unlock') return;

  // Varias conquistas podem cair no mesmo ciclo. O cartao e o mesmo nos dois
  // casos, entao geramos um arquivo so, nomeado pela de maior pontuacao.
  const main = r.unlocked[0];
  await runBackup(gameId, data.Title, {
    id: main.ID,
    title: main.Title,
    points: main.Points,
    description: main.Description
  }, r.unlocked.length - 1, since).catch(() => {});
}

async function poll() {
  if (!config.username || !config.apiKey) {
    return send({ error: 'Informe seu usuário e a chave de API nas configurações.' });
  }

  // Referencia para o backup: uma gravacao no cartao depois deste instante
  // (o inicio do ciclo anterior) conta como "fresca" para a conquista atual.
  const since = lastPollAt;
  lastPollAt = Date.now();

  try {
    const gameId = await resolveGameId();
    if (!gameId) {
      return send({ error: 'Nenhum jogo detectado. Abra um jogo com suporte a conquistas.' });
    }
    lastGameId = gameId;

    const data = await raGet('API_GetGameInfoAndUserProgress.php', {
      u: config.username,
      g: gameId
    });

    const all = Object.values(data.Achievements || {});
    const total = all.length;
    const earned = all.filter(isEarned).length;

    await detectUnlocks(gameId, data, all, since);

    lastPayload = {
      game: data.Title,
      console: data.ConsoleName,
      icon: data.ImageIcon ? `https://media.retroachievements.org${data.ImageIcon}` : null,
      earned,
      total,
      points: all.filter(isEarned).reduce((s, a) => s + (a.Points || 0), 0),
      totalPoints: all.reduce((s, a) => s + (a.Points || 0), 0),
      items: applyFilters(all).map(a => ({
        id: a.ID,
        title: a.Title,
        description: a.Description,
        points: a.Points,
        badge: a.BadgeName,
        type: a.type,
        rarity: data.NumDistinctPlayers
          ? Math.round((a.NumAwarded / data.NumDistinctPlayers) * 100)
          : null,
        earned: isEarned(a)
      }))
    };
    send(lastPayload);
  } catch (e) {
    send({ error: e.message });
  }
}

function send(payload) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('data', { ...payload, config, locked });
  }
}

// Mostra uma linha temporaria no overlay e na janela de configuracoes.
function notify(text, isError = false) {
  const msg = { text, isError, at: Date.now() };
  for (const w of [overlayWin, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('toast', msg);
  }
  console.log(isError ? 'ERRO:' : '', text);
}

function restartPolling() {
  clearInterval(pollTimer);
  const secs = Math.max(MIN_INTERVAL, Number(config.intervalSec) || 15);
  pollTimer = setInterval(poll, secs * 1000);
  poll();
}

// ---------------------------------------------------------------- janelas

function createOverlay() {
  overlayWin = new BrowserWindow({
    x: config.x,
    y: config.y,
    width: config.width,
    height: 200,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile('overlay.html');
  applyLock();

  overlayWin.on('moved', () => {
    const [x, y] = overlayWin.getPosition();
    config.x = x;
    config.y = y;
    saveConfig();
  });
}

function applyLock() {
  if (!overlayWin) return;
  overlayWin.setIgnoreMouseEvents(locked, { forward: true });
  send(lastPayload || {});
}

function toggleLock() {
  locked = !locked;
  applyLock();
  if (!locked) overlayWin.focus();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'RA Overlay',
    backgroundColor: '#14161c',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile('settings.html');
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('get-config', () => config);

ipcMain.handle('set-config', (_e, patch) => {
  config = { ...config, ...patch };
  saveConfig();
  if (overlayWin) {
    const b = overlayWin.getBounds();
    overlayWin.setBounds({ ...b, width: Math.round(config.width) });
  }
  restartPolling();
  return config;
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(settingsWin, {
    title: 'Selecione a pasta dos memory cards',
    properties: ['openDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('backup-now', async () => {
  const r = await runBackup(lastGameId, lastPayload?.game, null, 0);
  return r.name;
});

ipcMain.handle('open-backups', () => {
  if (!config.mcdPath) return;
  const dir = path.join(config.mcdPath, 'backups', String(lastGameId || ''));
  shell.openPath(fs.existsSync(dir) ? dir : path.join(config.mcdPath, 'backups'));
});

ipcMain.handle('open-settings', openSettings);
ipcMain.handle('toggle-lock', toggleLock);
ipcMain.handle('refresh', poll);

// O renderer mede a altura do conteudo e a janela se ajusta a ela.
ipcMain.on('content-height', (_e, h) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  const wanted = Math.min(Math.max(Math.ceil(h), 60), screen.getPrimaryDisplay().workAreaSize.height);
  if (Math.abs(b.height - wanted) > 2) overlayWin.setBounds({ ...b, height: wanted });
});

// ---------------------------------------------------------------- ciclo

app.whenReady().then(() => {
  loadConfig();
  createOverlay();
  if (!config.username || !config.apiKey) openSettings();

  globalShortcut.register('Control+Alt+O', toggleLock);
  globalShortcut.register('Control+Alt+P', openSettings);
  globalShortcut.register('Control+Alt+R', poll);
  globalShortcut.register('Control+Alt+B', () => {
    runBackup(lastGameId, lastPayload?.game, null, 0).catch(() => {});
  });
  globalShortcut.register('Control+Alt+Q', () => app.quit());

  restartPolling();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
