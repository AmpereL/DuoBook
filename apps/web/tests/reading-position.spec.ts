import { expect, test, type Page } from "@playwright/test";

async function importBook(page: Page) {
  const nonce = `${Date.now()}-${Math.random()}`;
  const text = [1, 2, 3].map((chapter) => `第${chapter}章 位置恢复${chapter}\n\n` + Array.from({ length: 30 }, (_, index) => `段落${chapter}-${index + 1}。${"这是完整原文，用来验证滚动到某个段落后可以准确恢复阅读位置。".repeat(5)}${nonce}`).join("\n\n")).join("\n\n");
  const response = await page.request.post("/api/v1/books/upload", { multipart: { file: { name: `resume-${nonce}.txt`, mimeType: "text/plain", buffer: Buffer.from(text) } } });
  expect(response.ok()).toBe(true);
  const { book, structure } = await response.json();
  await page.request.patch(`/api/v1/books/${book.id}/structure`, { data: { title: book.title, author: book.author, chapters: structure.chapters.map((chapter: any) => ({ ...chapter, include: true })) } });
  return { book, chapters: structure.chapters as Array<{ id: string; title: string }> };
}
async function ready(page: Page) { await expect(page.locator("main[data-reading-position-ready='true']")).toBeVisible(); }
async function scrollTo(page: Page, selector: string, progress = .4) {
  await page.locator(selector).evaluate((element, progress) => {
    const rect = element.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top + rect.height * progress - Math.min(240, innerHeight * .3), behavior: "instant" });
  }, progress);
}
async function position(page: Page, bookId: string) { return (await (await page.request.get(`/api/v1/books/${bookId}/reading-position`)).json()).position; }

test("返回书架与新浏览器会话打开书籍，恢复章节、段落和段内比例", async ({ page, browser }) => {
  const { book, chapters } = await importBook(page);
  await page.goto(`/books/${book.id}/chapters/${chapters[1].id}`);
  await ready(page);
  const paragraph = page.locator("[data-reading-paragraph]").nth(12);
  const id = await paragraph.getAttribute("data-reading-paragraph");
  await scrollTo(page, `#paragraph-${id}`);
  await expect.poll(async () => (await position(page, book.id))?.paragraph_id).toBe(id);
  await page.getByRole("link", { name: "我的书架", exact: true }).click();
  await expect(page.locator(".continue-card")).toContainText(chapters[1].title);
  await page.getByRole("button", { name: `打开${book.title}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(chapters[1].id));
  await ready(page);
  const ratio = await paragraph.evaluate((element) => (Math.min(240, innerHeight * .3) - element.getBoundingClientRect().top) / element.getBoundingClientRect().height);
  expect(ratio).toBeCloseTo(.4, 1);
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    await fresh.goto(new URL(`/books/${book.id}`, page.url()).toString());
    await expect(fresh).toHaveURL(new RegExp(chapters[1].id));
    await ready(fresh);
    await expect(fresh.locator(`#paragraph-${id}`)).toBeInViewport();
  } finally { await context.close(); }
});

test("显式目录和原文链接优先，恢复记录不会把用户跳回旧章节", async ({ page }) => {
  const { book, chapters } = await importBook(page);
  await page.goto(`/books/${book.id}/chapters/${chapters[1].id}`); await ready(page);
  const id = await page.locator("[data-reading-paragraph]").nth(10).getAttribute("data-reading-paragraph");
  await scrollTo(page, `#paragraph-${id}`);
  await expect.poll(async () => (await position(page, book.id))?.paragraph_id).toBe(id);
  await page.getByTestId("chapter-row").first().click(); await ready(page);
  await expect(page).toHaveURL(new RegExp(chapters[0].id));
  const source = await (await page.request.get(`/api/v1/books/${book.id}/chapters/${chapters[0].id}`)).json();
  const target = source.paragraphs[17].id;
  await page.goto(`/books/${book.id}/chapters/${chapters[0].id}#paragraph-${target}`); await ready(page);
  await expect(page.locator(`#paragraph-${target}`)).toBeInViewport();
  await expect.poll(async () => (await position(page, book.id))?.paragraph_id).toBe(target);
});

test("单行阅读写入数据库，书架打开回到对应原文且不自动发声", async ({ page }) => {
  const { book, chapters } = await importBook(page);
  await page.goto(`/compact/books/${book.id}/chapters/${chapters[1].id}`);
  const text = page.getByTestId("compact-text");
  await expect(text).toHaveAttribute("data-start");
  for (let index = 0; index < 4; index++) await page.getByRole("button", { name: "下一行", exact: true }).click();
  const id = await text.getAttribute("data-paragraph-id");
  const offset = Number(await text.getAttribute("data-start"));
  await expect.poll(async () => (await position(page, book.id))?.character_offset).toBe(offset);
  await page.getByRole("button", { name: "更多阅读设置" }).click();
  await page.getByRole("button", { name: "返回完整阅读" }).click(); await ready(page);
  await page.getByRole("link", { name: "我的书架", exact: true }).click();
  await page.getByRole("button", { name: `打开${book.title}`, exact: true }).click(); await ready(page);
  await expect(page).toHaveURL(new RegExp(chapters[1].id));
  await expect(page.locator(`#paragraph-${id}`)).toBeInViewport();
  await expect(page.getByLabel("朗读状态", { exact: true })).not.toContainText("正在朗读");
});

test("阅读单元及九段笔记区域可以从书架恢复，重拆后保留原版本", async ({ page }) => {
  const { book, chapters } = await importBook(page);
  await page.request.put("/api/v1/settings/model", { data: { provider: "local", base_url: "", model: "", timeout: 60 } });
  const job = await (await page.request.post(`/api/v1/books/${book.id}/chapters/${chapters[0].id}/split-runs`)).json();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/jobs/${job.id}`)).json()).status, { timeout: 20000 }).toBe("completed");
  const chapter = await (await page.request.get(`/api/v1/books/${book.id}/chapters/${chapters[0].id}`)).json();
  const unit = chapter.units[0];
  await page.goto(`/books/${book.id}/units/${unit.id}`); await ready(page);
  await scrollTo(page, "[data-reading-section='8']");
  await page.locator("[data-reading-section='8'] textarea").focus();
  await expect.poll(async () => (await position(page, book.id))?.section_ordinal).toBe(8);
  await page.getByRole("link", { name: "我的书架", exact: true }).click();
  await page.getByRole("button", { name: `打开${book.title}`, exact: true }).click(); await ready(page);
  await expect(page).toHaveURL(new RegExp(unit.id));
  await expect(page.locator("[data-reading-section='8']")).toBeInViewport();
  const resplit = await (await page.request.post(`/api/v1/books/${book.id}/chapters/${chapters[0].id}/split-runs`)).json();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/jobs/${resplit.id}`)).json()).status, { timeout: 20000 }).toBe("completed");
  await page.goto(`/books/${book.id}`); await ready(page);
  await expect(page).toHaveURL(new RegExp(unit.id));
  await expect(page.locator("[data-reading-section='8']")).toBeInViewport();
});
