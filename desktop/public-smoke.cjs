const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-reading-public-'));
  const executablePath = process.env.DUOBOOK_SMOKE_EXECUTABLE || path.resolve('release/public/mac-arm64/逻辑阅读.app/Contents/MacOS/逻辑阅读');
  const resources = path.resolve(path.dirname(executablePath), '../Resources');
  for (const name of ['private-defaults.json', 'private-speech-defaults.json', 'model-defaults.json', 'speech-defaults.json', 'duobook.db', 'model.enc', 'speech.enc']) assert.equal(fs.existsSync(path.join(resources, name)), false);
  const env = { ...process.env, DUOBOOK_SMOKE_DIR: data,
    DUOBOOK_TTS_API_KEY: 'inherited-environment-credential-must-not-be-used', DUOBOOK_TTS_BASE_URL: 'https://api.xiaomimimo.com/v1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const userModelKey = 'public-smoke-own-model-credential';
  const userSpeechKey = 'public-smoke-own-speech-credential';
  let app;
  const launch = async () => {
    app = await electron.launch({ executablePath, env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '我的书架', exact: true }).waitFor();
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), data);
    return page;
  };
  try {
    let page = await launch();
    let model = await page.evaluate(async () => (await fetch('/api/v1/settings/model')).json());
    let speech = await page.evaluate(async () => (await fetch('/api/v1/speech/config')).json());
    assert.equal(model.provider, 'local'); assert.equal(model.has_api_key, false);
    assert.equal(model.base_url, ''); assert.equal(model.model, ''); assert.equal('api_key' in model, false);
    assert.equal(speech.configured, false); assert.equal('api_key' in speech, false);
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/v1/books')).json()).items.length), 1);
    await page.getByRole('button', { name: '打开工作台' }).click();
    await page.getByRole('heading', { name: '明确目标', exact: true }).waitFor();
    await page.getByRole('button', { name: '拆分本章', exact: true }).click();
    await expect(page.locator('.unit-card')).toHaveCount(1);
    const chapterPath = new URL(page.url()).pathname;
    await page.evaluate(async () => {
      const chapter = await (await fetch('/api/v1/books/book_learning/chapters/chapter_goal')).json();
      const p = chapter.paragraphs[0], quote = Array.from(p.text).slice(0, 2).join('');
      const response = await fetch('/api/v1/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paragraph_id: p.id, start_offset: 0, end_offset: 2, quote, body: '公开版重启后保留的笔记' }) });
      if (!response.ok) throw new Error('Note fixture failed');
    });
    await page.goto(new URL('/settings/model', page.url()).toString());
    await page.getByRole('radio', { name: 'Anthropic' }).click();
    await page.getByLabel('API 地址', { exact: true }).fill('https://model.example/anthropic');
    await page.getByLabel('模型名称', { exact: true }).fill('user-configured-model');
    await page.getByLabel('API Key', { exact: true }).fill(userModelKey);
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await page.getByText('设置已保存，新任务会使用该模型。', { exact: true }).waitFor();
    await page.getByLabel('语音 API Key', { exact: true }).fill(userSpeechKey);
    await page.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await page.getByText('语音配置已保存。', { exact: true }).waitFor();
    for (const [file, value] of [['model.enc', userModelKey], ['speech.enc', userSpeechKey]]) {
      assert.equal(fs.existsSync(path.join(data, file)), true);
      assert.equal(fs.readFileSync(path.join(data, file)).includes(Buffer.from(value)), false);
    }
    await app.close(); app = null;
    page = await launch();
    model = await page.evaluate(async () => (await fetch('/api/v1/settings/model')).json());
    speech = await page.evaluate(async () => (await fetch('/api/v1/speech/config')).json());
    assert.equal(model.provider, 'anthropic'); assert.equal(model.model, 'user-configured-model'); assert.equal(model.has_api_key, true);
    assert.equal(speech.configured, true); assert.equal(speech.credential_source, 'speech');
    await page.goto(new URL(chapterPath, page.url()).toString());
    await expect(page.getByText('公开版重启后保留的笔记', { exact: true })).toBeVisible();
    await expect(page.locator('.unit-card')).toHaveCount(1);
    console.log('Public distribution passed: no bundled credentials or user data, clean first-run local mode, shell credentials ignored, local split works, own model/speech settings encrypted, books/notes/settings retained after restart.');
    console.log('Isolated test directory:', data);
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exit(1); });
