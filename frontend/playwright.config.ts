import { defineConfig } from "@playwright/test";

// No global webServer here on purpose: this project's servers (the Express
// backend and the Vite dev server) are started and stopped by the test
// itself, each on a free port discovered at run time. A fixed baseURL or a
// fixed port here would violate "never assume a port is free" (BUILDER.md
// section 3a). Only Playwright's own bundled, headless Chromium is used;
// nothing here launches or looks for a real browser.
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    headless: true,
  },
});
