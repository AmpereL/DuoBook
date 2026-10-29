import { expect, test, type Page } from "@playwright/test";

async function importBook(page: Page) {
  const original = `第一章 单行阅读\n\n批次${Date.now()}-${Math.random()}。${"一句完整的原文😊，Mixed English 123，长句也不能漏掉任何文字。".repeat(9)}\n\n第二自然段承接前文，语音与页面应保持一致。\n\n第二章 继续阅读\n\n跨章后的第一段原文。\n\n最后一段原文。`;
  const upload = await page.request.post("/api/v1/books/upload", { multipart: { file: { name: `compact-${Date.now()}.txt`, mimeType: "text/plain", buffer: Buffer.from(original) } } });
  expect(upload.ok()).toBe(true);
  const { book, structure } = await upload.json();
  await page.request.patch(`/api/v1/books/${book.id}/structure`, { data: { title: book.title, author: book.author, chapters: structure.chapters.map((chapter: any) => ({ ...chapter, include: true })) } });
  return { bookId: book.id as string, chapters: structure.chapters as Array<{ id: string; title: string }> };
}

async function fakeLocal(page: Page) {
  await page.addInitScript(() => {
    const state = { current: null as any, spoken: [] as any[], pauses: 0, resumes: 0, cancels: 0 };
    (window as any).__speech = state;
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(public text: string) {} } });
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ voiceURI: "local-zh", name: "本地中文", lang: "zh-CN", localService: true }],
      addEventListener: () => {}, removeEventListener: () => {},
      speak: (utterance: any) => { state.current = utterance; state.spoken.push(utterance); queueMicrotask(() => utterance.onstart?.()); },
      pause: () => { state.pauses++; }, resume: () => { state.resumes++; }, cancel: () => { state.cancels++; state.current = null; },
    } });
  });
}

