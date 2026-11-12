import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts/ids";
import type { TerminalEvent } from "../src/shared/contracts/terminal";
import { TerminalManager } from "../src/main/terminal/session";
import type { PtyExit, PtyHost, PtySpawnOptions, ShellEnvironment } from "../src/main/terminal/pty";
import { buildShellEnvironment, resolvePtyBinary, spawnPty } from "../src/main/terminal/pty";

const ENV: ShellEnvironment = {
  entries: ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  variables: ["PATH", "HOME"],
  withheld: [],
  path: "/usr/bin:/bin",
};

class FakeHost implements PtyHost {
  readonly pid = 4242;
  readonly startedAt = new Date().toISOString();
  readonly written: Buffer[] = [];
  readonly resized: Array<{ cols: number; rows: number }> = [];
  readonly killed: string[] = [];
  terminated = false;
  closed = false;
  exited = false;
  private outputCallback: ((bytes: Buffer) => void) | null = null;
  private exitCallback: ((exit: PtyExit) => void) | null = null;
  private settle: (exit: PtyExit) => void = () => {};
  readonly exit: Promise<PtyExit>;
  readonly options: PtySpawnOptions;

  constructor(options: PtySpawnOptions) {
    this.options = options;
    this.exit = new Promise<PtyExit>((resolvePromise) => {
      this.settle = resolvePromise;
    });
  }

  shellPid(): number | null {
    return this.pid;
  }
  write(bytes: Buffer): void {
    this.written.push(Buffer.from(bytes));
  }
  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows });
  }
  kill(signal: "INT" | "TERM" | "KILL" | "HUP"): void {
    this.killed.push(signal);
  }
  terminate(): void {
    this.terminated = true;
  }
  onOutput(callback: (bytes: Buffer) => void): void {
    this.outputCallback = callback;
  }
  onExit(callback: (exit: PtyExit) => void): void {
    this.exitCallback = callback;
  }
  onError(): void {}
  close(): void {
    this.closed = true;
  }

  emit(text: string): void {
    this.outputCallback?.(Buffer.from(text));
  }
  finish(exit: PtyExit): void {
    this.exited = true;
    this.exitCallback?.(exit);
    this.settle(exit);
  }
}

function manager(options: { limits?: Record<string, number> } = {}) {
  const hosts: FakeHost[] = [];
  const events: TerminalEvent[] = [];
  const instance = new TerminalManager({
    environment: ENV,
    workspaceFor: async () => "/tmp/mona-workspace",
    limits: options.limits,
    emit: (event) => events.push(event),
    spawn: async (spawnOptions) => {
      const host = new FakeHost(spawnOptions);
      hosts.push(host);
      return host;
    },
  });
  return { instance, hosts, events };
}

