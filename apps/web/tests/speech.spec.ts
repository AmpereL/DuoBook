import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { speechChunks } from "../src/speech";
import type { Paragraph } from "../src/types";

function silentWav() {
  const data = Buffer.alloc(48044);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test("长段落按 Unicode 字符切片，原文可完整回装", () => {
  const text = "阅读😊保持完整。".repeat(90);
  const chunks = speechChunks([{ id: "p1", ordinal: 1, text } as Paragraph]);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
  for (const chunk of chunks) {
    expect(Array.from(chunk.text).length).toBeLessThanOrEqual(240);
    expect(Array.from(text).slice(chunk.start, chunk.end).join("")).toBe(chunk.text);
  }
});

test("本地朗读应用声调语速，连续读下一段并在离页时停止", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { current: null as any, spoken: [] as any[], pauses: 0, resumes: 0, cancels: 0 };
    (window as any).__speech = state;
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { text: string; constructor(text: string) { this.text = text; } } });
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ voiceURI: "local-zh", name: "本地中文", lang: "zh-CN", localService: true }],
      addEventListener: () => {}, removeEventListener: () => {},
      speak: (utterance: any) => { state.current = utterance; state.spoken.push(utterance); queueMicrotask(() => utterance.onstart?.()); },
      pause: () => { state.pauses++; }, resume: () => { state.resumes++; }, cancel: () => { state.cancels++; state.current = null; },
    } });
  });
  await page.goto("/books/book_learning/chapters/chapter_goal");
  await page.getByLabel("朗读声调").selectOption("low");
  await page.getByLabel("朗读语速").press("End");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("status", { name: "朗读状态" })).toContainText("正在朗读");
  expect(await page.evaluate("window.__speech.current.rate")).toBe(2);
  expect(await page.evaluate("window.__speech.current.pitch")).toBe(0.75);
  await expect(page.locator(".chapter-original__paper p.is-speaking")).toHaveCount(1);
  await page.getByRole("button", { name: "暂停朗读" }).click();
  await expect(page.getByRole("status", { name: "朗读状态" })).toContainText("已暂停");
  await page.getByRole("button", { name: "继续朗读" }).click();
  expect(await page.evaluate("window.__speech.resumes")).toBe(1);
  await page.evaluate("window.__speech.current.onend()");
  await expect(page.locator(".chapter-original__paper p.is-speaking sup")).toHaveText("2");
  await page.getByRole("link", { name: "我的笔记" }).click();
  expect(await page.evaluate("window.__speech.cancels")).toBeGreaterThan(0);
  await page.goto("/books/book_learning/chapters/chapter_goal");
  await expect(page.getByLabel("朗读声调")).toHaveValue("low");
  await expect(page.getByLabel("朗读语速")).toHaveValue("2");
});

test("MiMo 按段生成并预取，调速保留音高，停止后释放音频", async ({ page }) => {
  const requests: any[] = [];
  await page.addInitScript(() => {
    (window as any).__audio = { played: [] as HTMLMediaElement[], revoked: 0 };
    HTMLMediaElement.prototype.play = function () { (window as any).__audio.played.push(this); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { (window as any).__audio.revoked++; revoke(url); };
  });
  await page.route("**/api/v1/speech/config", (route) => route.fulfill({ json: { configured: true, model: "mimo-v2.5-tts" } }));
  await page.route("**/api/v1/speech/synthesize", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "audio/wav", body: silentWav() });
  });
  await page.goto("/books/book_learning/chapters/chapter_goal");
  await page.getByLabel("语音模型", { exact: true }).selectOption("mimo");
  await page.getByLabel("朗读声调").selectOption("bright");
  await page.getByLabel("朗读音色").selectOption("苏打");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("status", { name: "朗读状态" })).toContainText("正在朗读");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0].voice).toBe("苏打");
  expect(requests[0].tone).toBe("bright");
  await page.getByLabel("朗读语速").press("End");
  expect(await page.evaluate("window.__audio.played.at(-1).playbackRate")).toBe(2);
  expect(await page.evaluate("window.__audio.played.at(-1).preservesPitch")).toBe(true);
  await page.getByRole("button", { name: "暂停朗读" }).click();
  await page.getByRole("button", { name: "继续朗读" }).click();
  await page.evaluate("window.__audio.played.at(-1).onended()");
  await expect(page.locator(".chapter-original__paper p.is-speaking sup")).toHaveText("2");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.locator(".chapter-original__paper p.is-speaking")).toHaveCount(0);
  expect(await page.evaluate("window.__audio.revoked")).toBeGreaterThan(0);
  await page.screenshot({ path: "../../test-results/screenshots/speech-reader.png", fullPage: true });
});

