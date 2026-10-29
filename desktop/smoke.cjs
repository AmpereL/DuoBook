const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'duobook-package-'));
  const executablePath = process.env.DUOBOOK_SMOKE_EXECUTABLE || path.resolve('release/mac-arm64/逻辑阅读.app/Contents/MacOS/逻辑阅读');
  const env = { ...process.env, DUOBOOK_SMOKE_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath, env, timeout: 60000 });
  try {
    assert.equal(await app.evaluate(({ app }) => app.getName()), '逻辑阅读');
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    const page = await app.firstWindow();
    assert.equal(await page.title(), '逻辑阅读');
    assert.equal(await page.evaluate(() => window.duobookDesktop.getAppIcon()), 2);
    await page.getByRole('heading', { name: '我的书架', exact: true }).waitFor();
    const config = await page.evaluate(async () => (await fetch('/api/v1/settings/model')).json());
    const apiVersion = await page.evaluate(async () => (await fetch('/openapi.json')).json()).then((spec) => spec.info.version);
    assert.equal(apiVersion, require('../package.json').version);
    assert.equal(config.provider, 'anthropic');
    assert.equal(config.model, 'mimo-v2.5-pro');
    assert.equal(config.has_api_key, true);
    const speechConfig = await page.evaluate(async () => (await fetch('/api/v1/speech/config')).json());
    assert.equal(speechConfig.base_url, 'https://api.xiaomimimo.com/v1');
    assert.equal(speechConfig.credential_source, 'speech');
    assert.equal(speechConfig.configured, true);
    assert.equal('api_key' in speechConfig, false);
    await page.getByRole('button', { name: '打开工作台' }).click();
    await page.getByRole('heading', { name: '明确目标', exact: true }).waitFor({ state: 'attached' });
    await page.getByRole('region', { name: '语音阅读' }).waitFor();
    await page.waitForFunction(() => window.speechSynthesis?.getVoices().some((voice) => voice.localService), null, { timeout: 15000 });
    const localVoiceCount = await page.evaluate(() => speechSynthesis.getVoices().filter((voice) => voice.localService).length);
    console.log('Installed local speech voices:', localVoiceCount);
    await page.getByLabel('朗读声调').selectOption('bright');
    await page.getByLabel('朗读语速').press('End');
    const speechSettings = await page.evaluate(() => window.duobookDesktop.getSpeechSettings());
    assert.equal(speechSettings.tone, 'bright');
    assert.equal(speechSettings.rate, 2);
    await page.getByRole('button', { name: '开始朗读', exact: true }).click();
    await page.getByRole('status', { name: '朗读状态' }).filter({ hasText: '正在朗读' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
    await page.getByRole('status', { name: '朗读状态' }).filter({ hasText: '已暂停' }).waitFor();
    await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    console.log('Native local speech playback, pause/resume and stop passed.');
    const originalChapterUrl = page.url();
    const directoryBook = await page.evaluate(async () => {
      const text = Array.from({ length: 40 }, (_, index) => `第${index + 1}章 桌面目录${index + 1}\n\n这是用于滚动保持验证的第${index + 1}章原文。`).join('\n\n');
      const form = new FormData();
      form.append('file', new File([text], 'desktop-navigation.txt', { type: 'text/plain' }));
      const uploaded = await (await fetch('/api/v1/books/upload', { method: 'POST', body: form })).json();
      await fetch(`/api/v1/books/${uploaded.book.id}/structure`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: uploaded.book.title, author: uploaded.book.author, chapters: uploaded.structure.chapters.map((chapter) => ({ ...chapter, include: true })) }),
      });
      return { bookId: uploaded.book.id, chapters: uploaded.structure.chapters };
    });
    await page.goto(new URL(`/books/${directoryBook.bookId}/chapters/${directoryBook.chapters[0].id}`, page.url()).toString());
    const directory = page.getByRole('complementary', { name: '章节列表' });
    const targetChapter = directory.getByTestId('chapter-row').nth(24);
    await targetChapter.scrollIntoViewIfNeeded();
    const directoryScroll = await directory.evaluate((element) => element.scrollTop);
    assert.ok(directoryScroll > 500);
    await targetChapter.click();
    await page.getByRole('heading', { name: directoryBook.chapters[24].title, exact: true }).waitFor();
    assert.ok(Math.abs(await directory.evaluate((element) => element.scrollTop) - directoryScroll) <= 1);
    await page.reload();
    await page.getByRole('heading', { name: directoryBook.chapters[24].title, exact: true }).waitFor();
    assert.ok(Math.abs(await directory.evaluate((element) => element.scrollTop) - directoryScroll) <= 1);
    console.log('Long chapter directory kept its scroll position through navigation and reload.');
    await page.goto(originalChapterUrl);
    await page.getByRole('heading', { name: '明确目标', exact: true }).waitFor({ state: 'attached' });
    await page.getByRole('link', { name: '逻辑地图', exact: true }).click();
    await page.getByRole('heading', { name: '逻辑地图', exact: true }).waitFor();
    await page.locator('.react-flow__node').first().waitFor();
    await page.goto(new URL('/notes', page.url()).toString());
    await page.getByRole('link', { name: '导出 Markdown' }).waitFor();
    const exported = await page.evaluate(async () => {
      const response = await fetch('/api/v1/notes/export?format=markdown');
      return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
    });
    assert.equal(exported.status, 200);
    assert.match(exported.type, /text\/markdown/);
    assert.match(exported.body, /# 阅读笔记/);
    await page.getByRole('link', { name: '模型设置' }).click();
    await page.getByLabel('语音请求超时（秒）', { exact: true }).fill('90');
    await page.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await page.getByText('语音配置已保存。', { exact: true }).waitFor();
    assert.equal(fs.existsSync(path.join(data, 'speech.enc')), true);
    await page.getByRole('button', { name: '选择图标 4：书签与分支' }).click();
    assert.equal(await page.evaluate(() => window.duobookDesktop.getAppIcon()), 4);
    await page.screenshot({ path: 'release/desktop-smoke.png' });
    console.log('Packaged app passed: library, chapter page, mind map, icon selection, private defaults loaded.');
  } finally { await app.close(); }
  const reopened = await electron.launch({ executablePath, env, timeout: 60000 });
  try {
    const page = await reopened.firstWindow();
    assert.equal(await page.evaluate(() => window.duobookDesktop.getAppIcon()), 4);
    const speech = await page.evaluate(() => window.duobookDesktop.getSpeechSettings());
    assert.equal(speech.tone, 'bright');
    assert.equal(speech.rate, 2);
    const speechConfig = await page.evaluate(async () => (await fetch('/api/v1/speech/config')).json());
    assert.equal(speechConfig.timeout, 90);
    assert.equal(speechConfig.configured, true);
  } finally { await reopened.close(); }
  console.log('Isolated test data:', data);
})().catch((error) => { console.error(error); process.exit(1); });
