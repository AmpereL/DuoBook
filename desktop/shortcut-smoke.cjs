const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-reading-shortcut-'));
  const executablePath = process.env.DUOBOOK_SMOKE_EXECUTABLE || path.resolve('release/public/mac-arm64/逻辑阅读.app/Contents/MacOS/逻辑阅读');
  const env = { ...process.env, DUOBOOK_SMOKE_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '资料').isVisible());
  try {
    app = await electron.launch({ executablePath, env, timeout: 60000 });
    let main = await app.firstWindow();
    await main.getByRole('button', { name: '打开工作台', exact: true }).click();
    await main.locator('main[data-reading-position-ready=true]').waitFor();
    const source = new URL(main.url()).pathname;
    const next = app.waitForEvent('window');
    await main.getByRole('button', { name: '单行阅读', exact: true }).click();
    const compact = await next;
    await expect(compact.getByTestId('compact-text')).toHaveAttribute('data-start');
    await expect.poll(() => compact.evaluate(() => window.duobookDesktop.getCompactShortcut()).then(status => status.registered)).toBe(true);
    assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+H')), true);

    if (process.env.DUOBOOK_TEST_GLOBAL_KEY === '1') {
      const press = () => execFileSync('/usr/bin/osascript', ['-e', 'tell application "Finder" to activate', '-e', 'delay 0.2', '-e', 'tell application "System Events" to keystroke "h" using {command down, shift down}'], { timeout: 7000 });
      press(); await expect.poll(visible).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 300));
      press(); await expect.poll(visible).toBe(true);
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '资料').isFocused()), false);
      console.log('Physical global shortcut passed with Finder focused: Cmd+Shift+H hides/shows the reader without focusing it.');
      return;
    }

    await compact.getByRole('button', { name: '更多阅读设置' }).click();
    await app.evaluate(({ globalShortcut }) => globalShortcut.register('Control+Alt+J', () => {}));
    const field = compact.getByLabel('全局隐藏显示快捷键', { exact: true });
    await field.press('Control+Alt+J');
    await compact.getByRole('button', { name: '保存全局快捷键', exact: true }).click();
    await expect(compact.getByRole('alert')).toContainText('占用');
    assert.equal((await compact.evaluate(() => window.duobookDesktop.getCompactShortcut())).accelerator, 'CommandOrControl+Shift+H');
    const changed = 'CommandOrControl+Alt+Shift+Y';
    await field.press('Meta+Alt+Shift+Y');
    await compact.getByRole('button', { name: '保存全局快捷键', exact: true }).click();
    await expect(compact.getByLabel('全局快捷键状态', { exact: true })).toContainText('已生效');
    assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+H')), false);
    await compact.getByRole('checkbox', { name: '启用全局隐藏 / 显示快捷键' }).uncheck();
    await compact.getByRole('button', { name: '保存全局快捷键', exact: true }).click();
    await expect(compact.getByLabel('全局快捷键状态', { exact: true })).toContainText('已关闭');
    await compact.getByRole('checkbox', { name: '启用全局隐藏 / 显示快捷键' }).check();
    await compact.getByRole('button', { name: '保存全局快捷键', exact: true }).click();
    await compact.getByRole('button', { name: '关闭阅读设置' }).click();
    await compact.waitForFunction(() => speechSynthesis.getVoices().some(voice => voice.localService));
    await compact.getByRole('button', { name: '开始朗读', exact: true }).click();
    await expect(compact.getByLabel('单行朗读状态', { exact: true })).toContainText('正在朗读');
    const text = await compact.getByTestId('compact-text').textContent();
    const probeId = await app.evaluate(({ BrowserWindow }) => {
      const probe = new BrowserWindow({ width: 360, height: 180, title: 'shortcut-focus-probe', show: true }); probe.focus(); return probe.id;
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isFocused(), probeId)).toBe(true);
    await compact.evaluate(() => window.duobookDesktop.toggleCompactReader());
    await expect.poll(visible).toBe(false);
    await expect(compact.getByLabel('单行朗读状态', { exact: true })).toContainText('声音已停止');
    assert.equal(await compact.evaluate(() => speechSynthesis.speaking), false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '逻辑阅读').isVisible()), false);
    await new Promise(resolve => setTimeout(resolve, 300));
    await compact.evaluate(() => window.duobookDesktop.toggleCompactReader());
    await expect.poll(visible).toBe(true);
    await expect(compact.getByTestId('compact-text')).toHaveText(text);
    await expect(compact.getByRole('button', { name: '开始朗读', exact: true })).toBeVisible();
    assert.equal(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isFocused(), probeId), true);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '资料').webContents.isAudioMuted())).toBe(false);
    await compact.getByTestId('compact-text').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await compact.getByRole('button', { name: '添加笔记', exact: true }).click();
    await compact.getByLabel('划线笔记内容').fill('全局隐藏时清除的未保存草稿');
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), probeId);
    await new Promise(resolve => setTimeout(resolve, 300));
    await compact.evaluate(() => window.duobookDesktop.toggleCompactReader());
    await expect.poll(visible).toBe(false);
    await expect(compact.getByRole('dialog', { name: '单行划线操作' })).toHaveCount(0);
    await new Promise(resolve => setTimeout(resolve, 300));
    await compact.evaluate(() => window.duobookDesktop.toggleCompactReader());
    await expect.poll(visible).toBe(true);
    await expect(compact.getByTestId('compact-text')).toHaveText(text);
    await expect(compact.getByLabel('划线笔记内容')).toHaveCount(0);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === '资料').getContentBounds().height)).toBe(36);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), probeId);
    await app.close(); app = null;
    app = await electron.launch({ executablePath, env, timeout: 60000 }); main = await app.firstWindow();
    await main.getByRole('heading', { name: '我的书架', exact: true }).waitFor();
    const reopened = app.waitForEvent('window');
    await main.evaluate(route => window.duobookDesktop.openCompactReader(route), '/compact' + source);
    const reader = await reopened;
    await expect(reader.getByTestId('compact-text')).toHaveAttribute('data-start');
    const restored = await reader.evaluate(() => window.duobookDesktop.getCompactShortcut());
    assert.equal(restored.accelerator, changed); assert.equal(restored.enabled, true); assert.equal(restored.registered, true);
    await reader.getByRole('button', { name: '更多阅读设置' }).click();
    await reader.getByRole('button', { name: '返回完整阅读' }).click();
    assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Alt+Shift+Y')), false);
    console.log('Shortcut native smoke passed: OS registration, conflict preservation, enable/disable, unfocused hide/show, no main-window reveal, native speech stop, position preserved, no autoplay/focus stealing, rebind restart and release on close.');
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exit(1); });
