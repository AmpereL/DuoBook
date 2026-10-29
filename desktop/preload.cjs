const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('duobookDesktop', {
  saveReadingPosition: (bookId, position) => ipcRenderer.invoke('save-reading-position', bookId, position),
  onFlushReadingPosition: (callback) => {
    const handler = async (_event, id) => { try { await callback(); } finally { ipcRenderer.send('reading-position-flushed', id); } };
    ipcRenderer.on('flush-reading-position', handler);
    return () => ipcRenderer.removeListener('flush-reading-position', handler);
  },
  openCompactReader: (path) => ipcRenderer.invoke('open-compact-reader', path),
  getCompactShortcut: () => ipcRenderer.invoke('get-compact-shortcut'),
  saveCompactShortcut: (value) => ipcRenderer.invoke('save-compact-shortcut', value),
  toggleCompactReader: () => ipcRenderer.invoke('toggle-compact-reader'),
  setCompactShortcutRecording: (active) => ipcRenderer.invoke('set-compact-shortcut-recording', active),
  onCompactVisibility: (callback) => {
    const handler = async (_event, value) => { try { await callback(value.hidden); } finally { ipcRenderer.send('compact-visibility-applied', value.sequence); } };
    ipcRenderer.on('compact-visibility', handler);
    return () => ipcRenderer.removeListener('compact-visibility', handler);
  },
  closeCompactReader: (path) => ipcRenderer.invoke('close-compact-reader', path),
  setCompactWindow: (options) => ipcRenderer.invoke('set-compact-window', options),
  getCompactPreferences: () => ipcRenderer.invoke('get-compact-preferences'),
  saveCompactPreferences: (preferences) => ipcRenderer.invoke('save-compact-preferences', preferences),
  onCompactReturn: (callback) => {
    const handler = (_event, path) => callback(path);
    ipcRenderer.on('compact-return', handler);
    return () => ipcRenderer.removeListener('compact-return', handler);
  },
  saveModel: (config) => ipcRenderer.invoke('save-model', config),
  getSpeechSettings: () => ipcRenderer.invoke('get-speech-settings'),
  saveSpeechSettings: (settings) => ipcRenderer.invoke('save-speech-settings', settings),
  saveSpeechConfiguration: (configuration) => ipcRenderer.invoke('save-speech-configuration', configuration),
  getAppIcon: () => ipcRenderer.invoke('get-app-icon'),
  setAppIcon: (id) => ipcRenderer.invoke('set-app-icon', id),
});
