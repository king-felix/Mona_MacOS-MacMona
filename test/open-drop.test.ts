import { describe, expect, it } from "vitest";
import { selectDroppedPath } from "../src/renderer/shell/drop";

describe("folder drop rules", () => {
  const resolve = (file: unknown): string | null => (file as { path?: string }).path ?? null;

  it("accepts exactly one local folder", () => {
    expect(selectDroppedPath([{ path: "/Users/example/project" }], resolve)).toEqual({
      path: "/Users/example/project",
      error: null,
    });
  });

  it("refuses a multi-selection with the count in the reason", () => {
    const result = selectDroppedPath([{ path: "/a" }, { path: "/b" }, { path: "/c" }], resolve);
    expect(result.path).toBeNull();
    expect(result.error).toMatch(/one project at a time; 3 items/);
  });

  it("explains a dropped item with no reachable local path", () => {
    const result = selectDroppedPath([{ path: undefined }], resolve);
    expect(result.path).toBeNull();
    expect(result.error).toMatch(/File → Open Project/);
  });

  it("refuses a relative or non-local path before it ever reaches main", () => {
    const relative = selectDroppedPath([{ path: "project" }], resolve);
    expect(relative.path).toBeNull();
    expect(relative.error).toMatch(/local folder/);

    const remote = selectDroppedPath([{ path: "file://server/share" }], resolve);
    expect(remote.path).toBeNull();
  });

  it("reports an empty drop instead of doing nothing silently", () => {
    const result = selectDroppedPath([], resolve);
    expect(result.path).toBeNull();
    expect(result.error).toMatch(/no files/);
  });
});