test("单行长句与 Unicode 完整分页，调宽字号后仍可回装原文并定位返回", async ({ page }) => {
  const { bookId, chapters } = await importBook(page);
  await page.goto(`/books/${bookId}/chapters/${chapters[0].id}`);
  await page.getByRole("button", { name: "单行阅读", exact: true }).click();
  await expect(page).toHaveTitle("资料");
  const text = page.getByTestId("compact-text");
  await expect(text).toHaveAttribute("data-paragraph-id");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("单行窗口宽度").press("Home");
  await page.getByLabel("单行字号").press("End");
  await page.getByRole("button", { name: "关闭阅读设置" }).click();
  const payload = await (await page.request.get(`/api/v1/books/${bookId}/chapters/${chapters[0].id}`)).json();
  const progress = page.getByTestId("compact-progress");
  const totalCharacters = payload.paragraphs.reduce((sum: number, paragraph: any) => sum + Array.from(paragraph.text).length, 0);
  const collected: string[] = [];
  for (let screen = 0; screen < totalCharacters; screen++) {
    const id = await text.getAttribute("data-paragraph-id");
    const start = Number(await text.getAttribute("data-start"));
    const end = Number(await text.getAttribute("data-end"));
    const paragraph = payload.paragraphs.find((item: any) => item.id === id);
    expect(await text.textContent()).toBe(Array.from(paragraph.text).slice(start, end).join("").replace(/\s/g, " "));
    expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const before = payload.paragraphs.slice(0, payload.paragraphs.indexOf(paragraph)).reduce((sum: number, item: any) => sum + Array.from(item.text).length, 0);
    await expect(progress).toHaveText(`${((before + end) / totalCharacters * 100).toFixed(2)}%`);
    await expect(progress).toHaveAccessibleName("本章进度");
    expect(await progress.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    collected.push((await text.textContent())!);
    if (id === payload.paragraphs.at(-1).id && end === Array.from(paragraph.text).length) break;
    await page.getByRole("button", { name: "下一行", exact: true }).click();
  }
  expect(collected.join("")).toBe(payload.paragraphs.map((item: any) => item.text.replace(/\s/g, " ")).join(""));
  await expect(progress).toHaveText("100.00%");
  await page.keyboard.press("ArrowLeft");
  await expect(progress).not.toHaveText("100.00%");
  await page.keyboard.press("ArrowRight");
  await expect(progress).toHaveText("100.00%");
  const lastId = await text.getAttribute("data-paragraph-id");
  const lastText = await text.textContent();
  await page.reload();
  await expect(text).toHaveText(lastText!);
  await expect(progress).toHaveText("100.00%");
  await expect(page.getByRole("region", { name: "单行悬浮阅读" })).toHaveCSS("height", "42px");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByRole("button", { name: "返回完整阅读" }).click();
  await expect(page).toHaveURL(new RegExp(`#paragraph-${lastId}$`));
  await expect(page.locator(`#paragraph-${lastId}`)).toBeInViewport();
  await expect(page).toHaveTitle("逻辑阅读");
});

test("阅读条可拖动，触摸板节流，Esc 收起且刷新不露原文", async ({ page }) => {
  const { bookId, chapters } = await importBook(page);
  await page.goto(`/compact/books/${bookId}/chapters/${chapters[0].id}`);
  const text = page.getByTestId("compact-text");
  await expect(text).toHaveAttribute("data-paragraph-id");
  const grip = page.getByRole("button", { name: "拖动阅读条" });
  const before = (await grip.boundingBox())!;
  await page.mouse.move(before.x + 8, before.y + 8); await page.mouse.down();
  await page.mouse.move(before.x + 130, before.y + 90, { steps: 5 }); await page.mouse.up();
  const after = (await grip.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(100);
  expect(after.y - before.y).toBeGreaterThan(70);
  const original = await text.getAttribute("data-start");
  await text.dispatchEvent("wheel", { deltaY: 80 });
  await expect.poll(() => text.getAttribute("data-start")).not.toBe(original);
  // Concealing a mid-paragraph line must not change its pagination or saved offset.
  for (let at = 0; at < 10 && Number(await text.getAttribute("data-start")) === 0; at++) {
    await page.getByRole("button", { name: "下一行", exact: true }).click();
  }
  expect(Number(await text.getAttribute("data-start"))).toBeGreaterThan(0);
  const stepped = await text.textContent();
  for (let index = 0; index < 10; index++) await text.dispatchEvent("wheel", { deltaY: 4 });
  await expect(text).toHaveText(stepped!);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "资料 · 点击恢复" })).toBeVisible();
  await expect(text).not.toHaveAttribute("data-paragraph-id");
  await expect(page.getByTestId("compact-progress")).toHaveCount(0);
  await page.keyboard.press("Escape"); await page.reload();
  await expect(page.getByRole("button", { name: "资料 · 点击恢复" })).toBeVisible();
  await page.getByRole("button", { name: "资料 · 点击恢复" }).click();
  await expect(text).toHaveText(stepped!);
  await expect(page.getByTestId("compact-progress")).toHaveText(/^\d+\.\d{2}%$/);
  await page.setViewportSize({ width: 320, height: 600 });
  await expect.poll(() => text.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const rect = (await page.locator(".compact-reader").boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(320);
});

test("本地语音驱动翻页，手动翻页继续播放、暂停跳转不发声，改宽度暂停", async ({ page }) => {
  await fakeLocal(page);
  const { bookId, chapters } = await importBook(page);
  await page.goto(`/compact/books/${bookId}/chapters/${chapters[0].id}`);
  const text = page.getByTestId("compact-text");
  await expect(text).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("单行朗读状态")).toContainText("正在朗读");
  expect(await page.evaluate("window.__speech.current.text")).toBe(await text.textContent());
  const initial = await text.textContent();
  const initialProgress = await page.getByTestId("compact-progress").textContent();
  await page.evaluate("window.__speech.current.onend()");
  await expect(text).not.toHaveText(initial!);
  await expect(page.getByTestId("compact-progress")).not.toHaveText(initialProgress!);
  await page.getByRole("button", { name: "下一行", exact: true }).click();
  expect(await page.evaluate("window.__speech.current.text")).toBe(await text.textContent());
  await page.keyboard.press("Space");
  await expect(page.getByLabel("单行朗读状态")).toContainText("已暂停");
  const spoken = await page.evaluate("window.__speech.spoken.length");
  await page.getByRole("button", { name: "下一行", exact: true }).click();
  expect(await page.evaluate("window.__speech.spoken.length")).toBe(spoken);
  await expect(page.getByRole("button", { name: "继续朗读", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续朗读", exact: true }).click();
  expect(await page.evaluate("window.__speech.current.text")).toBe(await text.textContent());
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("单行窗口宽度").press("Home");
  await expect(page.getByLabel("单行朗读状态")).toContainText("已暂停");
  expect(await page.evaluate("window.__speech.current")).toBe(null);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "资料 · 点击恢复" }).click();
  await expect(page.getByRole("button", { name: "开始朗读", exact: true })).toBeVisible();
});

test("MiMo 支持预取、调速、自动翻页，遮盖后迟到请求不复播", async ({ page }) => {
  const requests: any[] = [];
  await page.addInitScript(() => {
    (window as any).__audio = { played: [] as HTMLMediaElement[], revoked: 0 };
    HTMLMediaElement.prototype.play = function () { (window as any).__audio.played.push(this); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { (window as any).__audio.revoked++; revoke(url); };
  });
  let block = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/speech/synthesize", async (route) => {
    requests.push(route.request().postDataJSON());
    if (block) await gate;
    const wav = Buffer.alloc(48044);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    await route.fulfill({ contentType: "audio/wav", body: wav }).catch(() => {});
  });
  const { bookId, chapters } = await importBook(page);
  await page.goto(`/compact/books/${bookId}/chapters/${chapters[0].id}`);
  await expect(page.getByTestId("compact-text")).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("语音模型", { exact: true }).selectOption("mimo");
  await page.getByLabel("朗读声调").selectOption("bright");
  await page.getByLabel("朗读音色").selectOption("苏打");
  await page.getByRole("button", { name: "关闭阅读设置" }).click();
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0].voice).toBe("苏打"); expect(requests[0].tone).toBe("bright");
  const start = await page.getByTestId("compact-text").getAttribute("data-start");
  await page.evaluate("window.__audio.played.at(-1).onended()");
  await expect(page.getByTestId("compact-text")).not.toHaveAttribute("data-start", start!);
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("朗读语速").press("End");
  expect(await page.evaluate("window.__audio.played.at(-1).playbackRate")).toBe(2);
  await page.getByRole("button", { name: "停止朗读", exact: true }).click();
  block = true;
  await page.getByRole("button", { name: "关闭阅读设置" }).click();
  const played = await page.evaluate("window.__audio.played.length");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("单行朗读状态")).toContainText("正在生成语音");
  await page.keyboard.press("Escape"); release();
  await expect(page.getByRole("button", { name: "资料 · 点击恢复" })).toBeVisible();
  expect(await page.evaluate("window.__audio.played.length")).toBe(played);
  expect(await page.evaluate("window.__audio.revoked")).toBeGreaterThan(0);
});

