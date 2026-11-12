// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent, TerminalSnapshot } from "../src/shared/contracts/terminal";
import { TerminalPanel } from "../src/renderer/shell/TerminalPanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const baseSnapshot = (overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
  available: true,
  unavailableReason: null,
  sessions: [],
  activeSessionId: null,
  environment: {
    shell: "/bin/zsh",
    arguments: ["-f"],
    startupFiles: "not_sourced",
    path: "/usr/bin:/bin",
    variables: ["PATH", "HOME", "TERM"],
    withheld: ["DEEPSEEK_API_KEY"],
    note: "allowlist",
  },
  limits: {
    maxSessions: 3,
    replayBytes: 262_144,
    replayLines: 5_000,
    sessionBytes: 67_108_864,
    inputBytes: 8_192,
    searchMatches: 200,
    logTailBytes: 131_072,
    minCols: 20,
    maxCols: 500,
    minRows: 4,
    maxRows: 300,
  },
  engineTerminalNote: "attach only",
  ...overrides,
});

const session = {
  id: "term_0123456789abcdef",
  title: "zsh",
  projectId: null,
  cwd: "/Users/example/project",
  status: "running" as const,
  cols: 100,
  rows: 30,
  createdAt: "2026-11-12T00:00:00.000Z",
  startedAt: "2026-11-12T00:00:00.000Z",
  endedAt: null,
  exitCode: null,
  exitSignal: null,
  helperPid: 100,
  shellPid: 101,
  bytesOut: 42,
  droppedBytes: 0,
  replayBytes: 42,
  truncated: false,
  limitReason: null,
  helper: "mona-pty" as const,
  note: "native",
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const listeners: Array<(event: TerminalEvent) => void> = [];
  const bridge = {
    terminalSnapshot: vi.fn(async () => ({ ok: true, value: baseSnapshot() })),
    terminalCreate: vi.fn(async () => ({
      ok: true,
      value: {
        snapshot: baseSnapshot({ sessions: [session], activeSessionId: session.id }),
        sessionId: session.id,
      },
    })),
    terminalOutput: vi.fn(async () => ({
      ok: true,
      value: {
        sessionId: session.id,
        offset: 0,
        nextCursor: 12,
        total: 12,
        dropped: 0,
        data: "hello world\n",
        truncated: false,
        status: "running",
        exitCode: null,
      },
    })),
    terminalWrite: vi.fn(async () => ({ ok: true, value: { written: 4 } })),
    terminalResize: vi.fn(async () => ({ ok: true, value: session })),
    terminalClose: vi.fn(async () => ({ ok: true, value: session })),
    terminalSearch: vi.fn(async () => ({
      ok: true,
      value: {
        query: "hello",
        matches: [{ sessionId: session.id, index: 0, line: 0, text: "hello world" }],
        truncated: false,
        scannedBytes: 12,
      },
    })),
    terminalLog: vi.fn(async () => ({
      ok: true,
      value: {
        available: true,
        reason: null,
        path: "~/Library/Logs/Mona/run.log",
        bytes: 20,
        truncated: false,
        text: "engine started\n",
        readAt: "2026-11-12T00:00:00.000Z",
      },
    })),
    onTerminalEvent: (callback: (event: TerminalEvent) => void) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    ...overrides,
  };
  (globalThis as unknown as { window: { mona: unknown } }).window.mona = bridge;
  return { bridge, listeners };
}

async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  }
}

