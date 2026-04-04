import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4321",
    browserName: "chromium",
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:4321",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
