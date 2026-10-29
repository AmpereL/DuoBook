const { BrowserWindow, ipcMain } = require('electron');

function registerReadingProgress({ origin, token }) {
  const pending = new Set();
  const acknowledgements = new Map();
  let sequence = 0;
  const trusted = (event) => event.senderFrame && event.senderFrame === event.sender.mainFrame && new URL(event.senderFrame.url).origin === origin;
  ipcMain.handle('save-reading-position', async (event, bookId, position) => {
    if (!trusted(event) || typeof bookId !== 'string' || !/^[\w-]+$/.test(bookId) || !position || JSON.stringify(position).length > 10000) throw new Error('Invalid reading position');
    const job = fetch(`${origin}/api/v1/books/${bookId}/reading-position`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-duobook-token': token },
      body: JSON.stringify(position), signal: AbortSignal.timeout(2500),
    }).then(async (response) => { if (!response.ok) throw new Error('Reading position was not saved'); return response.json(); });
    pending.add(job);
    try { return await job; } finally { pending.delete(job); }
  });
  ipcMain.on('reading-position-flushed', (event, id) => {
    const item = acknowledgements.get(id);
    if (item && item.sender === event.sender.id && trusted(event)) item.finish();
  });
  return async () => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && window.webContents.getURL().startsWith(origin + '/'));
    await Promise.all(windows.map((window) => new Promise((resolve) => {
      const id = ++sequence;
      const finish = () => { clearTimeout(timer); acknowledgements.delete(id); resolve(); };
      const timer = setTimeout(finish, 1800);
      acknowledgements.set(id, { sender: window.webContents.id, finish });
      window.webContents.send('flush-reading-position', id);
    })));
    await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => setTimeout(resolve, 2600))]);
  };
}
module.exports = { registerReadingProgress };
