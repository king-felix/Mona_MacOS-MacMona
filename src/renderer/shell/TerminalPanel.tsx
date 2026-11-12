import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  TerminalLogView,
  TerminalSearchView,
  TerminalSessionView,
  TerminalSnapshot,
} from "../../shared/contracts/terminal";
import { TERMINAL_LIMITS } from "../../shared/contracts/terminal";
import { Badge, Button, Callout, SegmentedControl, TextField } from "../design/primitives";
import { Transcript, type TranscriptLine } from "./ansi";

function clampSize(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

/**
 * A rejected bridge call is a schema refusal, not a crash: show it as an error
 * instead of leaving the pane waiting on a promise that never resolves.
 */
function rejectionText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `The request was refused before it reached the terminal: ${message}`;
}

function statusTone(status: TerminalSessionView["status"]): "success" | "attention" | "neutral" {
  if (status === "running") return "success";
  if (status === "starting") return "attention";
  return "neutral";
}

async function copyText(text: string): Promise<"copied" | "manual"> {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(area);
      return copied ? "copied" : "manual";
    } catch {
      return "manual";
    }
  }
}

function lineText(line: TranscriptLine): string {
  return line.spans.map((span) => span.text).join("");
}

export function TerminalPanel({
  projectId,
  open,
  mode,
  prefill,
  onMode,
  onClose,
}: {
  projectId: ProjectId | null;
  open: boolean;
  mode: "shell" | "log";
  prefill: string | null;
  onMode: (mode: "shell" | "log") => void;
  onClose: () => void;
}): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ lines: TranscriptLine[]; dropped: number }>({
    lines: [],
    dropped: 0,
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchState, setSearchState] = useState<TerminalSearchView | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const [log, setLog] = useState<TerminalLogView | null>(null);
  const [tall, setTall] = useState(false);
  const [sizeDraft, setSizeDraft] = useState<{ cols: string; rows: string }>({
    cols: "100",
    rows: "30",
  });

  const transcript = useRef<Transcript>(new Transcript({ maxLines: 4_000 }));
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef(new Map<number, HTMLDivElement>());
  const stickToBottom = useRef(true);
  const sessionRef = useRef<string | null>(null);
  // While a session replay is in flight, live output events are held so the
  // reconnect can drop exactly the bytes the replay already contains.
  const replayRef = useRef<{ sessionId: string; readSeq: number } | null>(null);
  const pendingLive = useRef<Array<{ seq: number; data: string }>>([]);

  const active = useMemo(
    () => snapshot?.sessions.find((session) => session.id === activeId) ?? null,
    [snapshot, activeId],
  );

  const paint = useCallback(() => {
    const view = transcript.current.render();
    setRendered({ lines: view.lines, dropped: view.stats.droppedLines });
  }, []);

  const loadSession = useCallback(
    async (sessionId: string) => {
      sessionRef.current = sessionId;
      transcript.current.clear();
      setActiveId(sessionId);
      setSearchState(null);
      replayRef.current = { sessionId, readSeq: Number.MAX_SAFE_INTEGER };
      pendingLive.current = [];
      try {
        const output = await window.mona.terminalOutput({ sessionId, cursor: 0 });
        // The user may have switched tabs while this read was in flight: another
        // session's bytes must never land in the transcript now on screen.
        if (sessionRef.current !== sessionId) return;
        if (!output.ok) {
          setError(`${output.error.code}: ${output.error.message}`);
          return;
        }
        transcript.current.write(output.value.data);
        replayRef.current = { sessionId, readSeq: output.value.seq };
        // Anything the main process pushed while the read was in flight is now
        // either inside `data` or strictly newer; only the newer bytes are kept.
        const held = pendingLive.current;
        pendingLive.current = [];
        for (const event of held) {
          if (event.seq > output.value.seq) transcript.current.write(event.data);
        }
        if (output.value.dropped > 0) {
          setNotice(
            `The replay ring had already dropped ${output.value.dropped} older bytes; the transcript starts at the retained window.`,
          );
        }
      } catch (error) {
        if (sessionRef.current === sessionId) setError(rejectionText(error));
      } finally {
        if (sessionRef.current === sessionId) {
          replayRef.current = null;
          paint();
        }
      }
    },
    [paint],
  );

  // Load the snapshot whenever the panel opens, and reconnect to a session that
  // survived a renderer reload instead of starting a second shell.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.mona
      .terminalSnapshot()
      .then(async (result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(`${result.error.code}: ${result.error.message}`);
          return;
        }
        setSnapshot(result.value);
        const target = result.value.activeSessionId ?? result.value.sessions[0]?.id ?? null;
        if (target) {
          await loadSession(target);
        } else {
          setActiveId(null);
          transcript.current.clear();
          paint();
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(rejectionText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadSession, paint]);

  // Terminal pushes: bytes in, state out. Nothing here can call the bridge.
  useEffect(() => {
    if (!open) return;
    return window.mona.onTerminalEvent((event) => {
      // A session that is not on screen, or one that started/ended, changed what
      // the tab strip shows. Streamed output for the visible session does not,
      // so it is not worth a snapshot round-trip per 33 ms batch.
      const visible = event.sessionId === sessionRef.current;
      if (!visible || event.kind !== "output") {
        void window.mona
          .terminalSnapshot()
          .then((result) => {
            if (result.ok) setSnapshot(result.value);
          })
          .catch(() => undefined);
      }
      if (!visible) return;
      const replay = replayRef.current;
      if (event.kind === "output" && event.data) {
        if (replay && replay.sessionId === event.sessionId) {
          pendingLive.current.push({ seq: event.seq, data: event.data });
          return;
        }
        transcript.current.write(event.data);
        paint();
      }
      if (event.kind === "exit" && event.note) {
        setNotice(event.note);
      }
    });
  }, [open, paint]);

  // Keep the view pinned to the newest line unless the user scrolled away.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !stickToBottom.current) return;
    body.scrollTop = body.scrollHeight;
  }, [rendered]);

  useEffect(() => {
    if (prefill && open) setInput(prefill);
  }, [prefill, open]);

  useEffect(() => {
    if (active) {
      setSizeDraft({ cols: String(active.cols), rows: String(active.rows) });
    }
  }, [active?.cols, active?.rows, active?.id]);

  const refreshSnapshot = useCallback(async () => {
    const result = await window.mona.terminalSnapshot();
    if (result.ok) setSnapshot(result.value);
  }, []);

  const createSession = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.mona.terminalCreate({
        projectId: projectId ?? null,
        cols: clampSize(sizeDraft.cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols, 100),
        rows: clampSize(sizeDraft.rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows, 30),
      });
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      setSnapshot(result.value.snapshot);
      await loadSession(result.value.sessionId);
      setNotice(
        result.value.replacedSessionId
          ? `Shell started. The oldest finished session was replaced to stay within ${TERMINAL_LIMITS.maxSessions} sessions; its transcript is gone.`
          : "Shell started with an explicit environment; startup files were not sourced.",
      );
    } catch (error) {
      setError(rejectionText(error));
    } finally {
      setBusy(false);
    }
  }, [loadSession, projectId, sizeDraft.cols, sizeDraft.rows]);

  const send = useCallback(
    async (text: string) => {
      if (!activeId) return;
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > TERMINAL_LIMITS.inputBytes) {
        setError(
          `That input is ${bytes} bytes; one write allows ${TERMINAL_LIMITS.inputBytes}. Paste it in smaller pieces.`,
        );
        return;
      }
      try {
        const result = await window.mona.terminalWrite({ sessionId: activeId, data: text });
        if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
      } catch (error) {
        setError(rejectionText(error));
      }
      stickToBottom.current = true;
    },
    [activeId],
  );

  const submitLine = useCallback(async () => {
    if (!input.trim() && input.length === 0) return;
    await send(`${input}\n`);
    setInput("");
  }, [input, send]);

  const control = useCallback(
    async (char: string) => {
      await send(char);
      setNotice(`Sent ${char === "\u0003" ? "Ctrl-C" : "Ctrl-D"} to the shell.`);
    },
    [send],
  );

  const applySize = useCallback(async () => {
    if (!activeId) return;
    const cols = Math.max(
      TERMINAL_LIMITS.minCols,
      Math.min(TERMINAL_LIMITS.maxCols, Number(sizeDraft.cols) || 100),
    );
    const rows = Math.max(
      TERMINAL_LIMITS.minRows,
      Math.min(TERMINAL_LIMITS.maxRows, Number(sizeDraft.rows) || 30),
    );
    let result;
    try {
      result = await window.mona.terminalResize({ sessionId: activeId, cols, rows });
    } catch (error) {
      setError(rejectionText(error));
      return;
    }
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setSnapshot((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === result.value.id ? result.value : session,
            ),
          }
        : current,
    );
    setNotice(`Resized the pty to ${cols}×${rows}; the child sees the new window.`);
  }, [activeId, sizeDraft.cols, sizeDraft.rows]);

  const closeSession = useCallback(async () => {
    if (!activeId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.mona.terminalClose(activeId);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      sessionRef.current = null;
      setActiveId(null);
      transcript.current.clear();
      paint();
      await refreshSnapshot();
    } catch (error) {
      setError(rejectionText(error));
    } finally {
      setBusy(false);
    }
  }, [activeId, paint, refreshSnapshot]);

  const runSearch = useCallback(async () => {
    if (!activeId || search.trim().length === 0) {
      setSearchState(null);
      return;
    }
    try {
      const result = await window.mona.terminalSearch({ sessionId: activeId, query: search });
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      setSearchState(result.value);
      setMatchIndex(0);
    } catch (error) {
      setError(rejectionText(error));
    }
  }, [activeId, search]);

  const jumpToMatch = useCallback(
    (next: number) => {
      const matches = searchState?.matches ?? [];
      if (matches.length === 0) return;
      const index = (next + matches.length) % matches.length;
      setMatchIndex(index);
      const target = matches[index];
      if (!target) return;
      const node = lineRefs.current.get(target.line);
      if (node) {
        stickToBottom.current = false;
        node.scrollIntoView({ block: "center" });
      } else {
        setNotice(
          "That match is older than the lines this view kept; the count still comes from the full retained buffer.",
        );
      }
    },
    [searchState],
  );

  const loadLog = useCallback(async () => {
    if (!projectId) {
      setLog(null);
      return;
    }
    try {
      const result = await window.mona.terminalLog(projectId);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      setLog(result.value);
    } catch (error) {
      setError(rejectionText(error));
    }
  }, [projectId]);

  useEffect(() => {
    if (open && mode === "log") void loadLog();
  }, [open, mode, loadLog]);

  const copyTranscript = useCallback(async () => {
    const outcome = await copyText(transcript.current.text());
    setNotice(
      outcome === "copied"
        ? "Transcript copied."
        : "The clipboard was unavailable; select the text and press Command-C.",
    );
  }, []);

  if (!open) return null;

  const running = active?.status === "running";
  const highlight = search.trim().toLowerCase();

  return (
    <section className="terminal" data-testid="terminal-panel" aria-label="Terminal">
      <header className="terminal__bar">
        <div className="terminal__title">
          <span className="terminal__dot" aria-hidden="true" />
          <strong>Terminal</strong>
          <span className="terminal__meta">native arm64 pty · inert escape sequences</span>
        </div>
        <SegmentedControl
          label="Terminal mode"
          value={mode}
          options={[
            { value: "shell", label: "Shell" },
            { value: "log", label: "Engine log" },
          ]}
          onChange={(value) => onMode(value === "log" ? "log" : "shell")}
        />
        <div className="terminal__bar-actions">
          {mode === "shell" ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void createSession()}
                disabled={busy}
              >
                New shell
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void closeSession()}
                disabled={!activeId || busy}
              >
                Close session
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void loadLog()}>
              Refresh log
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setTall((value) => !value)}>
            {tall ? "Shorter" : "Taller"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Hide
          </Button>
        </div>
      </header>

      {error ? (
        <Callout
          tone="danger"
          title="Terminal error"
          action={
            <Button size="sm" variant="ghost" onClick={() => setError(null)}>
              Dismiss
            </Button>
          }
        >
          {error}
        </Callout>
      ) : null}
      {notice ? (
        <p className="terminal__notice" role="status">
          {notice}
        </p>
      ) : null}

      {mode === "log" ? (
        <div className="terminal__log" data-testid="terminal-log">
          {log === null ? (
            <p className="terminal__empty">Reading the owned runtime's log…</p>
          ) : log.available ? (
            <>
              <p className="terminal__meta">
                {log.path} · {log.bytes} bytes{log.truncated ? " · showing the newest part" : ""} ·
                read-only
              </p>
              <pre className="terminal__body" data-testid="terminal-log-text">
                {log.text.length > 0 ? log.text : "(the log is empty)"}
              </pre>
            </>
          ) : (
            <p className="terminal__empty">{log.reason}</p>
          )}
        </div>
      ) : (
        <>
          <div className="terminal__toolbar">
            <div className="terminal__sessions" role="tablist" aria-label="Terminal sessions">
              {(snapshot?.sessions ?? []).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  role="tab"
                  aria-selected={session.id === activeId}
                  className={`terminal__tab ${session.id === activeId ? "terminal__tab--active" : ""}`}
                  onClick={() => void loadSession(session.id)}
                >
                  {session.title}
                  <span className="terminal__tab-status">{session.status}</span>
                </button>
              ))}
              {(snapshot?.sessions.length ?? 0) === 0 ? (
                <span className="terminal__empty">
                  No shell yet. Mona starts one only when you ask.
                </span>
              ) : null}
            </div>
            {active ? (
              <div className="terminal__facts">
                <Badge tone={statusTone(active.status)}>{active.status}</Badge>
                <span>
                  {active.cols}×{active.rows}
                </span>
                <span title="Working directory">{active.cwd}</span>
                {active.exitCode !== null ? <span>exit {active.exitCode}</span> : null}
                {active.exitSignal ? <span>{active.exitSignal}</span> : null}
                <span>{Math.round(active.bytesOut / 1024)} KiB</span>
                {active.droppedBytes > 0 ? <span>{active.droppedBytes} bytes dropped</span> : null}
              </div>
            ) : null}
          </div>

          <div className="terminal__search">
            <label className="field__label" htmlFor="terminal-search">
              Search transcript
            </label>
            <input
              id="terminal-search"
              className="input input--mono"
              value={search}
              placeholder="Find in the retained buffer"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runSearch();
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void runSearch()}
              disabled={!activeId}
            >
              Find
            </Button>
            {searchState ? (
              <span className="terminal__meta" data-testid="terminal-search-count">
                {searchState.matches.length} match{searchState.matches.length === 1 ? "" : "es"}
                {searchState.truncated ? " (first 200)" : ""} · {matchIndex + 1}/
                {searchState.matches.length}
                <Button size="sm" variant="ghost" onClick={() => jumpToMatch(matchIndex - 1)}>
                  Prev
                </Button>
                <Button size="sm" variant="ghost" onClick={() => jumpToMatch(matchIndex + 1)}>
                  Next
                </Button>
              </span>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void copyTranscript()}>
              Copy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                transcript.current.clear();
                paint();
                setNotice("Cleared this view only; the shell and its buffer are untouched.");
              }}
            >
              Clear view
            </Button>
          </div>

          <div
            className={`terminal__body ${tall ? "terminal__body--tall" : ""}`}
            ref={bodyRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
            }}
            data-testid="terminal-transcript"
          >
            {rendered.lines.map((line, index) => {
              const text = lineText(line);
              const isMatch = highlight.length > 0 && text.toLowerCase().includes(highlight);
              return (
                <div
                  key={index}
                  ref={(node) => {
                    if (node) lineRefs.current.set(index, node);
                    else lineRefs.current.delete(index);
                  }}
                  className={`terminal__line ${isMatch ? "terminal__line--match" : ""}`}
                  data-line={index}
                >
                  {line.spans.length === 0
                    ? "\u00a0"
                    : line.spans.map((span, spanIndex) => (
                        <span
                          key={spanIndex}
                          className={`terminal__span terminal__span--${span.tone}`}
                        >
                          {span.text}
                        </span>
                      ))}
                </div>
              );
            })}
            {rendered.lines.length === 0 ? (
              <p className="terminal__empty">
                Output appears here. Nothing is executed until you press Return.
              </p>
            ) : null}
          </div>

          <div className="terminal__input-row">
            <input
              className="input input--mono terminal__input"
              aria-label="Command line"
              placeholder={running ? "Type a command and press Return" : "This session has ended"}
              value={input}
              disabled={!running}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitLine();
                }
              }}
              data-testid="terminal-input"
            />
            <Button
              size="sm"
              variant="primary"
              onClick={() => void submitLine()}
              disabled={!running}
            >
              Send
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void control("\u0003")}
              disabled={!running}
            >
              Ctrl-C
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void control("\u0004")}
              disabled={!running}
            >
              Ctrl-D
            </Button>
            <div className="terminal__size">
              <TextField
                label="Cols"
                className="input--tiny"
                value={sizeDraft.cols}
                onChange={(event) => setSizeDraft({ ...sizeDraft, cols: event.target.value })}
              />
              <TextField
                label="Rows"
                className="input--tiny"
                value={sizeDraft.rows}
                onChange={(event) => setSizeDraft({ ...sizeDraft, rows: event.target.value })}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void applySize()}
                disabled={!running}
              >
                Resize
              </Button>
            </div>
          </div>
          <p className="terminal__limits">
            {snapshot?.environment.shell ?? "/bin/zsh"}{" "}
            {(snapshot?.environment.arguments ?? ["-f"]).join(" ")} · startup files not sourced ·
            provider keys and the runtime token are never passed · at most{" "}
            {TERMINAL_LIMITS.maxSessions} sessions · replay{" "}
            {Math.round(TERMINAL_LIMITS.replayBytes / 1024)} KiB · full-screen programs are not
            emulated
          </p>
          {rendered.dropped > 0 ? (
            <p className="terminal__limits">
              {rendered.dropped} older lines left this view; the session buffer still holds them.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