describe("TerminalManager", () => {
  it("creates a session in the project workspace and reports the real environment", async () => {
    const { instance, hosts } = manager();
    const created = await instance.create({ projectId: "p_000000000000000000000000" as ProjectId });
    expect(created.snapshot.sessions).toHaveLength(1);
    const session = created.snapshot.sessions[0]!;
    expect(session.status).toBe("running");
    expect(session.helper).toBe("mona-pty");
    expect(session.cwd).toBe("/tmp/mona-workspace");
    expect(session.helperPid).toBe(4242);
    expect(hosts[0]?.options.environment.entries).not.toContain("DEEPSEEK_API_KEY=x");
    expect(created.snapshot.environment.startupFiles).toBe("not_sourced");
    expect(created.snapshot.environment.arguments).toEqual(["-f"]);
  });

  it("streams output, keeps a replay, and never re-orders it", async () => {
    const { instance, hosts, events } = manager();
    const created = await instance.create({});
    hosts[0]!.emit("hello\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    const replay = instance.output(created.sessionId, 0);
    expect(replay.data).toBe("hello\n");
    expect(replay.nextCursor).toBe(6);
    expect(events.some((event) => event.kind === "output" && event.data?.includes("hello"))).toBe(
      true,
    );
    const tail = instance.output(created.sessionId, replay.nextCursor);
    expect(tail.data).toBe("");
  });

  it("flushes pending output before a read so replay and live events cannot overlap", async () => {
    const { instance, hosts, events } = manager();
    const created = await instance.create({});
    // Emit and read inside the batching window: the read must not include bytes
    // that no event has announced, or a reconnecting pane would draw them twice.
    hosts[0]!.emit("racy\n");
    const read = instance.output(created.sessionId, 0);
    expect(read.data).toBe("racy\n");
    expect(read.seq).toBeGreaterThan(0);
    const announced = events.filter((event) => event.kind === "output" && event.data);
    expect(announced.map((event) => event.data).join("")).toBe("racy\n");
    expect(announced.every((event) => event.seq <= read.seq)).toBe(true);
    // The timer flush that follows has nothing left to announce.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    const again = events.filter((event) => event.kind === "output" && event.data);
    expect(again.map((event) => event.data).join("")).toBe("racy\n");
  });

  it("writes bytes, refuses oversized input, and resizes the pty", async () => {
    const { instance, hosts } = manager();
    const created = await instance.create({});
    expect(instance.write(created.sessionId, "echo hi\n")).toBe(8);
    expect(hosts[0]?.written.map((chunk) => chunk.toString()).join("")).toBe("echo hi\n");
    expect(() => instance.write(created.sessionId, "x".repeat(10_000))).toThrow(/larger/);
    const view = instance.resize(created.sessionId, 132, 43);
    expect(view.cols).toBe(132);
    expect(view.rows).toBe(43);
    expect(hosts[0]?.resized).toEqual([{ cols: 132, rows: 43 }]);
  });

  it("reports an observed exit with its code and never claims a failure that did not happen", async () => {
    const { instance, hosts, events } = manager();
    const created = await instance.create({});
    hosts[0]!.emit("partial output\n");
    hosts[0]!.finish({ code: 3, signal: null });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const session = instance.list()[0]!;
    expect(session.status).toBe("exited");
    expect(session.exitCode).toBe(3);
    expect(session.endedAt).not.toBeNull();
    expect(instance.output(created.sessionId, 0).data).toContain("partial output");
    expect(events.some((event) => event.kind === "exit" && event.exitCode === 3)).toBe(true);
    expect(() => instance.write(created.sessionId, "x")).toThrow(/no longer running/);
  });

  it("stops a session that exceeds its byte budget with a stated reason", async () => {
    const { instance, hosts } = manager({ limits: { sessionBytes: 8 } });
    await instance.create({});
    hosts[0]!.emit("123456789");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const session = instance.list()[0]!;
    expect(session.status).toBe("limit");
    expect(session.limitReason).toMatch(/MiB|stopped/);
    expect(hosts[0]?.terminated).toBe(true);
  });

  it("enforces the session cap instead of opening a fourth shell", async () => {
    const { instance } = manager({ limits: { maxSessions: 2 } });
    await instance.create({});
    await instance.create({});
    await expect(instance.create({})).rejects.toThrow(/at most 2/);
  });

  it("evicts an ended session rather than stranding a full cap", async () => {
    const { instance, hosts } = manager({ limits: { maxSessions: 2 } });
    const first = await instance.create({});
    hosts[0]!.finish({ code: 0, signal: null });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    await instance.create({});
    const third = await instance.create({});
    expect(third.replacedSessionId).toBe(first.sessionId);
    expect(instance.list().map((session) => session.id)).not.toContain(first.sessionId);
    expect(instance.list()).toHaveLength(2);
    expect(instance.capacity()).toEqual({ live: 2, total: 2, canCreate: false });
  });

  it("searches the session buffer and reports truncation", async () => {
    const { instance, hosts } = manager();
    const created = await instance.create({});
    hosts[0]!.emit("alpha\nbeta\ngamma\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    const result = instance.search(created.sessionId, "a");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.scannedBytes).toBeGreaterThan(0);
  });

  it("closes a session through the helper and drops it from the active slot", async () => {
    const { instance, hosts } = manager();
    const created = await instance.create({});
    const closing = instance.close(created.sessionId);
    hosts[0]!.finish({ code: 0, signal: null });
    const view = await closing;
    expect(view.status).toBe("exited");
    expect(hosts[0]?.terminated).toBe(true);
    expect(instance.snapshot().activeSessionId).toBeNull();
  });

  it("redacts the home directory from the recorded cwd", async () => {
    const { instance } = manager();
    const created = await instance.create({ projectId: "p_000000000000000000000000" as ProjectId });
    expect(created.snapshot.sessions[0]?.cwd).toBe("/tmp/mona-workspace");
    // A session with no project starts in the home directory and shows it as `~`.
    const home = await instance.create({});
    expect(home.snapshot.sessions[1]?.cwd).toBe("~");
  });

  it("reports an unavailable log rather than an empty one", async () => {
    const { instance } = manager();
    const log = await instance.log({ projectId: "p_000000000000000000000000" as ProjectId });
    expect(log.available).toBe(false);
    expect(log.reason).toBeTruthy();
    expect(log.text).toBe("");
  });
});

describe("controlled shell environment", () => {
  it("withholds every secret-shaped variable and passes only the allowlist", () => {
    const environment = buildShellEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/someone",
      DEEPSEEK_API_KEY: "sk-test-value",
      CODEWHALE_RUNTIME_TOKEN: "token-value",
      SOMETHING_SECRET: "value",
      LANG: "en_US.UTF-8",
    });
    const entries = environment.entries.join("\n");
    expect(entries).not.toContain("sk-test-value");
    expect(entries).not.toContain("token-value");
    expect(environment.variables).not.toContain("DEEPSEEK_API_KEY");
    expect(environment.variables).not.toContain("CODEWHALE_RUNTIME_TOKEN");
    expect(environment.withheld).toEqual(
      expect.arrayContaining(["DEEPSEEK_API_KEY", "CODEWHALE_RUNTIME_TOKEN", "SOMETHING_SECRET"]),
    );
    expect(environment.variables).toEqual(expect.arrayContaining(["PATH", "HOME", "TERM", "LANG"]));
  });

  it("falls back to a safe locale instead of passing a malformed one", () => {
    const environment = buildShellEnvironment({ LANG: "not a locale; rm -rf /" });
    expect(environment.entries).toContain("LANG=en_US.UTF-8");
  });
});

