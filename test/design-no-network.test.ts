import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER = resolve("src/renderer");

function files(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...files(path));
    else result.push(path);
  }
  return result;
}

describe("zero external assets and zero inference in the renderer", () => {
  const sources = files(RENDERER).map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));

  it("contains no fetch, XHR, beacon, or WebSocket calls", () => {
    const offenders = sources.filter(({ text }) =>
      /\bfetch\s*\(|new\s+XMLHttpRequest|sendBeacon\s*\(|new\s+WebSocket\s*\(/.test(text),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("loads no remote fonts, stylesheets, scripts, or images", () => {
    const offenders = sources.filter(({ text }) =>
      /@font-face|@import\s+url\(\s*["']?https?:|url\(\s*["']?https?:|<script[^>]+src=["']https?:|<link[^>]+href=["']https?:|<img[^>]+src=["']https?:/i.test(
        text,
      ),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("uses only local system fonts", () => {
    const css = readFileSync(join(RENDERER, "styles.css"), "utf8");
    expect(css).toContain("-apple-system");
    expect(css).toContain("ui-monospace");
    expect(css).not.toMatch(/font-family:[^;]*url\(/);
  });

  it("keeps the content policy closed to network connections", () => {
    const html = readFileSync(join(RENDERER, "index.html"), "utf8");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("default-src 'self'");
    expect(statSync(join(RENDERER, "index.html")).isFile()).toBe(true);
  });
});
