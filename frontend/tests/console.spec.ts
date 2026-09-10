import { test, expect } from "@playwright/test";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "../../backend");
const frontendDir = path.resolve(__dirname, "..");

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function waitForLine(proc: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), timeoutMs);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString().replace(ANSI_PATTERN, "");
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        resolve(match[1] ?? match[0]);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
    });
  });
}

// This test starts the real backend and a real Vite dev server, each on a
// free OS-assigned port (never a fixed one, see playwright.config.ts), seeds
// a small fixed set of allocations through the real /demo/seed endpoint
// (missing confirmation, quantity mismatch, missing affirmation, and one
// clean instructed allocation), and asserts the console names the exact
// blocking field for every at-risk row: this is the resume's "React console
// naming the exact field blocking every at-risk allocation" claim, checked
// end to end through a real headless browser, not a unit test of App.tsx in
// isolation.
test("console names the exact field blocking every at-risk allocation", async ({ page }) => {
  const backend = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, PORT: "0" },
    shell: true,
  });
  const backendPort = await waitForLine(backend, /LISTENING_ON (\d+)/);
  const backendBase = `http://127.0.0.1:${backendPort}`;

  const frontend = spawn("npx", ["vite", "--port", "0", "--strictPort", "false"], {
    cwd: frontendDir,
    env: { ...process.env, VITE_API_BASE: backendBase },
    shell: true,
  });
  const frontendUrl = await waitForLine(frontend, /Local:\s+(http:\/\/localhost:\d+\/)/);

  try {
    const seedRes = await fetch(`${backendBase}/demo/seed`, { method: "POST" });
    expect(seedRes.status).toBe(201);

    await page.goto(frontendUrl);
    await expect(page.getByTestId("at-risk-row")).toHaveCount(2, { timeout: 15_000 });

    const blockingFields = await page.getByTestId("blocking-field").allTextContents();
    expect(blockingFields.sort()).toEqual(
      ["missing affirmation from custodian", "quantity mismatch vs client instruction"].sort()
    );

    // The clean, instructed allocation must never appear as at-risk.
    const allocationIds = await page.getByTestId("at-risk-row").locator("td").allTextContents();
    expect(allocationIds.join(" ")).not.toContain("DEMO-CLEAN-INSTRUCTED");
  } finally {
    backend.kill();
    frontend.kill();
  }
});
