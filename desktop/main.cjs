const { app, BrowserWindow, session, ipcMain, safeStorage, dialog, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

app.setName('逻辑阅读');
// Keep the existing userData directory so renaming the app preserves books and notes.
app.setPath('userData', path.join(app.getPath('appData'), 'DuoBook'));

let backend, window, origin, secretFile, saved;
let flushReadingProgress = async () => {};
let finishingQuit = false, flushingQuit = false;
const token = randomBytes(32).toString('hex');
const defaults = { provider: 'local', base_url: '', model: '', timeout: 300, api_key: '' };
if (process.env.DUOBOOK_SMOKE_DIR) app.setPath('userData', process.env.DUOBOOK_SMOKE_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    app.isQuitting = true;
    if (finishingQuit) { backend?.kill('SIGTERM'); return; }
    event.preventDefault();
    if (flushingQuit) return;
    flushingQuit = true;
    void flushReadingProgress().finally(() => { finishingQuit = true; app.quit(); });
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('逻辑阅读启动失败', error.message);
    app.quit();
  });
}

async function start() {
  const data = app.getPath('userData');
  fs.mkdirSync(data, { recursive: true });
  secretFile = path.join(data, 'model.enc');
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'build', 'desktop');
  const iconPreferenceFile = path.join(data, 'icon-preference.json');
  const validIcon = (id) => Number.isInteger(id) && id >= 1 && id <= 4;
  let currentIcon = 2;
  try {
    const savedIcon = JSON.parse(fs.readFileSync(iconPreferenceFile, 'utf8')).icon;
    if (validIcon(savedIcon)) currentIcon = savedIcon;
  } catch { /* No saved preference: use icon 2. */ }
  const applyIcon = (id) => {
    if (!validIcon(id)) throw new Error('无效的图标编号');
    if (process.platform === 'darwin') {
      const icon = nativeImage.createFromPath(path.join(resources, 'web', 'icons', `app-icon-${id}.png`));
      if (icon.isEmpty()) throw new Error('找不到所选应用图标');
      app.dock.setIcon(icon);
    }
    currentIcon = id;
  };
  applyIcon(currentIcon);
  const bundledDefaults = path.join(resources, 'private-defaults.json');
  const initial = fs.existsSync(bundledDefaults) ? JSON.parse(fs.readFileSync(bundledDefaults, 'utf8')) : defaults;
  saved = fs.existsSync(secretFile) ? JSON.parse(safeStorage.decryptString(fs.readFileSync(secretFile))) : initial;
  const speechSecretFile = path.join(data, 'speech.enc');
  const bundledSpeechDefaults = path.join(resources, 'private-speech-defaults.json');
  let savedSpeech = fs.existsSync(speechSecretFile)
    ? JSON.parse(safeStorage.decryptString(fs.readFileSync(speechSecretFile)))
    : fs.existsSync(bundledSpeechDefaults) ? JSON.parse(fs.readFileSync(bundledSpeechDefaults, 'utf8')) : null;
  const executable = path.join(resources, 'backend', 'duobook-api');
  const env = { ...process.env, DUOBOOK_DB: path.join(data, 'duobook.db'), DUOBOOK_UPLOAD_DIR: path.join(data, 'uploads'),
    DUOBOOK_APP_VERSION: app.getVersion(),
    DUOBOOK_WEB_DIR: path.join(resources, 'web'), DUOBOOK_DESKTOP_TOKEN: token,
    DUOBOOK_LLM_PROVIDER: saved.provider, DUOBOOK_LLM_BASE_URL: saved.base_url,
    DUOBOOK_LLM_MODEL: saved.model, DUOBOOK_LLM_API_KEY: saved.api_key || '', DUOBOOK_LLM_TIMEOUT_SECONDS: String(saved.timeout) };
  // Desktop credentials come from explicit per-user settings, never a build shell.
  for (const name of Object.keys(env)) if (name.startsWith('DUOBOOK_TTS_')) delete env[name];
  if (savedSpeech?.api_key) Object.assign(env, {
    DUOBOOK_TTS_BASE_URL: savedSpeech.base_url, DUOBOOK_TTS_API_KEY: savedSpeech.api_key,
    DUOBOOK_TTS_TIMEOUT: String(savedSpeech.timeout || 120),
  });
  backend = spawn(executable, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stderr.on('data', () => {}); // Do not persist book text or credentials in logs.
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('本地阅读服务启动超时')), 60000);
    backend.once('error', (e) => { clearTimeout(timer); reject(e); });
    backend.once('exit', () => { clearTimeout(timer); reject(new Error('本地阅读服务意外退出')); });
    backend.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DUOBOOK_PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/v1/health`, { headers: { 'x-duobook-token': token } })).ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('本地服务未通过健康检查');
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'x-duobook-token': token } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ipcMain.handle('save-model', async (event, config) => {
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid origin');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，设置未持久保存');
    const next = { provider: config.provider, base_url: config.base_url, model: config.model, timeout: config.timeout,
      api_key: config.api_key === undefined ? saved.api_key : config.api_key };
    const temp = `${secretFile}.tmp`;
    fs.writeFileSync(temp, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
    fs.renameSync(temp, secretFile);
    saved = next;
  });
  ipcMain.handle('save-speech-configuration', (event, config) => {
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid origin');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，语音设置未持久保存');
    const url = new URL(config.base_url);
    const hosts = ['api.xiaomimimo.com', ...['cn', 'sgp', 'ams'].map((region) => `token-plan-${region}.xiaomimimo.com`)];
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port && url.port !== '443') throw new Error('无效的 MiMo 语音地址');
    if (!Number.isFinite(config.timeout) || config.timeout < 5 || config.timeout > 300) throw new Error('无效的语音超时设置');
    const key = config.api_key === undefined ? savedSpeech?.api_key || saved.api_key : config.api_key.trim();
    if (typeof key !== 'string' || !key) throw new Error('缺少语音 Key');
    const next = { base_url: `${url.origin}/v1`, api_key: key, timeout: config.timeout };
    fs.writeFileSync(`${speechSecretFile}.tmp`, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
    fs.renameSync(`${speechSecretFile}.tmp`, speechSecretFile);
    savedSpeech = next;
  });
  ipcMain.handle('get-app-icon', (event) => {
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid origin');
    return currentIcon;
  });
  ipcMain.handle('set-app-icon', (event, id) => {
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid origin');
    applyIcon(id);
    const temp = `${iconPreferenceFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ icon: id }), { mode: 0o600 });
    fs.renameSync(temp, iconPreferenceFile);
  });
  const speechPreferenceFile = path.join(data, 'speech-preference.json');
  const validSpeechSettings = (settings) => settings && ['local', 'mimo'].includes(settings.provider)
    && typeof settings.localVoice === 'string' && settings.localVoice.length <= 500
    && ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'].includes(settings.mimoVoice)
    && Number.isFinite(settings.rate) && settings.rate >= 0.5 && settings.rate <= 2
    && ['low', 'natural', 'bright'].includes(settings.tone);
  ipcMain.handle('get-speech-settings', (event) => {
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid origin');
    try {
      const settings = JSON.parse(fs.readFileSync(speechPreferenceFile, 'utf8'));
      return validSpeechSettings(settings) ? settings : null;
    } catch { return null; }
  });
  ipcMain.handle('save-speech-settings', (event, settings) => {
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid origin');
    if (!validSpeechSettings(settings)) throw new Error('无效的语音设置');
    const value = { provider: settings.provider, localVoice: settings.localVoice, mimoVoice: settings.mimoVoice, rate: settings.rate, tone: settings.tone };
    fs.writeFileSync(`${speechPreferenceFile}.tmp`, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(`${speechPreferenceFile}.tmp`, speechPreferenceFile);
  });
  flushReadingProgress = require('./reading-progress.cjs').registerReadingProgress({ origin, token });
  require('./compact-reader.cjs').registerCompactReader({ origin, data, preload: path.join(__dirname, 'preload.cjs'), getMainWindow: () => window });
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 760, minHeight: 600, title: '逻辑阅读', backgroundColor: '#f6f5ef',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  await window.loadURL(origin);
  backend.on('exit', () => { if (!app.isQuitting) app.quit(); });
  if (process.env.DUOBOOK_SMOKE_AUTORUN === '1') {
    const report = await window.webContents.executeJavaScript(`(async () => {
      const health = await (await fetch('/api/v1/health')).json();
      const books = await (await fetch('/api/v1/books')).json();
      const settings = await (await fetch('/api/v1/settings/model')).json();
      return { health, books: books.items.length, settings, title: document.title };
    })()`);
    fs.writeFileSync(path.join(data, 'smoke-result.json'), JSON.stringify(report));
    app.quit();
  }
}
