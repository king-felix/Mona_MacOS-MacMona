#!/usr/bin/env node
// Portable layout evidence; native macOS fullscreen/VoiceOver are separate.
// Install Playwright as a local dev tool or point MONA_BROWSER_TOOLS at its module.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
const require = createRequire(import.meta.url);
const { chromium } = process.env.MONA_BROWSER_TOOLS
  ? require(process.env.MONA_BROWSER_TOOLS)
  : require("playwright");
const root = resolve(new URL("..", import.meta.url).pathname);
const out = process.env.MONA_DECK_OUT || resolve(root, "out/studio-deck");
await mkdir(out, { recursive: true });
const server = await createServer({
  configFile: false,
  root,
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const results = [];
const errors = [];
function check(condition, message) {
  if (!condition) throw new Error(message);
}
async function geometry(page) {
  return await page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        bottom: b.bottom,
        right: b.right,
        scrollHeight: el.scrollHeight,
      };
    };
    return {
      window: { width: innerWidth, height: innerHeight },
      page: {
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
      },
      console: box(".studio__timeline"),
      prompt: box("textarea"),
      submit: box('[data-testid="studio-send"]'),
      controls: box(".composer__primary-controls"),
      inspector: !!document.querySelector(".studio__inspector"),
    };
  });
}
function bounded(g, label) {
  check(g.page.height <= g.window.height + 1, `${label}: document grew: ${JSON.stringify(g)}`);
  check(g.page.width <= g.window.width + 1, `${label}: horizontal document overflow`);
  check(g.console.height >= 45, `${label}: console collapsed`);
  check(g.prompt.bottom <= g.window.height + 1, `${label}: composer below viewport`);
  check(
    g.controls.bottom <= g.window.height && g.submit.right <= g.window.width,
    `${label}: controls escaped`,
  );
  check(!g.inspector, `${label}: inspector remains`);
}
try {
  for (const [width, height, focus, name] of [
    [1440, 1000, true, "focus"],
    [1440, 1000, false, "studio"],
    [960, 640, true, "focus-150"],
    [720, 500, true, "focus-200"],
    [640, 400, true, "focus-small"],
    [720, 500, false, "studio-200"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/fixtures/studio-deck.html?focus=${focus ? "on" : "off"}`,
    );
    await page.locator("textarea").waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const before = await geometry(page);
    bounded(before, name);
    await page.screenshot({ path: resolve(out, `${name}.png`) });
    // Message volume and a SINGLE enormous streaming item must both be bounded.
    await page.evaluate(() => window.deck.append());
    await page.waitForFunction(
      () => document.querySelector(".studio__timeline").scrollHeight > 3000,
    );
    const after = await geometry(page);
    bounded(after, `${name}-1200-events`);
    check(
      Math.abs(before.prompt.bottom - after.prompt.bottom) < 2,
      `${name}: output moved composer`,
    );
    await page.evaluate(() => window.deck.long());
    await page.waitForFunction(() =>
      document.querySelector(".studio__timeline").textContent.includes("A long live item"),
    );
    bounded(await geometry(page), `${name}-long-item`);
    await page.locator('[data-testid="composer-grip"]').focus();
    await page.keyboard.press("End");
    bounded(await geometry(page), `${name}-max-composer`);
    results.push({ name, before, after });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${server.resolvedUrls.local[0]}test/fixtures/studio-deck.html`);
  await page.locator("textarea").waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });
  check(
    (await page
      .locator(".agent-signal__orb")
      .evaluate((el) => getComputedStyle(el, "::after").animationName)) === "none",
    "reduced motion ignored",
  );
  await page.evaluate(() => window.deck.quiet());
  await page.getByText("Waiting · no recent activity", { exact: true }).waitFor();
  check(
    (await page.locator(".agent-signal").getAttribute("data-animated")) === "false",
    "stale signal animates",
  );
  await page.evaluate(() => window.deck.notice());
  await page.locator(".toast").waitFor();
  await page.locator(".toast").waitFor({ state: "detached", timeout: 7000 });
  await page.evaluate(() => window.deck.ready());
  await page.locator("textarea").fill("A new prompt");
  await page.keyboard.press("Enter");
  check(
    (await page.locator("textarea").inputValue()).endsWith("\n"),
    "Enter did not insert newline",
  );
  await page.keyboard.press("Meta+Enter");
  await page.getByText("Submitted (local fixture)", { exact: false }).waitFor();
  await page.close();
  check(errors.length === 0, `browser errors: ${errors.join("; ")}`);
  await writeFile(
    resolve(out, "report.json"),
    JSON.stringify(
      {
        platform: process.platform,
        renderer: "Chromium; CSS viewport equivalents for 100/150/200% zoom",
        providerRequests: 0,
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: ${results.length} viewport scenarios, 1200 events, 8000-line item, composer resize, reduced motion, stale signal, toast expiry, Enter and Command-Enter. Evidence: ${out}`,
  );
} finally {
  await browser.close();
  await server.close();
}
