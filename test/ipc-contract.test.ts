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