const PTY_BINARY = resolve(__dirname, "..", "native/macos-pty/build/mona-pty");
const PS = "/bin/ps";
const hasPty = existsSync(PTY_BINARY);

describe.skipIf(!hasPty)("native pty helper", () => {
  it("runs a real shell, honors resize, and reports the exit code", async () => {
    const binary = resolvePtyBinary(PTY_BINARY);
    const host = await spawnPty({
      binary,
      cwd: "/tmp",
      cols: 100,
      rows: 30,
      environment: buildShellEnvironment({ PATH: "/usr/bin:/bin" }),
    });
    const chunks: Buffer[] = [];
    host.onOutput((bytes) => chunks.push(Buffer.from(bytes)));
    host.resize(120, 40);
    // The control channel and stdin are separate descriptors: give the helper a
    // moment to apply the window size before the shell asks for it.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    host.write(Buffer.from("printf 'pty-ok\\n'; stty size; exit 7\n"));
    const receipt = await Promise.race([
      host.exit,
      new Promise<PtyExit>((resolvePromise) =>
        setTimeout(() => resolvePromise({ code: null, signal: "TIMEOUT" }), 8_000),
      ),
    ]);
    const output = Buffer.concat(chunks).toString("utf8");
    expect(output).toContain("pty-ok");
    expect(output).toMatch(/40 120/);
    expect(receipt).toEqual({ code: 7, signal: null });
  }, 15_000);

  it("ends the shell when its owner closes the control channel", async () => {
    const binary = resolvePtyBinary(PTY_BINARY);
    const host = await spawnPty({
      binary,
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      environment: buildShellEnvironment({ PATH: "/usr/bin:/bin" }),
    });
    const shellPid = host.shellPid();
    expect(shellPid).toBeGreaterThan(0);
    // This is what a crash of the desktop process looks like to the helper: the
    // owner channel goes away. The helper must not leave an orphan shell.
    host.close();
    const receipt = await Promise.race([
      host.exit,
      new Promise<PtyExit>((resolvePromise) =>
        setTimeout(() => resolvePromise({ code: null, signal: "TIMEOUT" }), 8_000),
      ),
    ]);
    expect(receipt.signal).not.toBe("TIMEOUT");
    const alive = spawnSync(PS, ["-p", String(shellPid)], { encoding: "utf8" }).status === 0;
    expect(alive).toBe(false);
  }, 15_000);
});