test("跨章节连续朗读可开启，默认章节结束停止；失焦收起不自动恢复", async ({ page }) => {
  await fakeLocal(page);
  const { bookId, chapters } = await importBook(page);
  await page.goto(`/compact/books/${bookId}/chapters/${chapters[1].id}`);
  await expect(page.getByTestId("compact-text")).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByRole("button", { name: "下一段", exact: true }).click();
  await page.getByRole("button", { name: "关闭阅读设置" }).click();
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await page.evaluate("window.__speech.current.onend()");
  await expect(page.getByLabel("单行朗读状态")).toContainText("已读完");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("选择章节").selectOption(chapters[0].id);
  await expect(page.getByTestId("compact-text")).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByRole("button", { name: "下一段", exact: true }).click();
  await page.getByLabel("连续朗读下一章 / 单元").check();
  await page.getByRole("button", { name: "关闭阅读设置" }).click();
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await page.evaluate("window.__speech.current.onend()");
  await expect(page).toHaveURL(new RegExp(chapters[1].id));
  await expect(page.getByLabel("单行朗读状态")).toContainText("正在朗读");
  await page.reload();
  await expect(page.getByRole("button", { name: "开始朗读", exact: true })).toBeVisible();
  expect(await page.evaluate("window.__speech.current")).toBe(null);
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("失焦自动收起").check();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByRole("button", { name: "资料 · 点击恢复" })).toBeVisible();
  expect(await page.evaluate("window.__speech.current")).toBe(null);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "资料 · 点击恢复" })).toBeVisible();
});

