const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function registerCompactReader({ origin, data, preload, getMainWindow }) {
  let reader = null;
  let readerReady = false, hiddenByShortcut = false, visibilitySequence = 0, lastToggle = 0, recordingShortcut = false;
  let returnPath = '/library';
  const preferenceFile = path.join(data, 'compact-reader.json');
  const boundsFile = path.join(data, 'compact-window.json');
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const write = (file, value) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const number = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const preferences = (value = {}) => {
    const positions = Object.fromEntries(Object.entries(value.positions || {}).slice(-300).filter(([key, anchor]) =>
      /^[\w-]+:[\w-]+$/.test(key) && key.length < 240 && anchor && typeof anchor.paragraphId === 'string' && /^[\w-]+$/.test(anchor.paragraphId) && anchor.paragraphId.length < 120 && Number.isInteger(anchor.offset) && anchor.offset >= 0
    ).map(([key, anchor]) => [key, { paragraphId: anchor.paragraphId, offset: anchor.offset }]));
    return {
      width: number(value.width, 600, 320, 1200), fontSize: number(value.fontSize, 14, 12, 20),
      backgroundTransparency: number(value.backgroundTransparency, 0, 0, 100),
      x: number(value.x, 80, 0, 10000), y: number(value.y, 100, 0, 10000), positions,
      continuous: value.continuous === true, coverOnBlur: value.coverOnBlur === true,
      covered: value.covered === true, alwaysOnTop: value.alwaysOnTop === true,
    };
  };
  const check = (event, onlyReader = false) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin || event.senderFrame !== event.sender.mainFrame
      || onlyReader && event.sender !== reader?.webContents
      || !onlyReader && event.sender !== reader?.webContents && event.sender !== getMainWindow()?.webContents) throw new Error('Invalid reader origin');
  };
  const validPath = (value, compact) => {
    if (typeof value !== 'string' || value.length > 1000) throw new Error('无效的阅读位置');
    const url = new URL(value, origin);
    const pattern = compact ? /^\/compact\/books\/[\w-]+\/(chapters|units)\/[\w-]+$/ : /^\/books\/[\w-]+\/(chapters|units)\/[\w-]+$/;
    if (url.origin !== origin || !value.startsWith('/') || !pattern.test(url.pathname) || url.hash && !/^#paragraph-[\w-]+$/.test(url.hash)) throw new Error('无效的阅读路径');
    for (const [key, val] of url.searchParams) {
      if (key === 'paragraph' ? !/^[\w-]+$/.test(val) : key === 'offset' ? !/^\d+$/.test(val) : true) throw new Error('无效的阅读参数');
    }
    return url.pathname + url.search + url.hash;
  };
  const fit = (bounds) => {
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(Math.round(bounds.width), area.width);
    const height = Math.min(Math.round(bounds.height), area.height);
    return { width, height, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))) };
  };
  const restore = () => {
    const main = getMainWindow();
    if (main && !main.isDestroyed() && !app.isQuitting) { main.webContents.send('compact-return', returnPath); main.show(); main.focus(); }
  };
  const showReader = () => {
    if (!reader || reader.isDestroyed() || !readerReady || app.isQuitting) return;
    hiddenByShortcut = false;
    if (reader.isMinimized()) reader.restore();
    reader.setBounds(fit(reader.getBounds()));
    reader.webContents.send('compact-visibility', { hidden: false, sequence: ++visibilitySequence });
    reader.showInactive();
    reader.moveTop();
  };
  const toggleReader = () => {
    if (!reader || reader.isDestroyed() || !readerReady || app.isQuitting || recordingShortcut && reader.isFocused() || Date.now() - lastToggle < 250) return;
    lastToggle = Date.now();
    if (reader.isVisible() && !reader.isMinimized()) {
      hiddenByShortcut = true;
      reader.webContents.setAudioMuted(true);
      reader.webContents.send('compact-visibility', { hidden: true, sequence: ++visibilitySequence });
      reader.hide();
    } else showReader();
  };
  const shortcut = require('./compact-shortcut.cjs').createCompactShortcut({ data, onToggle: toggleReader });
  app.on('will-quit', () => shortcut.deactivate());
  app.on('activate', () => { if (hiddenByShortcut) showReader(); });
  ipcMain.handle('get-compact-shortcut', (event) => { check(event); return shortcut.status(); });
  ipcMain.handle('save-compact-shortcut', (event, value) => { check(event, true); return shortcut.save(value); });
  ipcMain.handle('toggle-compact-reader', (event) => { check(event, true); toggleReader(); });
  ipcMain.handle('set-compact-shortcut-recording', (event, value) => { check(event, true); recordingShortcut = value === true; });
  ipcMain.on('compact-visibility-applied', (event, sequence) => {
    try { check(event, true); } catch { return; }
    if (!hiddenByShortcut && sequence === visibilitySequence && reader && !reader.isDestroyed()) reader.webContents.setAudioMuted(false);
  });
  ipcMain.handle('get-compact-preferences', (event) => { check(event); return preferences(read(preferenceFile) || {}); });
  ipcMain.handle('save-compact-preferences', (event, value) => {
    check(event, true);
    if (!value || typeof value !== 'object' || JSON.stringify(value).length > 100000) throw new Error('无效的阅读偏好');
    write(preferenceFile, preferences(value));
  });
  ipcMain.handle('open-compact-reader', async (event, value) => {
    check(event);
    const route = validPath(value, true);
    returnPath = route.replace('/compact', '').split('?')[0];
    if (reader && !reader.isDestroyed()) { readerReady = false; await reader.loadURL(origin + route); readerReady = true; showReader(); reader.focus(); getMainWindow()?.hide(); return; }
    const prefs = preferences(read(preferenceFile) || {});
    const old = read(boundsFile) || { x: 80, y: 100 };
    const bounds = fit({ x: number(old.x, 80, -50000, 50000), y: number(old.y, 100, -50000, 50000), width: prefs.width, height: Math.max(36, Math.ceil(prefs.fontSize * 1.5 + 12)) });
    const instance = new BrowserWindow({ ...bounds, useContentSize: true, minWidth: 240, minHeight: 30, frame: false, resizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: prefs.alwaysOnTop, title: '资料', backgroundColor: '#00000000', transparent: true, hasShadow: false, show: false,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    reader = instance;
    instance.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    instance.webContents.on('will-navigate', (event, url) => { try { validPath(url.replace(origin, ''), true); } catch { event.preventDefault(); } });
    instance.on('page-title-updated', (event) => { event.preventDefault(); instance.setTitle('资料'); });
    let saveTimer;
    const saveBounds = () => { if (!instance.isDestroyed()) { const rect = instance.getBounds(); write(boundsFile, { x: rect.x, y: rect.y }); } };
    instance.on('move', () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 180); });
    instance.on('close', () => { clearTimeout(saveTimer); saveBounds(); });
    instance.on('closed', () => { if (reader === instance) { reader = null; readerReady = false; hiddenByShortcut = false; recordingShortcut = false; shortcut.deactivate(); } restore(); });
    try { await instance.loadURL(origin + route); readerReady = true; hiddenByShortcut = false; shortcut.activate(); instance.show(); instance.focus(); getMainWindow()?.hide(); }
    catch (error) { instance.close(); throw error; }
  });
  ipcMain.handle('set-compact-window', (event, options) => {
    check(event, true);
    const route = validPath(options.returnPath, false);
    const bounds = reader.getBounds();
    reader.setBounds(fit({ ...bounds, width: number(options.width, 600, 320, 1200), height: number(options.height, 36, 36, 520) }));
    reader.setAlwaysOnTop(options.alwaysOnTop === true);
    returnPath = route;
  });
  ipcMain.handle('close-compact-reader', (event, value) => { check(event, true); returnPath = validPath(value, false); reader.close(); });
  const keepVisible = () => { if (reader && !reader.isDestroyed()) reader.setBounds(fit(reader.getBounds())); };
  screen.on('display-removed', keepVisible);
  screen.on('display-metrics-changed', keepVisible);
}
module.exports = { registerCompactReader };
