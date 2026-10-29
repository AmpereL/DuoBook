import { expect, test, type Page } from "@playwright/test";

async function importLongDirectory(page: Page) {
  const nonce = `${Date.now()}-${Math.random()}`;
  const text = Array.from({ length: 40 }, (_, index) => `第${index + 1}章 目录导航测试${index + 1}\n\n这是第${index + 1}章的完整原文，用来验证切换章节时目录位置保持不变。测试批次${nonce}。`).join("\n\n");
  const response = await page.request.post("/api/v1/books/upload", { multipart: {
    file: { name: `navigation-${Date.now()}.txt`, mimeType: "text/plain", buffer: Buffer.from(text) },
  } });
  expect(response.ok()).toBe(true);
  const { book, structure } = await response.json();
  const chapters: Array<{ id: string; title: string; ordinal: number }> = structure.chapters;
  expect(chapters).toHaveLength(40);
  const confirmed = await page.request.patch(`/api/v1/books/${book.id}/structure`, {
    data: { title: book.title, author: book.author, chapters: chapters.map((chapter) => ({ ...chapter, include: true })) },
  });
  expect(confirmed.ok()).toBe(true);
  return { bookId: book.id as string, chapters };
}

test("长目录切章时保留同一个侧栏和滚动位置，刷新后也恢复", async ({ page }) => {
  const { bookId, chapters } = await importLongDirectory(page);
  const chapterPath = (index: number) => `/books/${bookId}/chapters/${chapters[index].id}`;
  await page.goto(chapterPath(0));
  await expect(page.getByRole("heading", { name: chapters[0].title, exact: true })).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "章节列表" });
  const target = sidebar.getByTestId("chapter-row").nth(24);
  await target.scrollIntoViewIfNeeded();
  const before = await sidebar.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(500);
  await sidebar.evaluate((element) => { (window as any).__directoryNode = element; });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/v1/books/${bookId}/chapters/${chapters[24].id}`, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await target.click();
    await expect(page.getByRole("status").filter({ hasText: "正在打开章节内容" })).toBeVisible();
    await expect(sidebar).toBeVisible();
    expect(await sidebar.evaluate((element) => element === (window as any).__directoryNode)).toBe(true);
    expect(await sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
    await expect(target).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: chapters[0].title, exact: true })).toBeHidden();
  } finally { release(); }
  await expect(page.getByRole("heading", { name: chapters[24].title, exact: true })).toBeVisible();
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  await page.reload();
  await expect(page.getByRole("heading", { name: chapters[24].title, exact: true })).toBeVisible();
  await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  await page.goto("/library");
  await page.goto(chapterPath(24));
  await expect(page.getByRole("heading", { name: chapters[24].title, exact: true })).toBeVisible();
  await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
});

test("小屏横向章节目录切章后保留横向滚动位置", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { bookId, chapters } = await importLongDirectory(page);
  await page.goto(`/books/${bookId}/chapters/${chapters[0].id}`);
  const nav = page.locator(".workbench-chapters nav");
  const target = nav.getByTestId("chapter-row").nth(18);
  await target.scrollIntoViewIfNeeded();
  const before = await nav.evaluate((element) => element.scrollLeft);
  expect(before).toBeGreaterThan(500);
  await target.click();
  await expect(page.getByRole("heading", { name: chapters[18].title, exact: true })).toBeVisible();
  expect(await nav.evaluate((element) => element.scrollLeft)).toBeCloseTo(before, 0);
  await page.reload();
  await expect(page.getByRole("heading", { name: chapters[18].title, exact: true })).toBeVisible();
  await expect.poll(() => nav.evaluate((element) => element.scrollLeft)).toBeCloseTo(before, 0);
});

test("阅读单元切换时目录保持位置，等待期间不显示旧原文或编辑器", async ({ page }) => {
  const book = await (await page.request.get("/api/v1/books/book_learning")).json();
  const units = Array.from({ length: 40 }, (_, index) => ({
    id: `unit_nav_${index + 1}`, unit_set_id: "set_nav", chapter_id: "chapter_nav", ordinal: index + 1,
    title: `阅读单元导航${index + 1}`, statement: `第${index + 1}个单元的完整意思。`, status: "published",
  }));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let delayTarget = true;
  await page.route("**/api/v1/reading-units/unit_nav_*", async (route) => {
    const id = route.request().url().split("/").at(-1);
    const unit = units.find((item) => item.id === id)!;
    if (id === units[24].id && delayTarget) { await gate; delayTarget = false; }
    await route.fulfill({ json: {
      book, chapter: { id: "chapter_nav", title: "测试章节", units, unit_set: null }, unit,
      paragraphs: [{ id: `p_${id}`, ordinal: 1, text: `这是${unit.title}的原文。` }], annotations: [],
      sections: [
        { id: `s1_${id}`, ordinal: 1, title: "原文", kind: "original", body: "" },
        { id: `s8_${id}`, ordinal: 8, title: "八、你的理解/疑问", kind: "reflection", body: "" },
      ],
    } });
  });
  await page.goto(`/books/book_learning/units/${units[0].id}`);
  await expect(page.getByRole("heading", { name: units[0].title, exact: true })).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "阅读单元目录" });
  const target = sidebar.getByRole("link").filter({ hasText: units[24].title });
  await target.scrollIntoViewIfNeeded();
  const before = await sidebar.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(100);
  await sidebar.evaluate((element) => { (window as any).__unitDirectory = element; });
  try {
    await target.click();
    await expect(page.getByRole("status").filter({ hasText: "正在打开阅读单元" })).toBeVisible();
    expect(await sidebar.evaluate((element) => element === (window as any).__unitDirectory)).toBe(true);
    expect(await sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
    await expect(page.getByLabel("八、你的理解/疑问")).toBeHidden();
    await expect(page.getByText(`这是${units[0].title}的原文。`, { exact: true })).toBeHidden();
  } finally { release(); }
  await expect(page.getByRole("heading", { name: units[24].title, exact: true })).toBeVisible();
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  await page.reload();
  await expect(page.getByRole("heading", { name: units[24].title, exact: true })).toBeVisible();
  await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
});