describe("TerminalPanel", () => {
  it("offers to start a shell and starts one only on request", async () => {
    const { bridge } = installBridge();
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    expect(container!.textContent).toContain("No shell yet");
    expect(bridge.terminalCreate).not.toHaveBeenCalled();
    const create = [...container!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("New shell"),
    );
    act(() => create!.click());
    await settle();
    expect(bridge.terminalCreate).toHaveBeenCalledTimes(1);
  });

  it("replays the session buffer and keeps escape sequences inert", async () => {
    installBridge({
      terminalSnapshot: vi.fn(async () => ({
        ok: true,
        value: baseSnapshot({ sessions: [session], activeSessionId: session.id }),
      })),
      terminalOutput: vi.fn(async () => ({
        ok: true,
        value: {
          sessionId: session.id,
          offset: 0,
          nextCursor: 30,
          total: 30,
          dropped: 0,
          data: "\u001b]8;;file:///etc/passwd\u0007click me\u001b]8;;\u0007\n\u001b[31mred\u001b[0m\n",
          truncated: false,
          status: "running",
          exitCode: null,
        },
      })),
    });
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    const transcript = container!.querySelector('[data-testid="terminal-transcript"]');
    expect(transcript?.textContent).toContain("click me");
    expect(transcript?.textContent).not.toContain("file:///etc/passwd");
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.querySelector(".terminal__span--error")?.textContent).toBe("red");
  });

  it("sends a typed line on Return and never on render", async () => {
    const { bridge } = installBridge({
      terminalSnapshot: vi.fn(async () => ({
        ok: true,
        value: baseSnapshot({ sessions: [session], activeSessionId: session.id }),
      })),
    });
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    const input = container!.querySelector<HTMLInputElement>('[data-testid="terminal-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "echo hi");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(bridge.terminalWrite).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(bridge.terminalWrite).toHaveBeenCalledWith({
      sessionId: session.id,
      data: "echo hi\n",
    });
  });

  it("searches the buffer through the main process", async () => {
    const { bridge } = installBridge({
      terminalSnapshot: vi.fn(async () => ({
        ok: true,
        value: baseSnapshot({ sessions: [session], activeSessionId: session.id }),
      })),
    });
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    const searchInput = container!.querySelector<HTMLInputElement>("#terminal-search")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(searchInput, "hello");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const find = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Find",
    );
    await act(async () => {
      find!.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(bridge.terminalSearch).toHaveBeenCalledWith({ sessionId: session.id, query: "hello" });
    expect(
      container!.querySelector('[data-testid="terminal-search-count"]')?.textContent,
    ).toContain("1 match");
  });

  it("shows the engine log read-only without offering input", async () => {
    const { bridge } = installBridge();
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={"prj_0123456789abcdef" as never}
          open
          mode="log"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    expect(bridge.terminalLog).toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="terminal-log-text"]')?.textContent).toContain(
      "engine started",
    );
    expect(container!.querySelector('[data-testid="terminal-input"]')).toBeNull();
    expect(container!.textContent).toContain("read-only");
  });

  it("clamps the requested window instead of sending a schema-rejected create", async () => {
    const { bridge } = installBridge();
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    const sizeInputs = [...container!.querySelectorAll<HTMLInputElement>(".terminal__size input")];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(sizeInputs[0], "10");
      sizeInputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(sizeInputs[1], "1000");
      sizeInputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const create = [...container!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("New shell"),
    );
    await act(async () => {
      create!.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(bridge.terminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 20, rows: 300 }),
    );
  });

  it("shows a refusal as an error and never leaves the pane busy", async () => {
    const { bridge } = installBridge({
      terminalCreate: vi.fn(async () => {
        throw new Error("malformed payload");
      }),
    });
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    const create = [...container!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("New shell"),
    );
    await act(async () => {
      create!.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(bridge.terminalCreate).toHaveBeenCalled();
    expect(container!.textContent).toContain("refused before it reached the terminal");
    const retry = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("New shell"),
    );
    expect(retry?.disabled).toBe(false);
  });

  it("shows an initial snapshot refusal and never renders a silent empty pane", async () => {
    installBridge({
      terminalSnapshot: vi.fn(async () => {
        throw new Error("disposed frame");
      }),
    });
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    expect(container!.textContent).toContain("refused before it reached the terminal");
  });

  it("does not render replay and live bytes twice on reconnect", async () => {
    let resolveOutput: (value: unknown) => void = () => undefined;
    const { listeners } = installBridge({
      terminalSnapshot: vi.fn(async () => ({
        ok: true,
        value: baseSnapshot({ sessions: [session], activeSessionId: session.id }),
      })),
      terminalOutput: vi.fn(
        () =>
          new Promise((resolvePromise) => {
            resolveOutput = resolvePromise;
          }),
      ),
    });
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    // Two live pushes arrive while the replay read is still in flight: one is
    // already inside the replay (seq 2), one is newer (seq 3).
    await act(async () => {
      for (const listener of listeners) {
        listener({
          sessionId: session.id,
          seq: 2,
          kind: "output",
          status: "running",
          data: "already-in-replay\n",
        });
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    await act(async () => {
      resolveOutput({
        ok: true,
        value: {
          sessionId: session.id,
          offset: 0,
          nextCursor: 40,
          total: 40,
          dropped: 0,
          data: "already-in-replay\n",
          truncated: false,
          status: "running",
          exitCode: null,
          seq: 2,
        },
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    const transcript =
      container!.querySelector('[data-testid="terminal-transcript"]')?.textContent ?? "";
    expect(transcript.split("already-in-replay").length - 1).toBe(1);
    // A later push is still rendered.
    await act(async () => {
      for (const listener of listeners) {
        listener({
          sessionId: session.id,
          seq: 3,
          kind: "output",
          status: "running",
          data: "after-replay\n",
        });
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(container!.querySelector('[data-testid="terminal-transcript"]')?.textContent).toContain(
      "after-replay",
    );
  });

  it("states the exact environment and the limits instead of implying a login shell", async () => {
    installBridge();
    act(() =>
      root!.render(
        <TerminalPanel
          projectId={null}
          open
          mode="shell"
          prefill={null}
          onMode={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await settle();
    expect(container!.textContent).toContain("startup files not sourced");
    expect(container!.textContent).toContain("/bin/zsh -f");
    expect(container!.textContent).toContain("full-screen programs are not emulated");
  });
});
