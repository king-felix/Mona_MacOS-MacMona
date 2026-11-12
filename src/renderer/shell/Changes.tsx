import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ProjectDetail } from "../../shared/contracts/project-bridge";
import type {
  ArtifactWindowView,
  ChangeAttribution,
  ChangeFileView,
  ChangesSnapshot,
  ChangeSetView,
  FileWindowMode,
  FileWindowView,
  GitEntryView,
  RestorePreviewView,
  RestoreResultView,
} from "../../shared/contracts/changes";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  ScreenHeader,
  Tabs,
  TabPanel,
  TextField,
  type Tone,
} from "../design/primitives";
import { BranchIcon, ChangesIcon, FolderIcon, RefreshIcon } from "../design/icons";
import { relativeTime } from "./visual";

const TABS = [
  { id: "receipts", label: "Receipts" },
  { id: "workspace", label: "Workspace & Git" },
];

const CHANGE_TONE: Record<string, Tone> = {
  created: "success",
  updated: "primary",
  deleted: "danger",
  renamed: "attention",
  unknown: "neutral",
};

const STATE_TONE: Record<string, Tone> = {
  settled: "success",
  pending: "attention",
  unavailable: "neutral",
};

const STATE_LABEL: Record<string, string> = {
  settled: "Settled delta",
  pending: "Delta pending",
  unavailable: "No delta",
};

function errorText(error: { message: string; code?: string; details?: unknown }): string {
  return error.code ? `${error.message} (${error.code})` : error.message;
}

function short(value: string | null | undefined, length = 8): string {
  if (!value) return "—";
  return value.length > length ? value.slice(0, length) : value;
}

function bytes(value: number | null): string {
  if (value === null) return "unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function attributionLabel(
  attribution: ChangeAttribution,
  file: Pick<ChangeFileView, "toolName">,
): { label: string; tone: Tone } {
  if (attribution === "tool")
    return { label: `Tool${file.toolName ? `: ${file.toolName}` : " write"}`, tone: "primary" };
  if (attribution === "workspace_delta") return { label: "Workspace delta", tone: "attention" };
  if (attribution === "artifact") return { label: "Tool artifact", tone: "neutral" };
  return { label: "No Mona receipt", tone: "neutral" };
}

function sourceLabel(source: string): string {
  switch (source) {
    case "tool_mutation":
      return "recorded by a tool call";
    case "workspace_changed_during_turn":
      return "changed during the turn, not attributed to a tool";
    case "tool_output_spill":
      return "spilled tool output";
    case "tool_media":
      return "tool media";
    default:
      return "source not recorded";
  }
}

function gitStatusLabel(entry: GitEntryView): string {
  if (entry.conflicted) return "conflict";
  if (entry.untracked) return "untracked";
  if (entry.staged && entry.unstaged) return "staged + edited";
  if (entry.staged) return "staged";
  return "modified";
}

function gitTone(entry: GitEntryView): Tone {
  if (entry.conflicted) return "danger";
  if (entry.untracked) return "attention";
  if (entry.staged && !entry.unstaged) return "success";
  return "primary";
}

/**
 * A virtualized, monospace text/diff window. Only the visible lines are in the
 * DOM, so a 10,000-line diff does not create 10,000 nodes. Line numbers are
 * absolute and never re-number a window.
 */