test("已拆分单元可进入单行阅读，按单元顺序切换并返回对应原文", async ({ page }) => {
  await fakeLocal(page);
  const book = await (await page.request.get("/api/v1/books/book_learning")).json();
  const units = [1, 2].map((ordinal) => ({ id: `unit_compact_${ordinal}`, ordinal, title: `单行测试单元${ordinal}`, statement: "一个完整意思", chapter_id: "chapter_goal", unit_set_id: "set_compact", book_id: book.id }));
  await page.route("**/api/v1/reading-units/unit_compact_*", async (route) => {
    const unit = units.find((item) => route.request().url().endsWith(item.id))!;
    await route.fulfill({ json: {
      book, unit, chapter: { id: "chapter_goal", title: "明确目标", units, unit_set: null }, annotations: [],
      paragraphs: [{ id: `p_compact_${unit.ordinal}`, ordinal: 1, text: `单元${unit.ordinal}的一行原文。` }],
      sections: [{ id: `s_${unit.id}`, ordinal: 1, title: "原文", kind: "original", body: "" }],
    } });
  });
  await page.goto(`/books/book_learning/units/${units[0].id}`);
  await page.getByRole("button", { name: "单行阅读", exact: true }).click();
  await expect(page.getByTestId("compact-text")).toHaveText("单元1的一行原文。");
  await expect(page.getByTestId("compact-progress")).toHaveAccessibleName("本单元进度");
  await expect(page.getByTestId("compact-progress")).toHaveText("100.00%");
  await page.getByRole("button", { name: "下一行", exact: true }).click();
  await expect(page.getByTestId("compact-text")).toHaveText("单元2的一行原文。");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByRole("button", { name: "返回完整阅读" }).click();
  await expect(page).toHaveURL(/units\/unit_compact_2#paragraph-p_compact_2$/);
  await expect(page.locator("#paragraph-p_compact_2")).toBeInViewport();
});

test("语音失败保留原文与位置，可重试；跨窗口播放互斥", async ({ page, context }) => {
  await fakeLocal(page);
  await page.goto("/books/book_learning/chapters/chapter_goal");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("朗读状态")).toContainText("正在朗读");
  const compact = await context.newPage();
  await fakeLocal(compact);
  await compact.goto("/compact/books/book_learning/chapters/chapter_goal");
  await expect(compact.getByTestId("compact-text")).toHaveAttribute("data-start");
  await compact.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("朗读状态")).not.toContainText("正在朗读");
  const text = await compact.getByTestId("compact-text").textContent();
  await compact.evaluate("window.__speech.current.onerror()");
  await expect(compact.getByLabel("单行朗读状态")).toContainText("语音失败");
  await expect(compact.getByTestId("compact-text")).toHaveText(text!);
  await compact.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(compact.getByLabel("单行朗读状态")).toContainText("正在朗读");
  await compact.screenshot({ path: "../../test-results/screenshots/compact-reader-web.png" });
  await compact.close();
});

test("原文选区被外部点击清除前，单行入口记住所选段落与 Unicode 偏移", async ({ page }) => {
  const { bookId, chapters } = await importBook(page);
  await page.goto(`/books/${bookId}/chapters/${chapters[0].id}`);
  const selected = await page.locator("[data-original-text]").first().evaluate((element) => {
    const node = element.firstChild!.firstChild!;
    const offset = node.textContent!.indexOf("长句");
    const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 4);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { id: (element as HTMLElement).dataset.paragraphId!, offset: Array.from(node.textContent!.slice(0, offset)).length };
  });
  await expect(page.getByRole("dialog", { name: "划线操作" })).toBeVisible();
  await page.getByRole("button", { name: "单行阅读", exact: true }).click();
  const text = page.getByTestId("compact-text");
  await expect(text).toHaveAttribute("data-paragraph-id", selected.id);
  expect(Number(await text.getAttribute("data-start"))).toBeLessThanOrEqual(selected.offset);
  expect(Number(await text.getAttribute("data-end"))).toBeGreaterThan(selected.offset);
  await expect(page).not.toHaveURL(/\?paragraph=/);
  await page.getByRole("button", { name: "下一行", exact: true }).click();
  const nextText = await text.textContent();
  await page.reload();
  await expect(text).toHaveText(nextText!);
});