test("MiMo 生成期间停止，不会在迟到的响应返回后自动播放", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__plays = 0;
    HTMLMediaElement.prototype.play = () => { (window as any).__plays++; return Promise.resolve(); };
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/speech/config", (route) => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/v1/speech/synthesize", async (route) => {
    await gate;
    await route.fulfill({ contentType: "audio/wav", body: silentWav() }).catch(() => {});
  });
  await page.goto("/books/book_learning/chapters/chapter_goal");
  await page.getByLabel("语音模型", { exact: true }).selectOption("mimo");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("status", { name: "朗读状态" })).toContainText("正在生成语音");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  release();
  await expect(page.getByRole("button", { name: "开始朗读", exact: true })).toBeVisible();
  expect(await page.evaluate("window.__plays")).toBe(0);
});

test("语音连接独立保存且不回显 Key，解析配置保持原值", async ({ page }) => {
  const before = await (await page.request.get("/api/v1/settings/model")).json();
  await page.goto("/settings/model#speech-settings");
  await page.getByLabel("语音 API 地址", { exact: true }).fill("https://api.xiaomimimo.com/v1");
  await page.getByLabel("语音 API Key", { exact: true }).fill("sk-speech-e2e");
  await page.getByRole("button", { name: "保存语音设置" }).click();
  await expect(page.getByText("语音配置已保存。")).toBeVisible();
  await expect(page.getByLabel("语音 API Key", { exact: true })).toHaveValue("");
  const config = await (await page.request.get("/api/v1/speech/config")).json();
  expect(config.credential_source).toBe("speech");
  expect(JSON.stringify(config)).not.toContain("sk-speech-e2e");
  expect(await (await page.request.get("/api/v1/settings/model")).json()).toEqual(before);
  await page.reload();
  await expect(page.getByLabel("语音 API 地址", { exact: true })).toHaveValue("https://api.xiaomimimo.com/v1");
  await expect(page.getByLabel("语音 API Key", { exact: true })).toHaveAttribute("placeholder", "已配置，留空继续使用");
});

test("MiMo 播放失败后重试当前片段，不回到第一段", async ({ page }) => {
  const requests: any[] = [];
  await page.addInitScript(() => {
    (window as any).__audio = { played: [] as HTMLMediaElement[] };
    HTMLMediaElement.prototype.play = function () { (window as any).__audio.played.push(this); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
  });
  await page.route("**/api/v1/speech/config", (route) => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/v1/speech/synthesize", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "audio/wav", body: silentWav() });
  });
  await page.goto("/books/book_learning/chapters/chapter_goal");
  await page.getByLabel("语音模型", { exact: true }).selectOption("mimo");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("朗读状态", { exact: true })).toContainText("正在朗读");
  await page.evaluate("window.__audio.played.at(-1).onended()");
  await expect(page.locator(".chapter-original__paper p.is-speaking sup")).toHaveText("2");
  const paragraphId = await page.locator(".chapter-original__paper p.is-speaking [data-original-text]").getAttribute("data-paragraph-id");
  await page.evaluate("window.__audio.played.at(-1).onerror()");
  await expect(page.getByRole("alert")).toContainText("音频加载失败");
  const before = requests.length;
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  expect(requests[before].paragraph_id).toBe(paragraphId);
  await expect(page.locator(".chapter-original__paper p.is-speaking sup")).toHaveText("2");
  await page.evaluate("window.__audio.played.at(-1).onerror()");
  await expect(page.getByRole("alert")).toContainText("音频加载失败");
  await page.getByLabel("开始朗读段落").selectOption({ index: 1 });
  await page.getByLabel("开始朗读段落").selectOption({ index: 0 });
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.locator(".chapter-original__paper p.is-speaking sup")).toHaveText("1");
});

test("真实 MiMo WAV 在网页版实际解码播放并自动进入下一段", async ({ page }) => {
  const audio = fs.readFileSync(new URL("../../../desktop/fixtures/mimo-voice.wav", import.meta.url));
  await page.route("**/api/v1/speech/config", (route) => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/v1/speech/synthesize", (route) => route.fulfill({ contentType: "audio/wav", body: audio }));
  await page.goto("/books/book_learning/chapters/chapter_goal");
  await page.getByLabel("语音模型", { exact: true }).selectOption("mimo");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("朗读状态", { exact: true })).toContainText("正在朗读");
  await expect(page.locator(".chapter-original__paper p.is-speaking sup")).toHaveText("2", { timeout: 15000 });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
