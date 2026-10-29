import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(configDir, "../..");
const runId = `${Date.now()}-${process.pid}`;
const apiPort = Number(process.env.DUOBOOK_E2E_API_PORT ?? 8000);
const webPort = Number(process.env.DUOBOOK_E2E_WEB_PORT ?? 5173);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(root, "playwright-report"), open: "never" }],
    ["json", { outputFile: path.join(root, "test-results", "results.json") }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: `.venv/bin/uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port ${apiPort}`,
      cwd: root,
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        DUOBOOK_DB: path.join(root, "tmp", `duobook-e2e-${runId}.db`),
        DUOBOOK_UPLOAD_DIR: path.join(root, "tmp", `duobook-e2e-uploads-${runId}`),
      },
    },
    {
      command: `npm --workspace apps/web run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: root,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { DUOBOOK_API_PORT: String(apiPort), DUOBOOK_WEB_PORT: String(webPort) },
    },
  ],
});
