const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

// This fixture is a real MiMo WAV. Playback is intentionally NOT mocked so CSP
// and the packaged Electron media decoder are both exercised.
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-reading-speech-'));
  const env = { ...process.env, DUOBOOK_SMOKE_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.DUOBOOK_SMOKE_EXECUTABLE || path.resolve('release/public/mac-arm64/逻辑阅读.app/Contents/MacOS/逻辑阅读'), env, timeout: 60000 });
  const audio = fs.readFileSync(path.join(__dirname, 'fixtures/mimo-voice.wav'));
  const live = process.env.DUOBOOK_REAL_SPEECH === '1';
  let responses = 0;
  const prepare = async (page) => {
    await page.evaluate(() => {
      window.__speechPolicyViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        if (event.effectiveDirective === 'media-src') window.__speechPolicyViolations.push(event.effectiveDirective);
      });
    });
    if (!live) await page.route('**/api/v1/speech/synthesize', (route) => { responses++; return route.fulfill({ contentType: 'audio/wav', body: audio }); });
  };
  const checkPlaying = async (page, label) => {
    await expect(page.getByLabel(label, { exact: true })).toContainText('正在朗读', { timeout: 150000 });
    assert.deepEqual(await page.evaluate(() => window.__speechPolicyViolations), []);
  };
  try {
    const main = await app.firstWindow();
    await main.getByRole('button', { name: '打开工作台' }).click();
    await main.getByRole('heading', { name: '明确目标', exact: true }).waitFor();
    const csp = await main.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
    assert.match(csp, /media-src 'self' blob:/);
    assert.match(csp, /connect-src 'self'/);
    await prepare(main);
    await main.getByLabel('语音模型', { exact: true }).selectOption('mimo');
    await main.getByRole('button', { name: '开始朗读', exact: true }).click();
    await checkPlaying(main, '朗读状态');
    await main.getByRole('button', { name: '暂停朗读', exact: true }).click();
    await expect(main.getByLabel('朗读状态', { exact: true })).toContainText('已暂停');
    await main.getByRole('button', { name: '继续朗读', exact: true }).click();
    await checkPlaying(main, '朗读状态');
    await main.getByRole('button', { name: '停止', exact: true }).click();
    const nextWindow = app.waitForEvent('window');
    await main.getByRole('button', { name: '单行阅读', exact: true }).click();
    const compact = await nextWindow;
    await expect(compact.getByTestId('compact-text')).toHaveAttribute('data-start');
    await prepare(compact);
    await compact.getByRole('button', { name: '更多阅读设置' }).click();
    await compact.getByLabel('语音模型', { exact: true }).selectOption('mimo');
    await compact.getByRole('button', { name: '关闭阅读设置' }).click();
    const before = await compact.getByTestId('compact-text').textContent();
    await compact.getByRole('button', { name: '开始朗读', exact: true }).click();
    await checkPlaying(compact, '单行朗读状态');
    await expect(compact.getByTestId('compact-text')).not.toHaveText(before, { timeout: 45000 });
    await checkPlaying(compact, '单行朗读状态');
    await compact.keyboard.press('Escape');
    await expect(compact.getByRole('button', { name: '资料 · 点击恢复' })).toBeVisible();
    await expect(compact.getByLabel('单行朗读状态', { exact: true })).toContainText('声音已停止');
    assert.deepEqual(await compact.evaluate(() => window.__speechPolicyViolations), []);
    console.log('Packaged MiMo speech passed:', live ? 'live provider + real media decoding' : 'real recorded MiMo WAV + real media decoding', 'normal and single-line playback, pause/resume, playback-driven navigation, conceal; media CSP allows blob while connect-src stays self.');
    if (!live) assert.ok(responses >= 3);
  } finally { await app.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
