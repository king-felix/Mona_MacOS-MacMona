# native/macos-pty

The PTY host behind Mona's integrated terminal (P18). Built by
`npm run build:pty` into `build/mona-pty` (arm64, macOS 14 deployment target,
ad-hoc signed; Developer ID signing is P22). The fork/exec shim in `spawn.c` is
compiled by the same script because Swift marks `fork()` unavailable.

## Why a helper process

Two facts decided the design:

- **The engine's terminal routes attach; they do not create.** On the pinned
  0.10.2 build, `GET /v1/terminal/{name}/output` and its `input`/`resize`/`kill`
  siblings address a shell the engine already owns. A name with no live session
  is `404`, and the documented behaviour is that an HTTP request never conjures
  a shell. A client therefore cannot open _its own_ terminal through them.
- **`/v1/threads/{id}/jobs` creates a PTY job but has no resize route.** The
  acceptance criterion is that resize works and the child observes it, so that
  route cannot be the pane.

A standalone Swift helper also avoids a Node native addon entirely: there is no
Electron ABI to match and nothing is compiled on a recipient Mac.

## Contract

```text
mona-pty --shell <path> [--arg <arg>...] --cwd <dir> --cols N --rows N
         [--env KEY=VALUE ...]
```

| fd  | direction     | meaning                                      |
| --- | ------------- | -------------------------------------------- |
| 0   | Mona → helper | raw bytes typed by the user → pty master     |
| 1   | helper → Mona | raw bytes produced by the shell ← pty master |
| 3   | Mona → helper | newline-delimited JSON control               |
| 4   | helper → Mona | newline-delimited JSON events                |

Control: `{"op":"resize","cols":120,"rows":40}`, `{"op":"kill","signal":"TERM"}`,
`{"op":"terminate"}` (TERM, 2 s, KILL). Events: `started`, `resized`, `exit`,
`error`.

- The child calls `setsid()`, opens the pty (no `O_NOCTTY`), sets `TIOCSCTTY`,
  and closes every inherited descriptor before `execve`. Its process group is
  its own, so `kill(-pid, …)` reaches the whole foreground tree.
- **Controlled environment.** The helper passes exactly the `--env` entries it
  is given. The TypeScript side builds them from an allowlist
  (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`, `LANG`,
  `TMPDIR`) and never passes the desktop process's environment through, so
  `DEEPSEEK_API_KEY` and `CODEWHALE_RUNTIME_TOKEN` cannot reach a shell.
- **No startup files.** The default invocation is `/bin/zsh -f`; `/etc/zshrc`
  and `~/.zshrc` are not sourced. Trade-off: personal aliases are not loaded.
  Tested by a throwaway `HOME` with a `.zshrc` that would leave a marker.
- **No orphan shell.** Closing fd 3 (the owner channel) is treated as an owner
  death: the helper terminates the group and exits. A desktop crash therefore
  cannot leave a shell behind.

## Verification

- `test/terminal-manager.test.ts` spawns the real binary: resize is observed by
  the child (`stty size`), the exit code is read from the receipt, and the shell
  is gone after the control channel closes.
- `scripts/terminal-smoke.mjs` runs the real manager against a real shell and
  records 28 checks in `docs/evidence/macos/artifacts/p18-terminal-smoke.json`.
