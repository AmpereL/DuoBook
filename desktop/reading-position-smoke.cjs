const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-reading-resume-'));
  const executablePath = process.env.DUOBOOK_SMOKE_EXECUTABLE || path.resolve('release/public/mac-arm64/逻辑阅读.app/Contents/MacOS/逻辑阅读');
  const env = { ...process.env, DUOBOOK_SMOKE_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let book, targetId;
  const launch = async () => {
    app = await electron.launch({ executablePath, env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '我的书架', exact: true }).waitFor();
    return page;
  };
  try {
    let page = await launch();
    book = await page.evaluate(async () => {
      const text = [1, 2, 3].map(chapter => `第${chapter}章 重启恢复${chapter}\n\n` + Array.from({ length: 30 }, (_, index) => `段落${index + 1}。${'原文阅读位置应保留到重新启动以后，不应自动回到第一章。'.repeat(6)}`).join('\n\n')).join('\n\n');
      const form = new FormData(); form.append('file', new File([text], 'desktop-resume.txt', { type: 'text/plain' }));
      const uploaded = await (await fetch('/api/v1/books/upload', { method: 'POST', body: form })).json();
      await fetch(`/api/v1/books/${uploaded.book.id}/structure`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: uploaded.book.title, author: uploaded.book.author, chapters: uploaded.structure.chapters.map(chapter => ({ ...chapter, include: true })) }) });
      return { id: uploaded.book.id, title: uploaded.book.title, chapterId: uploaded.structure.chapters[1].id };
    });
    await page.goto(new URL(`/books/${book.id}/chapters/${book.chapterId}`, page.url()).toString());
    await page.locator('main[data-reading-position-ready=true]').waitFor();
    // macOS occlusion can mark a background test window hidden; real scrolling
    // needs a visible foreground window before exercising immediate quit.
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
    await page.waitForFunction(() => document.visibilityState === 'visible');
    targetId = await page.locator('[data-reading-paragraph]').nth(13).getAttribute('data-reading-paragraph');
    await page.locator(`#paragraph-${targetId}`).evaluate(element => {
      const rect = element.getBoundingClientRect();
      window.scrollTo({ top: scrollY + rect.top + rect.height * .4 - Math.min(240, innerHeight * .3), behavior: 'instant' });
    });
    // Quit immediately, before the 300ms autosave debounce: shutdown must flush.
    await app.close(); app = null;
    page = await launch();
    await page.getByRole('button', { name: `打开${book.title}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(book.chapterId));
    await page.locator('main[data-reading-position-ready=true]').waitFor();
    await expect(page.locator(`#paragraph-${targetId}`)).toBeInViewport();
    const saved = await page.evaluate(async id => (await (await fetch(`/api/v1/books/${id}/reading-position`)).json()).position, book.id);
    assert.equal(saved.paragraph_id, targetId);
    const nextWindow = app.waitForEvent('window');
    await page.evaluate(path => window.duobookDesktop.openCompactReader(path), `/compact/books/${book.id}/chapters/${book.chapterId}`);
    const compact = await nextWindow;
    await expect(compact.getByTestId('compact-text')).toHaveAttribute('data-start');
    await compact.getByRole('button', { name: '下一行', exact: true }).click();
    const lastParagraph = await compact.getByTestId('compact-text').getAttribute('data-paragraph-id');
    const offset = Number(await compact.getByTestId('compact-text').getAttribute('data-start'));
    await app.close(); app = null;
    page = await launch();
    const resumed = await page.evaluate(async id => (await (await fetch(`/api/v1/books/${id}/reading-position`)).json()).position, book.id);
    assert.equal(resumed.paragraph_id, lastParagraph); assert.equal(resumed.character_offset, offset);
    await page.getByRole('button', { name: `打开${book.title}`, exact: true }).click();
    await page.locator('main[data-reading-position-ready=true]').waitFor();
    await expect(page.locator(`#paragraph-${lastParagraph}`)).toBeInViewport();
    await expect(page.getByLabel('朗读状态', { exact: true })).not.toContainText('正在朗读');
    console.log('Reading position desktop smoke passed: immediate-quit flush, chapter/paragraph restore after restart, compact character offset persists, hidden main does not overwrite compact progress, reopen remains silent.');
    console.log('Isolated test data:', data);
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exit(1); });