test("快速跨章及跨书切换不会互相覆盖保存的阅读位置", async ({ page }) => {
  const first = await importBook(page);
  const second = await importBook(page);
  const originalPath = `/books/${first.bookId}/chapters/${first.chapters[0].id}`;
  await page.goto(`/compact${originalPath}`);
  const text = page.getByTestId("compact-text");
  await expect(text).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "下一行", exact: true }).click();
  const saved = await text.textContent();
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("选择章节").selectOption(first.chapters[1].id);
  await expect(page).toHaveURL(new RegExp(first.chapters[1].id));
  await expect(text).toHaveAttribute("data-start");
  await page.goto(`/compact/books/${second.bookId}/chapters/${second.chapters[0].id}`);
  await expect(text).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "下一行", exact: true }).click();
  await page.goto(originalPath);
  await page.getByRole("button", { name: "单行阅读", exact: true }).click();
  await expect(text).toHaveText(saved!);
});

test("左右键和 Page Up/Down 前后翻页，设置输入不误触发翻页", async ({ page }) => {
  const { bookId, chapters } = await importBook(page);
  await page.goto(`/compact/books/${bookId}/chapters/${chapters[0].id}`);
  const text = page.getByTestId("compact-text");
  await expect(text).toHaveAttribute("data-start", "0");
  const first = await text.textContent();
  await page.keyboard.press("ArrowRight");
  await expect(text).not.toHaveText(first!);
  const next = await text.textContent();
  await page.keyboard.press("ArrowLeft");
  await expect(text).toHaveText(first!);
  await page.keyboard.press("PageDown");
  await expect(text).toHaveText(next!);
  await page.keyboard.press("PageUp");
  await expect(text).toHaveText(first!);
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await expect(page.locator(".compact-reader__shortcuts")).toContainText("Page Up");
  await page.getByLabel("背景透明度").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("PageDown");
  await expect(text).toHaveText(first!);
});

test("页面置顶与背景透明度即时生效并保存，背景透明时文字和设置保持可见", async ({ page }) => {
  await page.goto("/library");
  await page.evaluate(() => {
    localStorage.setItem("logic-reading-compact", JSON.stringify({ width: 600, fontSize: 14, alwaysOnTop: false }));
  });
  await page.goto("/compact/books/book_learning/chapters/chapter_goal");
  await expect(page.getByTestId("compact-text")).toHaveAttribute("data-start");
  const pin = page.getByRole("button", { name: "页面内置顶", exact: true });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  const hit = await page.getByTestId("compact-text").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const overlay = document.createElement("div"); overlay.id = "test-page-overlay";
    Object.assign(overlay.style, { position: "fixed", left: `${bounds.x}px`, top: `${bounds.y}px`, width: "50px", height: `${bounds.height}px`, zIndex: "9999" });
    document.body.append(overlay);
    return { x: bounds.x + 10, y: bounds.y + 5 };
  });
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, hit)).toBe("test-page-overlay");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".compact-reader")), hit)).toBe(true);
  await expect(page.locator(".compact-reader")).toHaveCSS("z-index", "10000");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await expect(page.getByRole("checkbox", { name: "页面内置顶" })).toBeChecked();
  const slider = page.getByLabel("背景透明度");
  await expect(slider).toHaveValue("0");
  await slider.press("End");
  await expect(page.locator(".compact-reader")).toHaveCSS("background-color", "rgba(250, 250, 248, 0)");
  await expect(page.getByTestId("compact-text")).toHaveCSS("opacity", "1");
  await expect(page.locator(".compact-reader__panel")).toHaveCSS("background-color", "rgb(250, 250, 248)");
  await slider.press("Home");
  for (let step = 0; step < 13; step++) await slider.press("ArrowRight");
  await expect(slider).toHaveValue("65");
  await expect(page.locator(".compact-reader")).toHaveCSS("background-color", "rgba(250, 250, 248, 0.35)");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("logic-reading-compact") || "{}").backgroundTransparency)).toBe(65);
  const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem("logic-reading-compact") || "{}"));
  expect(preferences.alwaysOnTop).toBe(true);
  expect(preferences.backgroundTransparency).toBe(65);
  await page.reload();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await expect(slider).toHaveValue("65");
  await page.goto("/library");
  await page.getByRole("button", { name: "打开工作台" }).click();
  await page.getByRole("button", { name: "单行阅读", exact: true }).click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await expect(slider).toHaveValue("65");
  await page.getByRole("checkbox", { name: "页面内置顶" }).uncheck();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "关闭阅读设置" }).click();
  await page.screenshot({ path: "../../test-results/screenshots/compact-transparency-web.png" });
});
