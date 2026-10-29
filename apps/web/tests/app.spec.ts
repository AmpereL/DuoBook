import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const screenshotDir = path.resolve(testDir, "../../../test-results/screenshots");

test.beforeAll(() => fs.mkdirSync(screenshotDir, { recursive: true }));

async function selectOriginalText(page: Page, selector: string, paragraphIndex: number, quote: string) {
  await page.evaluate(({ selector, index, quote }) => {
    const element = document.querySelectorAll<HTMLElement>(`${selector} [data-original-text]`)[index];
    const textNode = element.firstChild?.firstChild;
    if (!textNode) throw new Error("找不到原文文字节点");
    const start = textNode.textContent?.indexOf(quote) ?? -1;
    if (start < 0) throw new Error("找不到要选中的文字");
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + quote.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { selector, index: paragraphIndex, quote });
}

test("书架进入按章工作台，未拆分前即可阅读原文", async ({ page }) => {
  await page.goto("/library");
  await expect(page).toHaveTitle("逻辑阅读");
  await expect(page.locator(".brand strong")).toHaveText("逻辑阅读");
  await expect(page.getByRole("heading", { name: "我的书架" })).toBeVisible();
  await page.getByRole("button", { name: "打开工作台" }).click();
  await expect(page).toHaveURL(/\/books\/book_learning\/chapters\//);
  await expect(page.getByRole("heading", { name: "明确目标" })).toBeVisible();
  await expect(page.getByText("本章全文")).toBeVisible();
  await expect(page.getByText("尚未拆分").first()).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, "chapter-workbench.png"), fullPage: true });
});

test("未拆分章节可摘抄写笔记，拆分后仍在单元原文显示", async ({ page }) => {
  const unique = Date.now();
  const sample = `第一章 提出问题

未拆分前也要保留重要原文，这里是阅读时记录的第一段。

第二段承接前文，准备进入后面的阅读单元。`;
  await page.goto("/library");
  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: `early-note-${unique}.txt`, mimeType: "text/plain", buffer: Buffer.from(sample) });
  await page.getByLabel("书名").fill(`未拆分笔记测试 ${unique}`);
  await page.getByRole("button", { name: "完成导入，选择章节" }).click();
  await expect(page.getByText("尚未拆分").first()).toBeVisible();

  await selectOriginalText(page, ".chapter-original__paper", 0, "未拆分前");
  await expect(page.getByRole("dialog", { name: "划线操作" })).toBeVisible();
  await page.getByRole("heading", { name: "本章全文" }).click();
  await expect(page.getByRole("dialog", { name: "划线操作" })).toBeHidden();
  await selectOriginalText(page, ".chapter-original__paper", 0, "未拆分前");
  await page.getByRole("button", { name: "只做摘抄" }).click();
  await expect(page.locator(".chapter-original__paper .unit-original__highlight")).toContainText("未拆分前");
  await selectOriginalText(page, ".chapter-original__paper", 1, "第二段承接前文");
  await page.getByRole("button", { name: "添加笔记" }).click();
  await page.getByRole("heading", { name: "本章全文" }).click();
  await expect(page.getByRole("dialog", { name: "划线操作" })).toBeHidden();
  await selectOriginalText(page, ".chapter-original__paper", 1, "第二段承接前文");
  await page.getByRole("button", { name: "添加笔记" }).click();
  await page.getByRole("textbox", { name: "划线笔记内容" }).fill("拆分前写下的想法。");
  await page.getByRole("button", { name: "保存笔记" }).click();
  await expect(page.getByText("拆分前写下的想法。")).toBeVisible();

  const chapterUrl = page.url();
  await page.goto("/notes");
  await expect(page.getByText("拆分前写下的想法。")).toBeVisible();
  const markdownDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出 Markdown" }).click();
  expect(fs.readFileSync(await (await markdownDownload).path(), "utf8")).toContain("拆分前写下的想法。");
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出 JSON" }).click();
  const exported = JSON.parse(fs.readFileSync(await (await jsonDownload).path(), "utf8"));
  expect(exported.notes.some((note: { body: string }) => note.body === "拆分前写下的想法。")).toBe(true);
  await page.getByRole("link", { name: "回到原文划线" }).first().click();
  await expect(page).toHaveURL(chapterUrl);
  await expect(page.locator(".chapter-original__paper .unit-original__highlight")).toHaveCount(2);

  await page.getByRole("button", { name: "拆分本章" }).click();
  await page.locator(".unit-card").first().click();
  await expect(page.locator(".unit-original .unit-original__highlight")).toHaveCount(2);
  await expect(page.getByText("拆分前写下的想法。")).toBeVisible();
});

