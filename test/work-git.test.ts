import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitError, GitService, buildGitEnvironment, validateGitPath } from "../src/main/work/git";
import { tempDir } from "./helpers/state";

function git(cwd: string, args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function repo(): string {
  const dir = tempDir("mona-git-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "mona@example.test"]);
  git(dir, ["config", "user.name", "Mona Test"]);
  writeFileSync(join(dir, "README.md"), "base\n", "utf8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

function write(cwd: string, path: string, content: string): void {
  writeFileSync(join(cwd, path), content, "utf8");
}

describe("GitService status", () => {
  it("reports a clean repository with a branch and HEAD", async () => {
    const cwd = repo();
    const service = new GitService();
    const report = await service.status(cwd);
    expect(report.available).toBe(true);
    expect(report.branch).toBe("main");
    expect(report.detached).toBe(false);
    expect(report.worktree).toBeNull();
    expect(report.entries).toEqual([]);
    expect(report.head?.subject).toBe("base");
  });

  it("separates staged, unstaged and untracked entries", async () => {
    const cwd = repo();
    const service = new GitService();
    write(cwd, "staged.txt", "staged\n");
    git(cwd, ["add", "staged.txt"]);
    write(cwd, "README.md", "changed\n");
    write(cwd, "new.txt", "new\n");
    const report = await service.status(cwd);
    const byPath = new Map(report.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("staged.txt")?.staged).toBe(true);
    expect(byPath.get("staged.txt")?.unstaged).toBe(false);
    expect(byPath.get("README.md")?.unstaged).toBe(true);
    expect(byPath.get("new.txt")?.untracked).toBe(true);
  });

  it("reports a merge conflict honestly", async () => {
    const cwd = repo();
    git(cwd, ["checkout", "-b", "left"]);
    write(cwd, "README.md", "left\n");
    git(cwd, ["commit", "-am", "left"]);
    git(cwd, ["checkout", "main"]);
    write(cwd, "README.md", "right\n");
    git(cwd, ["commit", "-am", "right"]);
    try {
      git(cwd, ["merge", "left"]);
    } catch {
      // The merge conflict is the fixture.
    }
    const report = await new GitService().status(cwd);
    const entry = report.entries.find((candidate) => candidate.path === "README.md");
    expect(entry?.conflicted).toBe(true);
  });

  it("refuses a folder that is not a worktree", async () => {
    const dir = tempDir("mona-nogit-");
    const report = await new GitService().status(dir);
    expect(report.available).toBe(false);
    expect(report.reason).toMatch(/not a git worktree|not a git repository/i);
  });

  it("shows project-relative paths when the project is a repository subfolder", async () => {
    const root = repo();
    const project = join(root, "packages", "app");
    mkdirSync(project, { recursive: true });
    write(root, "outside.txt", "outside\n");
    write(project, "inside.txt", "inside\n");
    const report = await new GitService().status(project);
    expect(report.entries.map((entry) => entry.path)).toEqual(["inside.txt"]);
    expect(report.entries.some((entry) => entry.path === "outside.txt")).toBe(false);
  });

  it("names a linked worktree without mistaking it for the main checkout", async () => {
    const root = repo();
    const worktree = join(tempDir("mona-wt-parent-"), "linked");
    git(root, ["worktree", "add", "-b", "linked-branch", worktree]);
    const report = await new GitService().status(worktree);
    expect(report.available).toBe(true);
    expect(report.branch).toBe("linked-branch");
    expect(report.worktree).toBe("linked");
  });
});

describe("GitService staging and selected commits", () => {
  it("stages and commits only the selected path, preserving unrelated staged work", async () => {
    const cwd = repo();
    const service = new GitService();
    write(cwd, "unrelated-staged.txt", "staged before review\n");
    git(cwd, ["add", "unrelated-staged.txt"]);
    write(cwd, "selected.txt", "selected content\n");
    write(cwd, "untracked.txt", "untracked\n");

    await service.stage(cwd, ["selected.txt"]);
    const result = await service.commit(cwd, "selected only", ["selected.txt"]);
    expect(result.commit?.subject).toBe("selected only");

    const committed = git(cwd, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
    expect(committed).toEqual(["selected.txt"]);
    expect(git(cwd, ["show", "HEAD:selected.txt"])).toBe("selected content\n");

    const after = await service.status(cwd);
    const byPath = new Map(after.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("unrelated-staged.txt")?.staged).toBe(true);
    expect(byPath.get("untracked.txt")?.untracked).toBe(true);
  });

  it("refuses an empty path list and unsafe paths", async () => {
    const cwd = repo();
    const service = new GitService();
    await expect(service.stage(cwd, [])).rejects.toBeInstanceOf(GitError);
    await expect(service.stage(cwd, ["../escape"])).rejects.toBeInstanceOf(GitError);
    await expect(service.commit(cwd, "bad", ["/etc/passwd"])).rejects.toBeInstanceOf(GitError);
    await expect(service.stage(cwd, [".git/config"])).rejects.toBeInstanceOf(GitError);
    expect(validateGitPath("src/app.ts")).toBe("src/app.ts");
    expect(validateGitPath("src/../app.ts")).toBeNull();
  });

  it("reports nothing to commit instead of making an empty commit", async () => {
    const cwd = repo();
    const service = new GitService();
    await expect(service.commit(cwd, "no changes", ["README.md"])).rejects.toMatchObject({
      code: "NOTHING_TO_COMMIT",
    });
  });

  it("never hands Mona's provider secrets to a repository hook", async () => {
    const cwd = repo();
    const service = new GitService();
    const seen = join(cwd, "hook-env.txt");
    const hook = join(cwd, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nenv > ${JSON.stringify(seen)}\n`, { mode: 0o755 });
    chmodSync(hook, 0o755);
    write(cwd, "hooked.txt", "hooked\n");

    const previous = {
      key: process.env.DEEPSEEK_API_KEY,
      token: process.env.CODEWHALE_RUNTIME_TOKEN,
      session: process.env.MONA_SESSION_SECRET,
    };
    process.env.DEEPSEEK_API_KEY = "sk-p20-fixture-value";
    process.env.CODEWHALE_RUNTIME_TOKEN = "p20-runtime-token-value";
    process.env.MONA_SESSION_SECRET = "p20-session-secret";
    try {
      await service.stage(cwd, ["hooked.txt"]);
      await service.commit(cwd, "with a hook", ["hooked.txt"]);
    } finally {
      for (const [name, value] of [
        ["DEEPSEEK_API_KEY", previous.key],
        ["CODEWHALE_RUNTIME_TOKEN", previous.token],
        ["MONA_SESSION_SECRET", previous.session],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    // The hook really ran, so this is not a vacuous pass.
    expect(existsSync(seen)).toBe(true);
    const environment = readFileSync(seen, "utf8");
    expect(environment).not.toContain("sk-p20-fixture-value");
    expect(environment).not.toContain("p20-runtime-token-value");
    expect(environment).not.toContain("p20-session-secret");
    expect(environment).toContain("GIT_TERMINAL_PROMPT=0");
    // Identity and locale still reach Git, so ordinary commits keep working.
    expect(environment).toMatch(/^HOME=/m);
    expect(environment).toMatch(/^PATH=/m);
  });

  it("builds a Git environment with an explicit allowlist", () => {
    const environment = buildGitEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/example",
      DEEPSEEK_API_KEY: "secret",
      CODEWHALE_RUNTIME_TOKEN: "secret",
      GIT_AUTHOR_NAME: "Example",
      UNRELATED: "dropped",
    });
    expect(environment.PATH).toBe("/usr/bin:/bin");
    expect(environment.HOME).toBe("/Users/example");
    expect(environment.GIT_AUTHOR_NAME).toBe("Example");
    expect(environment.DEEPSEEK_API_KEY).toBeUndefined();
    expect(environment.CODEWHALE_RUNTIME_TOKEN).toBeUndefined();
    expect(environment.UNRELATED).toBeUndefined();
    expect(environment.LC_ALL).toBe("C");
  });
});

describe("GitService diffs", () => {
  it("returns an unstaged diff for one literal path", async () => {
    const cwd = repo();
    write(cwd, "README.md", "changed line\n");
    const result = await new GitService().diff(cwd, "README.md", { staged: false });
    expect(result.diff).toContain("-base");
    expect(result.diff).toContain("+changed line");
    expect(result.truncated).toBe(false);
  });

  it("returns a staged diff only when asked for the index", async () => {
    const cwd = repo();
    write(cwd, "README.md", "indexed\n");
    git(cwd, ["add", "README.md"]);
    write(cwd, "README.md", "working\n");
    const service = new GitService();
    const staged = await service.diff(cwd, "README.md", { staged: true });
    expect(staged.diff).toContain("+indexed");
    const unstaged = await service.diff(cwd, "README.md", { staged: false });
    expect(unstaged.diff).toContain("+working");
  });
});
