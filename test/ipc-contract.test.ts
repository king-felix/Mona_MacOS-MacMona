import { describe, expect, it } from "vitest";
import { IpcContractError, validateIpc } from "../src/main/ipc-contract";

describe("IPC validation", () => {
  it("accepts an empty strict payload for app:info", () => {
    expect(validateIpc("app:info", {})).toEqual({});
  });

  it("rejects an unknown channel", () => {
    expect(() => validateIpc("shell:run", {})).toThrow(IpcContractError);
    try {
      validateIpc("shell:run", {});
    } catch (error) {
      expect((error as IpcContractError).code).toBe("UNKNOWN_CHANNEL");
    }
  });

  it("rejects unknown fields", () => {
    expect(() => validateIpc("app:info", { exec: "rm -rf /" })).toThrow(/malformed/i);
  });

  it("rejects a non-object payload", () => {
    expect(() => validateIpc("app:info", "hello")).toThrow();
    expect(() => validateIpc("app:paths", null)).toThrow();
  });

  it("validates tool names and caps the list", () => {
    expect(validateIpc("tools:discover", { names: ["codewhale", "git"] })).toEqual({
      names: ["codewhale", "git"],
    });
    expect(() => validateIpc("tools:discover", { names: ["../evil"] })).toThrow();
    expect(() => validateIpc("tools:discover", { names: ["a".repeat(65)] })).toThrow();
    expect(() =>
      validateIpc("tools:discover", { names: Array.from({ length: 17 }, (_, i) => `t${i}`) }),
    ).toThrow();
  });
});

describe("project IPC validation", () => {
  const projectId = "prj_0123456789abcdef";

  it("accepts catalog reads and rejects unknown fields", () => {
    expect(validateIpc("projects:list", { query: "mona", includeArchived: true })).toEqual({
      query: "mona",
      includeArchived: true,
    });
    expect(() => validateIpc("projects:list", { path: "/tmp" })).toThrow();
    expect(validateIpc("projects:detail", { projectId })).toEqual({ projectId });
    expect(() => validateIpc("projects:detail", { projectId: "thr_0123456789abcdef" })).toThrow();
  });

  it("validates mutations with revisions and rejects destructive channels", () => {
    expect(
      validateIpc("projects:rename", { projectId, name: "New label", expectedRevision: 2 }),
    ).toEqual({ projectId, name: "New label", expectedRevision: 2 });
    expect(() =>
      validateIpc("projects:rename", { projectId, name: "New label", expectedRevision: 0 }),
    ).toThrow();
    expect(() =>
      validateIpc("projects:rename", { projectId, name: "", expectedRevision: 1 }),
    ).toThrow();
    expect(
      validateIpc("projects:pin", { projectId, pinned: true, expectedRevision: 1 }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("projects:archive", { projectId, archived: "yes", expectedRevision: 1 }),
    ).toThrow();
    expect(validateIpc("projects:remove", { projectId, expectedRevision: 3 })).toBeTruthy();
    expect(validateIpc("projects:relocate", { projectId, expectedRevision: 3 })).toBeTruthy();
    expect(validateIpc("projects:reveal", { projectId })).toBeTruthy();
    expect(() => validateIpc("projects:delete-folder", { projectId })).toThrow(IpcContractError);
    expect(() =>
      validateIpc("projects:remove", { projectId, expectedRevision: 3, deleteFiles: true }),
    ).toThrow();
  });

  it("validates view state and drafts", () => {
    expect(validateIpc("projects:view", { projectId, view: { screen: "cost" } })).toEqual({
      projectId,
      view: { screen: "cost" },
    });
    expect(
      validateIpc("projects:draft", { projectId, threadId: "thr_0123456789abcdef", text: "" }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("projects:draft", {
        projectId,
        threadId: "thr_0123456789abcdef",
        text: "x".repeat(200_001),
      }),
    ).toThrow();
    expect(validateIpc("runtime:status", {})).toEqual({});
    expect(validateIpc("state:facts", {})).toEqual({});
  });
});

describe("studio IPC validation", () => {
  const projectId = "prj_0123456789abcdef";

  it("accepts explicit studio actions and rejects smuggling", () => {
    expect(validateIpc("studio:state", { projectId })).toEqual({ projectId });
    expect(validateIpc("studio:start", { projectId })).toEqual({ projectId });
    expect(
      validateIpc("studio:submit", { projectId, prompt: "Do one thing", mode: "plan" }),
    ).toEqual({ projectId, prompt: "Do one thing", mode: "plan" });
    expect(() => validateIpc("studio:submit", { projectId, prompt: "x", mode: "root" })).toThrow();
    expect(() => validateIpc("studio:submit", { projectId, prompt: "", mode: "work" })).toThrow();
    expect(() =>
      validateIpc("studio:submit", { projectId, prompt: "x", mode: "work", autoApprove: true }),
    ).toThrow();
    expect(() =>
      validateIpc("studio:submit", { projectId, prompt: "x".repeat(100_001), mode: "work" }),
    ).toThrow();
    for (const channel of [
      "studio:interrupt",
      "studio:pause",
      "studio:resume-queue",
      "studio:cancel-queued",
      "studio:reconcile",
      "studio:stop",
    ]) {
      expect(validateIpc(channel, { projectId })).toEqual({ projectId });
    }
    expect(() => validateIpc("studio:interrupt", { projectId, turnId: "turn_1" })).toThrow();
    expect(() => validateIpc("studio:start", { projectId: "thr_0123456789abcdef" })).toThrow();
  });
});
