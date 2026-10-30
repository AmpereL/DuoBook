import { expect, test, type Page } from "@playwright/test";

async function book(page: Page) {
  await page.request.put("/api/v1/settings/model", { data: { provider: "local", base_url: "", model: "", api_key: "", timeout: 60 } });
  const content = `第一章 原文锚点\n\n😊同一句\t原文重复，同一句原文重复。${"这里是需要连续阅读的长段文字，原文不能因为换行而丢失。".repeat(10)}批次${Date.now()}-${Math.random()}。\n\n本章收尾。\n\n第二章 全书终点\n\n最后一章的原文。\n\n全书最后一段😊。`;
  const response = await page.request.post("/api/v1/books/upload", { multipart: { file: { name: `notes-progress-${Date.now()}.txt`, mimeType: "text/plain", buffer: Buffer.from(content) } } });
  expect(response.ok()).toBe(true);
  const result = await response.json();
  await page.request.patch(`/api/v1/books/${result.book.id}/structure`, { data: { title: "单行笔记与进度", author: "演示", chapters: result.structure.chapters.map((c: any) => ({ ...c, include: true })) } });
  return { id: result.book.id, chapters: result.structure.chapters };
}
async function select(page: Page, start = 0, end = 6) {
  await page.getByTestId("compact-text").evaluate((element, { start, end }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = []; let node;
    while ((node = walker.nextNode())) nodes.push(node as Text);
    const visible = element.textContent ?? "";
    const locate = (cp: number) => {
      let offset = Array.from(visible).slice(0, cp).join("").length;
      for (const node of nodes) { if (offset <= node.length) return { node, offset }; offset -= node.length; }
      throw new Error("selection out of range");
    };
    const from = locate(start), to = locate(end), range = document.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { start, end });
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toBeVisible();
}

test("单行摘抄保留 emoji、制表符和重复文字的准确原文偏移，并同步普通阅读", async ({ page }) => {
  const b = await book(page);
  const payload = await (await page.request.get(`/api/v1/books/${b.id}/chapters/${b.chapters[0].id}`)).json();
  const first = payload.paragraphs[0];
  await page.goto(`/compact/books/${b.id}/chapters/${b.chapters[0].id}`);
  await expect(page.getByTestId("compact-text")).toHaveAttribute("data-start", "0");
  await select(page, 0, 7);
  const saved = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/annotations"));
  await page.getByRole("button", { name: "只做摘抄", exact: true }).click();
  const response = await saved; expect(response.ok()).toBe(true);
  const annotation = await response.json();
  expect(annotation.anchors[0]).toMatchObject({ paragraph_id: first.id, start_offset: 0, end_offset: 7, quote: Array.from(first.text).slice(0, 7).join("") });
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toHaveCount(0);
  await expect(page.locator(".compact-reader__text mark")).toHaveCount(1);
  // A second selection crosses already-highlighted text nodes, with an offset inside the same paragraph.
  await select(page, 3, 10);
  await page.getByRole("button", { name: "添加笔记", exact: true }).click();
  await page.getByLabel("划线笔记内容", { exact: true }).fill("同一行也能记下自己的疑问。");
  await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toHaveCount(0);
  await page.reload(); await expect(page.locator(".compact-reader__text mark")).not.toHaveCount(0);
  await page.getByRole("button", { name: "更多阅读设置" }).click(); await page.getByRole("button", { name: "返回完整阅读" }).click();
  await expect(page.getByText("同一行也能记下自己的疑问。", { exact: true })).toBeVisible();
  await page.goto("/notes"); await expect(page.getByText("同一行也能记下自己的疑问。", { exact: true })).toBeVisible();
});

test("段内后续行的选区按 chunk 起点保存，失败保留笔记草稿，点击别处和 Esc 关闭", async ({ page }) => {
  const b = await book(page); await page.goto(`/compact/books/${b.id}/chapters/${b.chapters[0].id}`);
  const text = page.getByTestId("compact-text"); await expect(text).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "下一行", exact: true }).click();
  const offset = Number(await text.getAttribute("data-start")); expect(offset).toBeGreaterThan(0);
  const id = await text.getAttribute("data-paragraph-id");
  await select(page, 1, 5); await page.getByRole("button", { name: "添加笔记", exact: true }).click();
  const note = "失败后保留的草稿";
  await page.getByLabel("划线笔记内容").fill(note);
  await page.route("**/api/v1/annotations", route => route.fulfill({ status: 503, json: { detail: "暂时无法保存" } }));
  await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible(); await expect(page.getByLabel("划线笔记内容")).toHaveValue(note);
  await page.unroute("**/api/v1/annotations");
  const pending = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/annotations"));
  await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  const response = await pending; const saved = await response.json();
  expect(saved.anchors[0]).toMatchObject({ paragraph_id: id, start_offset: offset + 1, end_offset: offset + 5 });
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toHaveCount(0);
  await select(page, 0, 3); await page.getByRole("button", { name: "页面内置顶", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toHaveCount(0);
  await select(page, 0, 3); await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toHaveCount(0); await expect(page.locator(".compact-reader__annotation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "资料 · 点击恢复" })).toBeVisible();
});

test("全书进度跨章连续、末行 100%，进度范围刷新保留且空源不伪造百分比", async ({ page }) => {
  const b = await book(page);
  const first = await (await page.request.get(`/api/v1/books/${b.id}/chapters/${b.chapters[0].id}`)).json();
  const last = await (await page.request.get(`/api/v1/books/${b.id}/chapters/${b.chapters[1].id}`)).json();
  const total = [...first.paragraphs, ...last.paragraphs].reduce((sum: number, p: any) => sum + Array.from(p.text).length, 0);
  const before = first.paragraphs.reduce((sum: number, p: any) => sum + Array.from(p.text).length, 0);
  await page.goto(`/compact/books/${b.id}/chapters/${b.chapters[1].id}`);
  const text = page.getByTestId("compact-text"), progress = page.getByTestId("compact-progress");
  await expect(text).toHaveAttribute("data-start");
  await expect(progress).toHaveAccessibleName("全书进度");
  await expect(progress).toHaveText(`${((before + Number(await text.getAttribute("data-end"))) / total * 100).toFixed(2)}%`);
  await page.getByRole("button", { name: "下一行", exact: true }).click(); await expect(progress).toHaveText("100.00%");
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByLabel("选择章节", { exact: true }).selectOption(b.chapters[0].id);
  await expect(progress).not.toHaveText("100.00%");
  await page.getByRole("button", { name: "更多阅读设置" }).click(); await page.getByLabel("进度显示", { exact: true }).selectOption("source");
  await page.getByRole("button", { name: "关闭阅读设置" }).click(); await expect(progress).toHaveAccessibleName("本章进度");
  await page.reload(); await expect(progress).toHaveAccessibleName("本章进度");
  await page.route(`**/api/v1/books/${b.id}/chapters/${b.chapters[0].id}`, route => route.fulfill({ json: { ...first, paragraphs: [], reading_progress: { total_characters: 0, paragraphs: [] } } }));
  await page.reload(); await expect(text).toHaveText("本章暂无原文"); await expect(progress).toHaveText("—");
});

test("阅读单元与对应章节的全书位置相同，重拆后旧单元仍保留进度", async ({ page }) => {
  const b = await book(page), chapter = b.chapters[1].id;
  await page.request.post(`/api/v1/books/${b.id}/chapters/${chapter}/split-runs`);
  await expect.poll(async () => (await (await page.request.get(`/api/v1/books/${b.id}/chapters/${chapter}`)).json()).units.length).toBe(1);
  const payload = await (await page.request.get(`/api/v1/books/${b.id}/chapters/${chapter}`)).json();
  await page.goto(`/compact/books/${b.id}/chapters/${chapter}`);
  const progress = page.getByTestId("compact-progress"); await expect(progress).toHaveText(/^\d+\.\d{2}%$/);
  const percent = await progress.textContent();
  await page.goto(`/compact/books/${b.id}/units/${payload.units[0].id}`); await expect(progress).toHaveText(percent!);
  await page.request.post(`/api/v1/books/${b.id}/chapters/${chapter}/split-runs`);
  await expect.poll(async () => (await (await page.request.get(`/api/v1/books/${b.id}/chapters/${chapter}`)).json()).history.length).toBe(2);
  await page.reload(); await expect(progress).toHaveText(percent!);
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await expect(page.locator(".compact-reader__progress")).toContainText("本单元进度");
});

test("选字暂停朗读，保存后不自动播放；全局收起清除未保存的笔记", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { current: null as any, spoken: 0 }; (window as any).__compactSpeech = state;
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(public text: string) {} } });
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ voiceURI: "local-zh", name: "本地中文", lang: "zh-CN", localService: true }],
      addEventListener: () => {}, removeEventListener: () => {}, pause: () => {}, resume: () => {}, cancel: () => { state.current = null; },
      speak: (u: any) => { state.current = u; state.spoken++; queueMicrotask(() => u.onstart?.()); },
    } });
  });
  const b = await book(page); await page.goto(`/compact/books/${b.id}/chapters/${b.chapters[0].id}`);
  const text = page.getByTestId("compact-text"); await expect(text).toHaveAttribute("data-start");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("单行朗读状态")).toContainText("正在朗读");
  await text.dispatchEvent("pointerdown"); await select(page);
  const original = await text.textContent(); await expect(page.getByLabel("单行朗读状态")).toContainText("已暂停");
  await page.evaluate(() => (window as any).__compactSpeech.current.onend());
  await expect(text).toHaveText(original!);
  await page.getByRole("button", { name: "只做摘抄", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续朗读", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__compactSpeech.spoken)).toBe(1);
  await select(page); await page.getByRole("button", { name: "添加笔记", exact: true }).click();
  await page.getByLabel("划线笔记内容").fill("隐藏时不能残留的草稿");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("compact-window-visibility", { detail: { hidden: true } })));
  await expect(page.getByRole("button", { name: "资料 · 点击恢复" })).toBeVisible();
  await expect(page.locator(".compact-reader__annotation")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("compact-window-visibility", { detail: { hidden: false } })));
  await expect(text).toHaveText(original!); await expect(page.getByLabel("划线笔记内容")).toHaveCount(0);
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByRole("button", { name: "下一段", exact: true }).click();
  await page.getByLabel("连续朗读下一章 / 单元").check();
  await page.getByRole("button", { name: "关闭阅读设置" }).click();
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByLabel("单行朗读状态")).toContainText("正在朗读");
  const atEnd = await text.textContent();
  await text.dispatchEvent("pointerdown"); await select(page, 0, 3);
  // A queued end callback for the final line must not switch chapters while annotating.
  await page.evaluate(() => (window as any).__compactSpeech.current.onend());
  await expect(text).toHaveText(atEnd!);
  await expect(page).toHaveURL(new RegExp(b.chapters[0].id));
  await expect(page.getByRole("dialog", { name: "单行划线操作" })).toBeVisible();
});