test("等待模型时拆分进度平滑前进且不提前显示完成", async ({ page }) => {
  await page.route("**/api/v1/books/book_learning/chapters/chapter_goal", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.chapter.status = "splitting";
    payload.chapter.job = {
      id: "job_smooth", status: "running", progress: 8, message: "正在通读本章原文",
      created_at: new Date(Date.now() - 30_000).toISOString(), updated_at: new Date().toISOString(),
    };
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/books/book_learning/chapters/chapter_goal");
  const bar = page.getByRole("progressbar", { name: "本章拆分预估进度" });
  await expect(bar).toBeVisible();
  const progress = Number(await bar.getAttribute("aria-valuenow"));
  expect(progress).toBeGreaterThan(8);
  expect(progress).toBeLessThan(100);
  await expect(page.getByText(`约 ${progress}%`)).toBeVisible();
});

test("导入后只拆分选择的一章，并在单元内保存深读笔记", async ({ page }) => {
  const unique = Date.now();
  const sample = `第一章 阅读问题

清晰的问题决定阅读过程中值得关注的内容。没有明确问题时，读者容易被细节带离主线。

如果目标过于宽泛😊，就需要先缩小范围，再寻找证据。缩小范围不等于忽略上下文。

第二章 证据判断

一个观点是否可靠，取决于它能否由原文中的证据支持。共同关键词不能自动构成因果关系。`;
  await page.goto("/library");
  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: `e2e-${unique}.txt`, mimeType: "text/plain", buffer: Buffer.from(sample) });
  await expect(page.getByRole("heading", { name: "确认目录" })).toBeVisible();
  await page.getByLabel("书名").fill(`按章深读测试 ${unique}`);
  await page.getByRole("button", { name: "完成导入，选择章节" }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/chapters\//);
  await expect(page.getByRole("heading", { name: "阅读问题" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "拆分本章" }).click();
  await expect(page.getByText("从一个完整意思进入")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-testid='chapter-row']").last()).toContainText("尚未拆分");
  await page.locator(".unit-card").first().click();
  await expect(page.getByText("一、原文")).toBeVisible();
  const understanding = page.getByLabel("八、你的理解/疑问");
  await understanding.fill("我需要再核对作者的前提。");
  await page.getByRole("button", { name: "保存" }).nth(6).click();
  await expect(understanding).toHaveValue("我需要再核对作者的前提。");
  await selectOriginalText(page, ".unit-original", 0, "清晰的问");
  await page.getByRole("button", { name: "只做摘抄" }).click();
  await expect(page.getByText("仅摘抄")).toBeVisible();
  await expect(page.locator(".unit-original__highlight")).toHaveCount(1);
  await selectOriginalText(page, ".unit-original", 1, "就需要");
  await page.getByRole("button", { name: "添加笔记" }).click();
  await page.getByRole("textbox", { name: "划线笔记内容" }).fill("这里需要与下一段对照。");
  await page.getByRole("button", { name: "保存笔记" }).click();
  await expect(page.getByText("这里需要与下一段对照。")).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, "unit-reader.png"), fullPage: true });
  await page.goto("/notes");
  await expect(page.getByText("摘抄", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("这里需要与下一段对照。")).toBeVisible();
});

test("390px 小屏工作台不出现横向页面溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/books/book_learning");
  await expect(page.getByRole("heading", { name: "明确目标" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth + 1);
});

test("390px 小屏笔记页保留导出入口且不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/notes");
  await expect(page.getByRole("link", { name: "导出 Markdown" })).toBeVisible();
  await expect(page.getByRole("link", { name: "导出 JSON" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth + 1);
});

test("脑图按章节拆分并进入单元原文", async ({ page }) => {
  await page.goto("/books/book_learning/map");
  await expect(page.getByRole("heading", { name: "逻辑地图" })).toBeVisible();
  const chapter = page.locator('.react-flow__node').filter({ hasText: '明确目标' });
  await expect(chapter).toContainText('未拆分');
  await chapter.getByRole('button', { name: '拆分本章' }).click();
  const unit = page.locator('.react-flow__node').filter({ hasText: '点击阅读原文' });
  await expect(unit).toHaveCount(1, { timeout: 15000 });
  await unit.getByRole('link').click();
  await expect(page).toHaveURL(/\/units\//);
  await expect(page.getByText('一、原文')).toBeVisible();
});

test("可配置 OpenAI 兼容与 Anthropic 解析接口", async ({ page }) => {
  await page.goto("/settings/model");
  await expect(page.getByRole("heading", { name: "模型设置" })).toBeVisible();
  await page.getByRole("radio", { name: /OpenAI 兼容/ }).click();
  await page.getByLabel("API 地址", { exact: true }).fill("https://model.example/v1");
  await page.getByLabel("模型名称").fill("test-model");
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("test-key");
  await page.getByRole("button", { name: "保存模型设置" }).click();
  await expect(page.getByText("设置已保存，新任务会使用该模型。")).toBeVisible();
  await page.getByRole("radio", { name: "Anthropic" }).click();
  await expect(page.getByLabel("API 地址", { exact: true })).toHaveAttribute("placeholder", "https://api.anthropic.com");
});

test("四款图标可选择，默认第二款且刷新后保留选择", async ({ page }) => {
  await page.goto("/settings/model");
  await expect(page.getByRole("heading", { name: "应用图标" })).toBeVisible();
  await expect(page.locator(".app-icon-options button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "选择图标 2：分层阅读路径" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "选择图标 4：书签与分支" }).click();
  await expect(page.locator(".brand__mark img")).toHaveAttribute("src", "/icons/app-icon-4.png");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/icons/app-icon-4.png");
  await page.reload();
  await expect(page.getByRole("button", { name: "选择图标 4：书签与分支" })).toHaveAttribute("aria-pressed", "true");
});
