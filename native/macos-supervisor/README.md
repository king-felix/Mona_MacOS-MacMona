# native/macos-supervisor

Process ownership and stopping for owned Codewhale runtimes. Implemented at
P04; P02 reserves the location.

Measured P01 facts that constrain the supervisor:

- `/opt/homebrew/bin/codewhale` is a Node wrapper; the native binary it spawns
  owns the TCP listener. The listener is a **grandchild**, not the PID returned
  by `spawn`.
- Verify ownership by walking `ps` ppid edges and matching the listening PID
  (`lsof -nP -iTCP:<port> -sTCP:LISTEN`), not by accepting an HTTP 200.
- Signal the owned process group, never processes by name. No permanent daemon
  or login item.
- A second `app-server --http` attaches to the first Runtime owner on the same
  user store; independent parallel ownership is unsupported.