function CodeView({ text, label }: { text: string; label: string }): JSX.Element {
  const LINE_HEIGHT = 18;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(420);
  const ref = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => text.split("\n"), [text]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setViewport(node.clientHeight || 420);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const visibleCount = Math.ceil(viewport / LINE_HEIGHT) + 8;
  const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - 4);
  const end = Math.min(lines.length, start + visibleCount);
  return (
    <div
      ref={ref}
      className="code-view"
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="code-view__spacer" style={{ height: lines.length * LINE_HEIGHT }}>
        {lines.slice(start, end).map((line, index) => {
          const lineNumber = start + index;
          const kind = line.startsWith("+")
            ? "code-line--add"
            : line.startsWith("-")
              ? "code-line--del"
              : line.startsWith("@@")
                ? "code-line--hunk"
                : "";
          return (
            <div
              key={lineNumber}
              className={`code-line ${kind}`}
              style={{ top: lineNumber * LINE_HEIGHT, height: LINE_HEIGHT }}
            >
              <span className="code-line__no" aria-hidden="true">
                {lineNumber + 1}
              </span>
              <span className="code-line__text">{line.length > 0 ? line : " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileWindowPanel({
  file,
  window,
  busy,
  editor,
  conflict,
  onMode,
  onLoadMore,
  onEdit,
  onEditor,
  onSave,
  onCancel,
  onReload,
  onReveal,
  onArtifact,
}: {
  file: { setId: string; path: string; mode: FileWindowMode };
  window: FileWindowView | null;
  busy: boolean;
  editor: string | null;
  conflict: string | null;
  onMode: (mode: FileWindowMode) => void;
  onLoadMore: () => void;
  onEdit: () => void;
  onEditor: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onReload: () => void;
  onReveal: () => void;
  onArtifact: () => void;
}): JSX.Element {
  const text = file.mode === "diff" ? (window?.diff ?? "") : (window?.content ?? "");
  const canVirtualize = window?.availability === "available" && text.length > 0;
  return (
    <Card
      eyebrow="Review"
      title={file.path}
      className="changes-review"
      actions={
        <div className="changes-review__actions">
          <Button
            size="sm"
            variant={file.mode === "text" ? "secondary" : "ghost"}
            onClick={() => onMode("text")}
          >
            Text
          </Button>
          <Button
            size="sm"
            variant={file.mode === "diff" ? "secondary" : "ghost"}
            onClick={() => onMode("diff")}
          >
            Diff
          </Button>
          <Button size="sm" variant="ghost" onClick={onReveal}>
            Reveal
          </Button>
          {window?.source === "artifact" ? (
            <Button size="sm" variant="ghost" onClick={onArtifact}>
              Output
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="changes-review__meta">
        <Badge tone={file.mode === "diff" ? "accent" : "neutral"}>{file.mode}</Badge>
        {window?.source ? <Badge tone="neutral">source: {window.source}</Badge> : null}
        {window?.revision ? (
          <span className="mono muted">revision {short(window.revision, 10)}</span>
        ) : null}
        {window?.totalBytes !== null && window?.totalBytes !== undefined ? (
          <span className="muted">{bytes(window.totalBytes)}</span>
        ) : null}
        {window?.truncated ? <Badge tone="attention">window capped</Badge> : null}
      </div>
      {busy ? <p className="muted">Reading from the recorded revision…</p> : null}
      {!busy && window === null ? (
        <p className="muted">Choose Text or Diff to read this file.</p>
      ) : null}
      {!busy && window && window.availability !== "available" ? (
        <Callout
          tone={window.availability === "error" ? "danger" : "attention"}
          title={
            window.availability === "binary"
              ? "Binary content"
              : window.availability === "missing"
                ? "Content is not available"
                : window.availability === "oversized"
                  ? "File is too large to preview"
                  : "No preview"
          }
        >
          {window.note ??
            (window.availability === "binary"
              ? "The engine served this window as binary bytes. Mona does not render it."
              : "No content was returned.")}
        </Callout>
      ) : null}
      {window?.note && window.availability === "available" ? (
        <p className="muted">{window.note}</p>
      ) : null}
      {conflict ? (
        <Callout
          tone="danger"
          title="The file changed since you opened it"
          action={
            <Button size="sm" variant="secondary" onClick={onReload}>
              Reload
            </Button>
          }
        >
          {conflict}
        </Callout>
      ) : null}
      {editor !== null ? (
        <div className="changes-editor">
          <p className="muted">
            Editing the whole file. Saving uses the revision you opened; if it changed, Mona refuses
            the write instead of overwriting.
          </p>
          <textarea
            className="changes-editor__area"
            aria-label={`Edit ${file.path}`}
            value={editor}
            spellCheck={false}
            onChange={(event) => onEditor(event.target.value)}
          />
          <div className="changes-editor__actions">
            <Button size="sm" variant="primary" onClick={onSave}>
              Save with revision check
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel edit
            </Button>
          </div>
        </div>
      ) : canVirtualize ? (
        <>
          <CodeView
            text={text}
            label={`${file.mode === "diff" ? "Diff" : "Contents"} of ${file.path}`}
          />
          <div className="changes-review__footer">
            {window?.truncated ? (
              <Button size="sm" variant="secondary" onClick={onLoadMore}>
                Load more from offset {window.nextOffset}
              </Button>
            ) : (
              <span className="muted">Whole window loaded.</span>
            )}
            {window?.canEdit && file.mode === "text" && !window.truncated && window.revision ? (
              <Button size="sm" variant="ghost" onClick={onEdit}>
                Edit this file
              </Button>
            ) : window?.canEdit && window.truncated ? (
              <span className="muted">Load the whole file before editing.</span>
            ) : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function ChangeSetCard({
  set,
  snapshot,
  selected,
  onToggle,
  onSelectAll,
  onOpen,
  onRestore,
  onArtifact,
  onReveal,
}: {
  set: ChangeSetView;
  snapshot: ChangesSnapshot;
  selected: string[];
  onToggle: (path: string) => void;
  onSelectAll: () => void;
  onOpen: (path: string, mode: FileWindowMode) => void;
  onRestore: () => void;
  onArtifact: (artifactId: string) => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  const restorable = set.files.filter((file) => file.kind === "file" && file.restoreSnapshotId);
  const committedPathCount = snapshot.lastCommit
    ? set.files.filter((file) => snapshot.lastCommit?.paths.includes(file.path)).length
    : 0;
  const commitEvidence = committedPathCount > 0 ? snapshot.lastCommit : null;
  return (
    <Card
      className="change-set"
      eyebrow={`Turn ${short(set.turnId, 12)} · ${relativeTime(set.capturedAt)}`}
      title={STATE_LABEL[set.state] ?? set.state}
      actions={
        <div className="change-set__actions">
          <Badge tone={STATE_TONE[set.state] ?? "neutral"}>{set.state}</Badge>
          {set.truncated ? (
            <Badge tone="attention">capped{set.omitted ? ` · ${set.omitted} omitted` : ""}</Badge>
          ) : null}
          {restorable.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={onSelectAll}>
              Select all restorable
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={selected.length === 0 || !snapshot.restore.available}
            onClick={onRestore}
            title={snapshot.restore.available ? undefined : (snapshot.restore.reason ?? undefined)}
          >
            Restore selected ({selected.length})
          </Button>
        </div>
      }
    >
      {set.note ? (
        <Callout
          tone={set.state === "unavailable" ? "attention" : "neutral"}
          title={set.state === "unavailable" ? "No workspace delta" : "Engine note"}
        >
          {set.note}
        </Callout>
      ) : null}
      <div className="change-set__facts">
        <span className="muted">
          {set.files.length} file{set.files.length === 1 ? "" : "s"} · {set.tools.length} tool
          receipt
          {set.tools.length === 1 ? "" : "s"}
        </span>
        {set.preSnapshotId ? (
          <span className="mono muted">pre-turn {short(set.preSnapshotId, 10)}</span>
        ) : null}
        {set.postSnapshotId ? (
          <span className="mono muted">post-turn {short(set.postSnapshotId, 10)}</span>
        ) : null}
        {commitEvidence ? (
          <span className="mono">
            commit {commitEvidence.shortHash} · {commitEvidence.subject} · {committedPathCount}/
            {set.files.length} paths
          </span>
        ) : null}
      </div>
      {set.files.length === 0 ? (
        <p className="muted">
          {set.state === "settled"
            ? "The engine settled this turn with no changed files."
            : "No file references were recorded. This is not an empty diff; the engine reported no delta."}
        </p>
      ) : (
        <ul className="change-files" aria-label={`Files changed in turn ${set.turnId}`}>
          {set.files.map((file) => {
            const attribution = attributionLabel(file.attribution, file);
            const isSelected = selected.includes(file.path);
            return (
              <li className="change-file" key={`${set.id}:${file.path}:${file.kind}`}>
                <input
                  type="checkbox"
                  aria-label={`Select ${file.path} for restore`}
                  checked={isSelected}
                  disabled={file.kind !== "file" || !file.restoreSnapshotId}
                  onChange={() => onToggle(file.path)}
                  title={
                    file.restoreSnapshotId
                      ? "This path has an engine restore point"
                      : "No restore point was recorded for this path"
                  }
                />
                <div className="change-file__main">
                  <button
                    type="button"
                    className="change-file__path mono"
                    onClick={() => onOpen(file.path, "text")}
                  >
                    {file.path}
                  </button>
                  <p className="change-file__meta muted">
                    {sourceLabel(file.source)}
                    {file.previousPath ? ` · from ${file.previousPath}` : ""}
                  </p>
                </div>
                <div className="change-file__badges">
                  <Badge tone={CHANGE_TONE[file.change] ?? "neutral"}>{file.change}</Badge>
                  <Badge tone={attribution.tone}>{attribution.label}</Badge>
                  <Badge tone="neutral">{bytes(file.sizeBytes)}</Badge>
                  {file.binaryHint ? <Badge tone="neutral">likely binary</Badge> : null}
                  {file.oversized ? <Badge tone="attention">over 16 MiB</Badge> : null}
                  {file.restoreSnapshotId ? (
                    <Badge tone="success">restore point</Badge>
                  ) : (
                    <Badge tone="neutral">no restore point</Badge>
                  )}
                </div>
                <div className="change-file__actions">
                  <Button size="sm" variant="ghost" onClick={() => onOpen(file.path, "diff")}>
                    Diff
                  </Button>
                  {file.kind === "file" ? (
                    <Button size="sm" variant="ghost" onClick={() => onReveal(file.path)}>
                      Reveal
                    </Button>
                  ) : null}
                  {file.artifactId ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onArtifact(file.artifactId as string)}
                    >
                      Output
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {set.tools.length > 0 ? (
        <details className="change-tools">
          <summary>Tool and test receipts ({set.tools.length})</summary>
          <ul>
            {set.tools.map((tool) => (
              <li key={`${tool.itemId ?? tool.toolCallId ?? tool.summary}`}>
                <div>
                  <span className="mono">{tool.toolName ?? "tool call"}</span>
                  <Badge tone={tool.status === "completed" ? "success" : "danger"}>
                    {tool.status}
                  </Badge>
                  {tool.summary ? <span className="muted"> {tool.summary}</span> : null}
                </div>
                {tool.artifacts.length > 0 ? (
                  <div className="change-tools__artifacts">
                    {tool.artifacts.map((artifact) => (
                      <Button
                        key={artifact.id}
                        size="sm"
                        variant="ghost"
                        onClick={() => onArtifact(artifact.id)}
                      >
                        {artifact.kind}{" "}
                        {artifact.sizeBytes === null ? "" : bytes(artifact.sizeBytes)}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {commitEvidence ? (
            <p className="mono">
              Commit evidence: {commitEvidence.shortHash} · {commitEvidence.subject} ·{" "}
              {committedPathCount} of {set.files.length} paths
            </p>
          ) : (
            <p className="muted">
              No commit from this surface names these paths yet; the commands and results above
              remain the recorded receipts.
            </p>
          )}
          <p className="muted">
            These are the engine's own command and result receipts. Mona did not re-run them.
          </p>
        </details>
      ) : null}
    </Card>
  );
}

export function ChangesScreen({
  detail,
  onOpenFolder,
}: {
  detail: ProjectDetail | null;
  onOpenFolder: () => void;
}): JSX.Element {
  const projectId = detail?.project.id ?? null;
  const [snapshot, setSnapshot] = useState<ChangesSnapshot | null>(null);
  const [tab, setTab] = useState("receipts");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedBySet, setSelectedBySet] = useState<Record<string, string[]>>({});
  const [selectedGit, setSelectedGit] = useState<string[]>([]);
  const [file, setFile] = useState<{ setId: string; path: string; mode: FileWindowMode } | null>(
    null,
  );
  const [fileWindow, setFileWindow] = useState<FileWindowView | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactWindowView | null>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [restore, setRestore] = useState<{
    preview: RestorePreviewView | null;
    acknowledge: string[];
    busy: boolean;
    error: string | null;
    result: RestoreResultView | null;
  } | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [includeUnstaged, setIncludeUnstaged] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitRefusal, setGitRefusal] = useState<{ message: string; paths: string[] } | null>(null);

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      if (!projectId) return;
      setBusy(true);
      setActionError(null);
      const result = refresh
        ? await window.mona.refreshChanges(projectId)
        : await window.mona.changesSnapshot(projectId);
      if (!result.ok) {
        setActionError(errorText(result.error));
      } else {
        setSnapshot(result.value);
      }
      setBusy(false);
    },
    [projectId],
  );

  useEffect(() => {
    setSnapshot(null);
    setFile(null);
    setFileWindow(null);
    setArtifact(null);
    setSelectedBySet({});
    setSelectedGit([]);
    setRestore(null);
    setNotice(null);
    if (projectId) void load(false);
  }, [projectId, load]);

  // A finished turn changes the receipts; refresh when the screen is visible.
  useEffect(() => {
    if (!projectId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, 15_000);
    return () => clearInterval(timer);
  }, [projectId, load]);

  const openFile = useCallback(
    async (setId: string, path: string, mode: FileWindowMode, offset = 0): Promise<void> => {
      if (!projectId) return;
      setFile({ setId, path, mode });
      setArtifact(null);
      setConflict(null);
      setEditor(null);
      setEditorRevision(null);
      setFileBusy(true);
      const result = await window.mona.readChangeFile({
        projectId,
        changeSetId: setId,
        path,
        mode,
        offset,
        limit: 262_144,
      });
      if (result.ok) {
        setFileWindow(result.value);
      } else {
        setFileWindow(null);
        setActionError(errorText(result.error));
      }
      setFileBusy(false);
    },
    [projectId],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (!projectId || !file || !fileWindow) return;
    setFileBusy(true);
    const result = await window.mona.readChangeFile({
      projectId,
      changeSetId: file.setId,
      path: file.path,
      mode: file.mode,
      offset: fileWindow.nextOffset,
      limit: 262_144,
    });
    if (result.ok) {
      setFileWindow({
        ...result.value,
        content:
          file.mode === "diff"
            ? (fileWindow.diff ?? "") + (result.value.diff ?? "")
            : (fileWindow.content ?? "") + (result.value.content ?? ""),
        diff:
          file.mode === "diff"
            ? (fileWindow.diff ?? "") + (result.value.diff ?? "")
            : result.value.diff,
      });
    } else {
      setActionError(errorText(result.error));
    }
    setFileBusy(false);
  }, [projectId, file, fileWindow]);

  const openArtifact = useCallback(
    async (setId: string, artifactId: string): Promise<void> => {
      if (!projectId) return;
      setFile(null);
      setFileWindow(null);
      setEditor(null);
      const result = await window.mona.readChangeArtifact({
        projectId,
        changeSetId: setId,
        artifactId,
        limit: 262_144,
      });
      if (result.ok) setArtifact(result.value);
      else setActionError(errorText(result.error));
    },
    [projectId],
  );

  const reveal = useCallback(
    async (path: string): Promise<void> => {
      if (!projectId) return;
      const result = await window.mona.revealWorkspacePath(projectId, path);
      if (!result.ok) setActionError(errorText(result.error));
    },
    [projectId],
  );

  const toggle = useCallback((setId: string, path: string): void => {
    setSelectedBySet((current) => {
      const existing = current[setId] ?? [];
      const next = existing.includes(path)
        ? existing.filter((entry) => entry !== path)
        : [...existing, path];
      return { ...current, [setId]: next };
    });
  }, []);

  const selectAll = useCallback((set: ChangeSetView): void => {
    setSelectedBySet((current) => ({
      ...current,
      [set.id]: set.files
        .filter((entry) => entry.kind === "file" && entry.restoreSnapshotId)
        .map((entry) => entry.path),
    }));
  }, []);

  const startRestore = useCallback(
    async (setId: string): Promise<void> => {
      if (!projectId) return;
      const paths = selectedBySet[setId] ?? [];
      if (paths.length === 0) return;
      setRestore({ preview: null, acknowledge: [], busy: true, error: null, result: null });
      const result = await window.mona.previewRestore(projectId, setId, paths);
      if (!result.ok) {
        setRestore(null);
        setActionError(errorText(result.error));
        return;
      }
      setRestore({
        preview: result.value,
        acknowledge: [],
        busy: false,
        error: null,
        result: null,
      });
    },
    [projectId, selectedBySet],
  );

  const confirmRestore = useCallback(async (): Promise<void> => {
    if (!projectId || !restore?.preview) return;
    const preview = restore.preview;
    setRestore({ ...restore, busy: true, error: null });
    const result = await window.mona.restoreChanges({
      projectId,
      changeSetId: preview.changeSetId,
      paths: preview.scope.map((entry) => entry.path),
      expected: preview.scope.map((entry) => ({
        path: entry.path,
        expectedHash: entry.expectedHash,
      })),
      acknowledge: restore.acknowledge,
    });
    if (!result.ok) {
      const details = result.error.details as { preview?: RestorePreviewView } | undefined;
      if (details?.preview) {
        setRestore({
          preview: details.preview,
          acknowledge: restore.acknowledge,
          busy: false,
          error:
            result.error.code === "STALE_PREVIEW"
              ? "Files changed after the preview. Review the new scope, then confirm again."
              : result.error.message,
          result: null,
        });
      } else {
        setRestore({ ...restore, busy: false, error: errorText(result.error) });
      }
      return;
    }
    setRestore({
      preview,
      acknowledge: restore.acknowledge,
      busy: false,
      error: null,
      result: result.value,
    });
    setSnapshot(result.value.snapshot);
    setNotice(
      result.value.ok
        ? `Restored ${result.value.restored.length} file${result.value.restored.length === 1 ? "" : "s"} with the engine's revert route.`
        : "The restore stopped at a refused file; the files above were changed and the rest were not attempted.",
    );
  }, [projectId, restore]);

  const stage = useCallback(async (): Promise<void> => {
    if (!projectId || selectedGit.length === 0) return;
    setGitBusy(true);
    setGitRefusal(null);
    const result = await window.mona.stageGitPaths(projectId, selectedGit);
    if (result.ok) {
      setSnapshot((current) => (current ? { ...current, git: result.value.status } : current));
      setNotice(result.value.note);
    } else {
      setActionError(errorText(result.error));
    }
    setGitBusy(false);
  }, [projectId, selectedGit]);

  const commit = useCallback(async (): Promise<void> => {
    if (!projectId || !commitMessage.trim() || selectedGit.length === 0) return;
    setGitBusy(true);
    setGitRefusal(null);
    const result = await window.mona.commitGitPaths({
      projectId,
      message: commitMessage.trim(),
      paths: selectedGit,
      includeUnstaged,
    });
    if (result.ok) {
      setNotice(result.value.note);
      setCommitMessage("");
      setSelectedGit([]);
      setIncludeUnstaged(false);
      await load(false);
    } else if (result.error.code === "COMMIT_REFUSED") {
      const details = result.error.details as { paths?: string[] } | undefined;
      if (details?.paths && details.paths.length > 0 && !includeUnstaged) {
        setGitRefusal({ message: result.error.message, paths: details.paths });
      } else {
        setActionError(errorText(result.error));
      }
    } else {
      setActionError(errorText(result.error));
    }
    setGitBusy(false);
  }, [projectId, commitMessage, selectedGit, includeUnstaged, load]);

  const saveFile = useCallback(async (): Promise<void> => {
    if (!projectId || !file || !fileWindow || editor === null) return;
    if (!editorRevision) {
      setConflict(
        "This window has no recorded revision, so a checked write is impossible. Reload the file; if the engine still reports no revision, edit it in your own editor.",
      );
      return;
    }
    let result: Awaited<ReturnType<typeof window.mona.writeWorkspaceFile>>;
    try {
      result = await window.mona.writeWorkspaceFile({
        projectId,
        path: file.path,
        content: editor,
        expectedRevision: editorRevision,
      });
    } catch (error) {
      setConflict(`The write was rejected before it reached the engine: ${String(error)}`);
      return;
    }
    if (result.ok) {
      setEditor(null);
      setConflict(null);
      setNotice(result.value.note);
      setFileWindow({
        ...fileWindow,
        content: editor,
        revision: result.value.revision,
        totalBytes: result.value.sizeBytes,
      });
      await load(false);
    } else if (result.error.code === "WRITE_CONFLICT") {
      const details = result.error.details as { currentRevision?: string } | undefined;
      setConflict(
        `${result.error.message}${
          details?.currentRevision
            ? ` The current revision is ${short(details.currentRevision, 12)}.`
            : ""
        } Your draft is still here; reload and merge deliberately.`,
      );
    } else {
      setConflict(errorText(result.error));
    }
  }, [projectId, file, fileWindow, editor, editorRevision, load]);

  const beginEdit = useCallback((): void => {
    if (!fileWindow || fileWindow.content === null || fileWindow.truncated) return;
    if (!fileWindow.revision) {
      setConflict(
        "This window has no recorded revision, so Mona cannot check the write. Reload the file first.",
      );
      return;
    }
    setEditor(fileWindow.content);
    setEditorRevision(fileWindow.revision);
    setConflict(null);
  }, [fileWindow]);

  const sets = snapshot?.sets ?? [];
  const git = snapshot?.git ?? null;

  return (
    <section className="screen changes-screen" aria-labelledby="changes-title">
      <ScreenHeader
        eyebrow="Evidence"
        title="Changes"
        lede="What the engine recorded, what Git sees, and what can be reverted — without guessing who wrote what."
        actions={
          <div className="changes-screen__actions">
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshIcon size={14} />}
              disabled={busy || !projectId}
              onClick={() => void load(true)}
            >
              Refresh receipts
            </Button>
            {detail ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<FolderIcon size={14} />}
                onClick={onOpenFolder}
              >
                Open folder
              </Button>
            ) : null}
          </div>
        }
      />
      <span id="changes-title" hidden>
        Changes
      </span>

      {notice ? (
        <Callout tone="success" title="Done">
          {notice}
        </Callout>
      ) : null}
      {actionError ? (
        <Callout
          tone="danger"
          title="Action could not be completed"
          action={
            <Button size="sm" variant="ghost" onClick={() => setActionError(null)}>
              Dismiss
            </Button>
          }
        >
          {actionError}
        </Callout>
      ) : null}

      {!detail ? (
        <EmptyState
          icon={<ChangesIcon size={28} />}
          title="No project selected"
          description="Open a project folder to review its engine receipts, Git state, and restore points."
          action={
            <Button variant="primary" onClick={onOpenFolder}>
              Open a folder
            </Button>
          }
        />
      ) : (
        <>
          <div className="changes-summary">
            <div className="changes-summary__item">
              <span className="eyebrow">Engine receipts</span>
              <strong>{sets.length}</strong>
              <span className="muted">
                {sets.filter((set) => set.state === "settled").length} settled ·{" "}
                {sets.filter((set) => set.state === "unavailable").length} missing
              </span>
            </div>
            <div className="changes-summary__item">
              <span className="eyebrow">Working tree</span>
              <strong>
                {git?.available
                  ? `${git.counts.staged + git.counts.unstaged + git.counts.untracked}`
                  : "No Git"}
              </strong>
              <span className="muted">
                {git?.available
                  ? `${git.counts.staged} staged · ${git.counts.unstaged} unstaged · ${git.counts.untracked} untracked`
                  : (git?.reason ?? "Git is unavailable")}
              </span>
            </div>
            <div className="changes-summary__item">
              <span className="eyebrow">Restore</span>
              <strong>{snapshot?.restore.available ? "Engine route" : "Unavailable"}</strong>
              <span className="muted">
                {snapshot?.restore.available
                  ? "file-revert, one exact file at a time"
                  : (snapshot?.restore.reason ?? "Reading the engine's capability…")}
              </span>
            </div>
          </div>

          <Tabs label="Changes views" tabs={TABS} value={tab} onChange={setTab} />

          <TabPanel id="receipts" active={tab === "receipts"}>
            <div className="changes-layout">
              <div className="changes-list">
                {busy && !snapshot ? <p className="muted">Reading stored receipts…</p> : null}
                {!busy && sets.length === 0 ? (
                  <EmptyState
                    icon={<ChangesIcon size={28} />}
                    title="No change receipts yet"
                    description="The engine records a change set when a turn finishes. Start a turn in the studio, then return here."
                  />
                ) : null}
                {sets.map((set) => (
                  <ChangeSetCard
                    key={set.id}
                    set={set}
                    snapshot={snapshot as ChangesSnapshot}
                    selected={selectedBySet[set.id] ?? []}
                    onToggle={(path) => toggle(set.id, path)}
                    onSelectAll={() => selectAll(set)}
                    onOpen={(path, mode) => void openFile(set.id, path, mode)}
                    onRestore={() => void startRestore(set.id)}
                    onArtifact={(artifactId) => void openArtifact(set.id, artifactId)}
                    onReveal={(path) => void reveal(path)}
                  />
                ))}
                {snapshot?.notes.length ? (
                  <Card eyebrow="Honest boundaries" title="What this view cannot claim">
                    <ul className="changes-notes">
                      {snapshot.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
              </div>
              <div className="changes-inspector">
                {artifact ? (
                  <Card
                    eyebrow="Tool output"
                    title={artifact.artifactId}
                    actions={
                      <Button size="sm" variant="ghost" onClick={() => setArtifact(null)}>
                        Close
                      </Button>
                    }
                  >
                    <p className="muted">
                      {artifact.mediaType ?? "artifact"} · {bytes(artifact.sizeBytes)}
                    </p>
                    {artifact.note ? (
                      <Callout tone="attention" title="Artifact reader">
                        {artifact.note}
                      </Callout>
                    ) : null}
                    {artifact.content !== null ? (
                      <CodeView text={artifact.content} label="Tool output" />
                    ) : (
                      <p className="muted">No text content is available for this artifact.</p>
                    )}
                  </Card>
                ) : file ? (
                  <FileWindowPanel
                    file={file}
                    window={fileWindow}
                    busy={fileBusy}
                    editor={editor}
                    conflict={conflict}
                    onMode={(mode) => void openFile(file.setId, file.path, mode)}
                    onLoadMore={() => void loadMore()}
                    onEdit={beginEdit}
                    onEditor={setEditor}
                    onSave={() => void saveFile()}
                    onCancel={() => {
                      setEditor(null);
                      setConflict(null);
                    }}
                    onReload={() => void openFile(file.setId, file.path, file.mode)}
                    onReveal={() => void reveal(file.path)}
                    onArtifact={() => {
                      const set = sets.find((entry) => entry.id === file.setId);
                      const ref = set?.files.find((entry) => entry.path === file.path);
                      if (ref?.artifactId) void openArtifact(file.setId, ref.artifactId);
                    }}
                  />
                ) : (
                  <Card eyebrow="Review" title="Pick a file">
                    <p className="muted">
                      Text and diff views are read lazily from the recorded revision. A missing
                      snapshot is shown as missing, never as an empty diff.
                    </p>
                  </Card>
                )}
              </div>
            </div>
          </TabPanel>

          <TabPanel id="workspace" active={tab === "workspace"}>
            {!git?.available ? (
              <Card eyebrow="Git" title="This folder is not a Git worktree">
                <p className="muted">
                  {git?.reason ??
                    "Git is unavailable for this folder. Mona does not initialize a repository."}
                </p>
                <p className="muted">
                  Engine receipts above are still available. Staging, commits, and Git diffs need a
                  repository.
                </p>
              </Card>
            ) : (
              <>
                <Card
                  eyebrow="Git"
                  title={
                    git.detached
                      ? "Detached HEAD"
                      : `${git.branch ?? "unknown branch"}${git.worktree ? ` · worktree ${git.worktree}` : ""}`
                  }
                  actions={
                    <div className="changes-git__head">
                      {git.head ? (
                        <span className="mono" title={git.head.commit}>
                          {git.head.shortCommit} · {git.head.subject}
                        </span>
                      ) : (
                        <span className="muted">No commit yet</span>
                      )}
                    </div>
                  }
                >
                  <div className="changes-git__facts">
                    <Badge tone={git.detached ? "attention" : "primary"}>
                      <BranchIcon size={12} /> {git.branch ?? "detached"}
                    </Badge>
                    {git.worktree ? <Badge tone="accent">worktree {git.worktree}</Badge> : null}
                    {git.upstream ? (
                      <span className="muted">
                        upstream {git.upstream}
                        {git.ahead !== null || git.behind !== null
                          ? ` · ${git.ahead ?? 0} ahead, ${git.behind ?? 0} behind`
                          : ""}
                      </span>
                    ) : (
                      <span className="muted">No upstream branch configured.</span>
                    )}
                    {git.root ? <span className="mono muted">root {git.root}</span> : null}
                  </div>
                  {git.truncated ? (
                    <Callout tone="attention" title="Status listing was capped">
                      The working tree has more entries than Mona reads in one pass. The list and
                      counts below are partial; narrow the repository or refresh after reducing the
                      working tree.
                    </Callout>
                  ) : null}
                  {git.stagedBeforeReview > 0 ? (
                    <Callout tone="attention" title="Staged work is preserved">
                      {git.stagedBeforeReview} entr
                      {git.stagedBeforeReview === 1 ? "y is" : "ies are"} staged. Committing from
                      Mona names only the selected paths, so unrelated staged entries stay staged.
                      Mona never resets or cleans.
                    </Callout>
                  ) : null}
                  {git.entries.length === 0 ? (
                    <p className="muted">The working tree is clean.</p>
                  ) : (
                    <ul className="change-files" aria-label="Git working tree">
                      {git.entries.map((entry) => {
                        const selected = selectedGit.includes(entry.path);
                        const label = attributionLabel(entry.attribution, {
                          toolName: entry.receipt?.toolName ?? null,
                        });
                        return (
                          <li className="change-file" key={entry.path}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${entry.path}`}
                              checked={selected}
                              onChange={() =>
                                setSelectedGit((current) =>
                                  current.includes(entry.path)
                                    ? current.filter((path) => path !== entry.path)
                                    : [...current, entry.path],
                                )
                              }
                            />
                            <div className="change-file__main">
                              <button
                                type="button"
                                className="change-file__path mono"
                                onClick={() => {
                                  const set =
                                    entry.receipt &&
                                    sets.find(
                                      (candidate) => candidate.id === entry.receipt?.changeSetId,
                                    );
                                  if (set) void openFile(set.id, entry.path, "diff");
                                  else {
                                    const latest = sets.find((candidate) =>
                                      candidate.files.some((file) => file.path === entry.path),
                                    );
                                    if (latest) void openFile(latest.id, entry.path, "diff");
                                  }
                                }}
                              >
                                {entry.path}
                                {entry.originalPath ? (
                                  <span className="muted"> ← {entry.originalPath}</span>
                                ) : null}
                              </button>
                              <p className="change-file__meta muted">
                                {entry.receipt
                                  ? `turn ${short(entry.receipt.turnId, 10)}${entry.receipt.toolName ? ` · ${entry.receipt.toolName}` : ""}`
                                  : "No recorded turn names this path; it may be pre-existing, staged before review, or edited outside Mona."}
                              </p>
                            </div>
                            <div className="change-file__badges">
                              <Badge tone={gitTone(entry)}>{gitStatusLabel(entry)}</Badge>
                              <Badge tone={label.tone}>{label.label}</Badge>
                              {entry.indexStatus !== "." ? (
                                <span className="mono muted">index {entry.indexStatus}</span>
                              ) : null}
                              {entry.worktreeStatus !== "." && entry.worktreeStatus !== "?" ? (
                                <span className="mono muted">worktree {entry.worktreeStatus}</span>
                              ) : null}
                            </div>
                            <div className="change-file__actions">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void reveal(entry.path)}
                              >
                                Reveal
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="changes-git__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={gitBusy || selectedGit.length === 0}
                      onClick={() => void stage()}
                    >
                      Stage selected ({selectedGit.length})
                    </Button>
                    <div className="changes-git__commit">
                      <TextField
                        label="Commit message"
                        value={commitMessage}
                        maxLength={500}
                        onChange={(event) => setCommitMessage(event.target.value)}
                        placeholder="Describe the selected change"
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={
                          gitBusy || selectedGit.length === 0 || commitMessage.trim().length === 0
                        }
                        onClick={() => void commit()}
                      >
                        Commit selected
                      </Button>
                    </div>
                  </div>
                  {gitRefusal ? (
                    <Callout
                      tone="attention"
                      title="Those files have unstaged edits too"
                      action={
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!includeUnstaged}
                          onClick={() => void commit()}
                        >
                          Commit with unstaged edits
                        </Button>
                      }
                    >
                      <p>{gitRefusal.message}</p>
                      <p className="mono">{gitRefusal.paths.join(", ")}</p>
                      <label className="changes-git__ack">
                        <input
                          type="checkbox"
                          checked={includeUnstaged}
                          onChange={(event) => setIncludeUnstaged(event.target.checked)}
                        />
                        Include the unstaged edits in those files.
                      </label>
                    </Callout>
                  ) : null}
                  <p className="muted">
                    Only the named paths are staged and committed. Mona never runs reset, clean, or
                    a blanket checkout.
                  </p>
                </Card>
                {snapshot?.lastCommit ? (
                  <Card eyebrow="Commit evidence" title="Last commit from this surface">
                    <p className="mono">
                      {snapshot.lastCommit.shortHash} · {snapshot.lastCommit.subject}
                    </p>
                    <p className="muted">
                      Recorded {relativeTime(snapshot.lastCommit.createdAt)} ·{" "}
                      {snapshot.lastCommit.paths.length} selected path
                      {snapshot.lastCommit.paths.length === 1 ? "" : "s"}.
                    </p>
                  </Card>
                ) : null}
              </>
            )}
          </TabPanel>
        </>
      )}

      <Dialog
        open={restore !== null}
        title="Restore selected files"
        description="The engine reverts exactly these paths from the restore points it recorded. Nothing else is touched."
        onClose={() => setRestore(null)}
        footer={
          restore?.preview ? (
            <div className="changes-restore__footer">
              <Button variant="ghost" size="sm" onClick={() => setRestore(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={
                  restore.busy ||
                  restore.result !== null ||
                  !restore.preview.canRestore ||
                  restore.preview.scope.length === 0 ||
                  restore.preview.requiresAcknowledgement.some(
                    (path) => !restore.acknowledge.includes(path),
                  )
                }
                onClick={() => void confirmRestore()}
              >
                {restore.busy ? "Restoring…" : `Restore ${restore.preview.scope.length} file(s)`}
              </Button>
            </div>
          ) : null
        }
      >
        {!restore?.preview ? (
          <p className="muted">{restore?.busy ? "Reading the preview…" : "Preparing…"}</p>
        ) : (
          <div className="changes-restore">
            {restore.error ? (
              <Callout tone="danger" title="Restore did not run">
                {restore.error}
              </Callout>
            ) : null}
            {!restore.preview.engine.available ? (
              <Callout tone="attention" title="Restore is unavailable">
                {restore.preview.engine.reason ?? "The engine did not advertise file-revert."}
              </Callout>
            ) : null}
            {restore.result ? (
              <Card eyebrow="Result" title={restore.result.ok ? "Restored" : "Stopped"}>
                {restore.result.restored.length > 0 ? (
                  <ul>
                    {restore.result.restored.map((entry) => (
                      <li key={entry.path}>
                        <span className="mono">{entry.path}</span> · {entry.action} · snapshot{" "}
                        {short(entry.snapshotId, 12)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {restore.result.refused.length > 0 ? (
                  <Callout tone="danger" title="Refused">
                    {restore.result.refused.map((entry) => (
                      <p key={entry.path}>
                        <span className="mono">{entry.path}</span>: {entry.message} ({entry.code})
                      </p>
                    ))}
                  </Callout>
                ) : null}
                {restore.result.notAttempted.length > 0 ? (
                  <p className="muted">
                    Not attempted:{" "}
                    <span className="mono">{restore.result.notAttempted.join(", ")}</span>
                  </p>
                ) : null}
                <p className="muted">{restore.result.recovery.note}</p>
                <Button size="sm" variant="ghost" onClick={() => setRestore(null)}>
                  Close
                </Button>
              </Card>
            ) : (
              <>
                <p>{restore.preview.note}</p>
                <div className="changes-restore__grid">
                  <div>
                    <h3 className="changes-restore__heading">Exact scope</h3>
                    {restore.preview.scope.length === 0 ? (
                      <p className="muted">Nothing in this selection can be restored.</p>
                    ) : (
                      <ul className="changes-restore__list">
                        {restore.preview.scope.map((entry) => (
                          <li key={entry.path}>
                            <span className="mono">{entry.path}</span>
                            <Badge tone={entry.action === "removed" ? "attention" : "primary"}>
                              {entry.action}
                            </Badge>
                            <span className="muted">
                              now{" "}
                              {entry.currentRevision ? short(entry.currentRevision, 8) : "absent"}
                            </span>
                            {entry.note ? <span className="muted"> {entry.note}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h3 className="changes-restore__heading">Exclusions</h3>
                    {restore.preview.exclusions.length === 0 ? (
                      <p className="muted">No exclusions.</p>
                    ) : (
                      <ul className="changes-restore__list">
                        {restore.preview.exclusions.map((entry) => (
                          <li key={entry.path}>
                            <span className="mono">{entry.path}</span>
                            <Badge tone="neutral">{entry.reason}</Badge>
                            <span className="muted"> {entry.detail}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                <div>
                  <h3 className="changes-restore__heading">Conflicts</h3>
                  {restore.preview.conflicts.length === 0 ? (
                    <p className="muted">
                      No later edit or unattributed change was found for the selected paths.
                    </p>
                  ) : (
                    <ul className="changes-restore__list">
                      {restore.preview.conflicts.map((entry) => (
                        <li key={`${entry.path}:${entry.kind}`}>
                          <Badge tone="danger">{entry.kind}</Badge>
                          <span className="mono">{entry.path}</span>
                          <span className="muted"> {entry.detail}</span>
                          {restore.preview?.requiresAcknowledgement.includes(entry.path) ? (
                            <label className="changes-restore__ack">
                              <input
                                type="checkbox"
                                checked={restore.acknowledge.includes(entry.path)}
                                onChange={(event) =>
                                  setRestore({
                                    ...restore,
                                    acknowledge: event.target.checked
                                      ? [...restore.acknowledge, entry.path]
                                      : restore.acknowledge.filter((path) => path !== entry.path),
                                  })
                                }
                              />
                              Acknowledge that this file may hold later work.
                            </label>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <Callout tone="attention" title="Recovery information">
                  <p>{restore.preview.recovery.note}</p>
                  {restore.preview.recovery.recent.length > 0 ? (
                    <ul className="changes-restore__list">
                      {restore.preview.recovery.recent.map((entry) => (
                        <li key={entry.id}>
                          <span className="mono">{short(entry.id, 14)}</span>{" "}
                          <span className="muted">{entry.label || "unlabeled restore point"}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">
                      The engine did not list recent restore points; the recovery snapshot is still
                      taken before every revert.
                    </p>
                  )}
                </Callout>
              </>
            )}
          </div>
        )}
      </Dialog>
    </section>
  );
}
