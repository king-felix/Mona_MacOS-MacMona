import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import type { ProjectId, TaskId } from "../../shared/contracts/ids";
import {
  CONTEXT_SLOTS,
  CONTEXT_SLOT_LABELS,
  MEMORY_SOURCES,
  MEMORY_SOURCE_LABELS,
  type ContextSelectionPreview,
  type ContextSlot,
  type ContextSlotView,
  type DiagnosticsPreview,
  type HandoffImportResult,
  type HandoffInspection,
  type HandoffPreview,
  type MemoryIndexStatus,
  type MemorySearchResult,
  type MemorySource,
  type PromptImportResult,
  type PromptRenderResult,
  type PromptShelfView,
  type ResumePacket,
  type SettingsBackupInspection,
  type SettingsBackupView,
  type SettingsRestoreResult,
  type WorkspaceSearchResult,
} from "../../shared/contracts/memory";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  ScreenHeader,
  SegmentedControl,
  SelectField,
  TabPanel,
  Tabs,
  TextArea,
  TextField,
  cx,
} from "../design/primitives";
import { CheckIcon, ShieldIcon } from "../design/icons";

/** The bridge always answers with an `IpcResult`; the screen reports both halves. */
function errorLine(error: { code: string; message: string }): string {
  return `${error.code}: ${error.message}`;
}

const NOTE_NO_MODEL = "No model call is made here, and nothing on this screen starts work.";

type BoardTask = { id: string; title: string; status: string };
type SearchMode = "records" | "workspace";

const TABS = [
  { id: "search", label: "Search" },
  { id: "shelf", label: "Prompt shelf" },
  { id: "resume", label: "Resume & context" },
  { id: "handoff", label: "Handoff & diagnostics" },
];

const SEARCH_MODE_LABEL: Record<SearchMode, string> = {
  records: "stored records",
  workspace: "workspace files (on demand)",
};

/* ------------------------------------------------------------------ screen */

export function MemoryScreen(props: {
  projectId: string | null;
  projectName: string | null;
  /** Provided by the shell so the screen can list tasks for context selection. */
  boardTasks: Array<{ id: string; title: string; status: string }>;
}): JSX.Element {
  const { projectId, projectName, boardTasks } = props;
  const [tab, setTab] = useState("search");

  return (
    <section className="screen screen--memory memory-screen" data-testid="memory-screen">
      <ScreenHeader
        eyebrow="Project memory"
        title="Project memory"
        lede="Local search, prompts, handoff, and diagnostics. No model call is made here, and nothing on this screen starts work."
      />

      {projectId === null ? (
        <>
          <EmptyState
            icon={<ShieldIcon size={22} />}
            title="Open a project to use project memory"
            description="Search, the prompt shelf, the resume packet, and handoff all read this project's local records."
          />
          <p className="muted">{NOTE_NO_MODEL}</p>
        </>
      ) : (
        <>
          <p className="muted">{`Project: ${projectName ?? projectId} · ${NOTE_NO_MODEL}`}</p>
          <Tabs label="Project memory sections" tabs={TABS} value={tab} onChange={setTab} />
          <TabPanel id="search" active={tab === "search"}>
            <SearchTab projectId={projectId} active={tab === "search"} />
          </TabPanel>
          <TabPanel id="shelf" active={tab === "shelf"}>
            <ShelfTab active={tab === "shelf"} />
          </TabPanel>
          <TabPanel id="resume" active={tab === "resume"}>
            <ResumeTab projectId={projectId} boardTasks={boardTasks} active={tab === "resume"} />
          </TabPanel>
          <TabPanel id="handoff" active={tab === "handoff"}>
            <HandoffTab projectId={projectId} active={tab === "handoff"} />
          </TabPanel>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- tab: search */

function SearchTab({ projectId, active }: { projectId: string; active: boolean }): JSX.Element {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("records");
  const [sources, setSources] = useState<MemorySource[]>([...MEMORY_SOURCES]);
  const [records, setRecords] = useState<MemorySearchResult | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState<MemoryIndexStatus | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const lastProject = useRef<string | null>(null);
  /** Ignores a late answer from a search the user already replaced. */
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!active) return;
    if (lastProject.current !== projectId) {
      lastProject.current = projectId;
      setRecords(null);
      setWorkspace(null);
      setSearchError(null);
      setLastQuery("");
      setIndex(null);
      setIndexError(null);
    }
    let cancelled = false;
    void window.mona
      .memoryIndex(projectId as ProjectId)
      .catch(() => ({ ok: false as const, error: { code: "IPC_FAILED", message: "memoryIndex" } }))
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setIndex(null);
          setIndexError(errorLine(result.error));
          return;
        }
        setIndexError(null);
        setIndex(result.value);
      });
    return () => {
      cancelled = true;
    };
  }, [active, projectId]);

  const runSearch = useCallback(
    async (raw: string, nextSources: MemorySource[], nextMode: SearchMode) => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        setSearchError(null);
        return;
      }
      const seq = searchSeq.current + 1;
      searchSeq.current = seq;
      const current = () => searchSeq.current === seq;
      setBusy(true);
      setSearchError(null);
      setLastQuery(trimmed);
      try {
        if (nextMode === "workspace") {
          const result = await window.mona.memoryWorkspaceSearch({
            projectId: projectId as ProjectId,
            query: trimmed,
            limit: 100,
          });
          if (!current()) return;
          if (!result.ok) {
            setSearchError(errorLine(result.error));
            setWorkspace(null);
            setRecords(null);
            return;
          }
          setWorkspace(result.value);
          setRecords(null);
          return;
        }
        const result = await window.mona.memorySearch({
          projectId: projectId as ProjectId,
          query: trimmed,
          sources: nextSources,
          limit: 50,
        });
        if (!current()) return;
        if (!result.ok) {
          setSearchError(errorLine(result.error));
          setRecords(null);
          setWorkspace(null);
          return;
        }
        setRecords(result.value);
        setWorkspace(null);
      } catch {
        if (!current()) return;
        setSearchError("IPC_FAILED: the memory search call did not answer.");
        setRecords(null);
        setWorkspace(null);
      } finally {
        if (current()) setBusy(false);
      }
    },
    [projectId],
  );

  const toggleSource = (source: MemorySource) => {
    const next = MEMORY_SOURCES.filter((entry) =>
      entry === source ? !sources.includes(source) : sources.includes(entry),
    );
    setSources(next);
    if (mode === "records" && lastQuery.length > 0) void runSearch(lastQuery, next, "records");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runSearch(query, sources, mode);
  };

  return (
    <>
      <form className="memory-toolbar" onSubmit={submit} aria-label="Search project memory">
        <TextField
          label="Search"
          data-testid="memory-search-input"
          hint="Text match over stored records. No embedding and no model call."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Terms to match"
          autoComplete="off"
        />
        <Button type="submit" variant="primary" data-testid="memory-search-submit" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>

      <div className="memory-toolbar">
        <SegmentedControl
          label="Search mode"
          value={mode}
          options={[
            { value: "records", label: "Stored records" },
            { value: "workspace", label: "Workspace files (on demand)" },
          ]}
          onChange={(value) => setMode(value === "workspace" ? "workspace" : "records")}
        />
        <div className="memory-badges" role="group" aria-label="Sources">
          {MEMORY_SOURCES.map((source) => {
            const selected = sources.includes(source);
            return (
              <Button
                key={source}
                size="sm"
                variant={selected ? "secondary" : "ghost"}
                aria-pressed={selected}
                data-testid={`memory-source-${source}`}
                onClick={() => toggleSource(source)}
              >
                {MEMORY_SOURCE_LABELS[source]}
              </Button>
            );
          })}
        </div>
      </div>

      {searchError ? (
        <Callout
          tone="danger"
          title="Search failed"
          action={
            <Button size="sm" variant="ghost" onClick={() => setSearchError(null)}>
              Dismiss
            </Button>
          }
        >
          {searchError}
        </Callout>
      ) : null}

      <div className="memory-split">
        <div data-testid="memory-results">
          <Card title="Results" eyebrow={SEARCH_MODE_LABEL[mode]}>
            {mode === "records" ? (
              <RecordResults result={records} busy={busy} onDismiss={() => setRecords(null)} />
            ) : (
              <WorkspaceResults
                result={workspace}
                busy={busy}
                onDismiss={() => setWorkspace(null)}
              />
            )}
          </Card>
        </div>

        <div data-testid="memory-index">
          <Card title="Index" eyebrow="What Mona stores locally">
            {indexError ? (
              <Callout tone="danger" title="Index status unavailable">
                {indexError}
              </Callout>
            ) : null}
            {index ? (
              <>
                <p className="memory-meta">
                  {`${index.totalRecords} record(s) · ${index.totalRedactions} redaction(s) · generated ${index.generatedAt}`}
                </p>
                <ul className="memory-list">
                  {index.counts.map((count) => (
                    <li key={count.source} className="memory-slot">
                      <span>{MEMORY_SOURCE_LABELS[count.source]}</span>
                      <span className="memory-meta">
                        {count.present ? `${count.records} record(s)` : "no records"}
                      </span>
                    </li>
                  ))}
                </ul>
                <ul className="memory-list">
                  <li>{"Credentials are never indexed."}</li>
                  <li>
                    {"Repository contents are searched on demand, never copied into the database."}
                  </li>
                  <li>{"Search is a local read; nothing is persisted."}</li>
                </ul>
                {index.excluded.length > 0 ? (
                  <>
                    <h3 className="section__title">Not indexed</h3>
                    <ul className="memory-list">
                      {index.excluded.map((entry) => (
                        <li key={entry.what} className="memory-list__item">
                          <span>{entry.what}</span>
                          <span className="muted">{entry.why}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <dl className="detail-list">
                  <div className="detail-row">
                    <dt>Digest</dt>
                    <dd className="mono">{index.digest}</dd>
                  </div>
                  <div className="detail-row">
                    <dt>State revision</dt>
                    <dd>{index.stateRevision}</dd>
                  </div>
                </dl>
                <p className="muted">{index.note}</p>
              </>
            ) : indexError ? null : (
              <p className="muted">Reading the index…</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function RecordResults({
  result,
  busy,
  onDismiss,
}: {
  result: MemorySearchResult | null;
  busy: boolean;
  onDismiss: () => void;
}): JSX.Element {
  if (!result) {
    return <p className="muted">{busy ? "Searching…" : "Run a search to read stored records."}</p>;
  }
  return (
    <>
      <p className="memory-meta" aria-live="polite">
        {`${result.total} hit(s) across ${result.considered} record(s) · ${result.durationMs} ms · ${result.redactions} redaction(s) · not persisted`}
      </p>
      {result.hits.length === 0 ? (
        <EmptyState
          title="Nothing matched in stored records"
          description={`No stored record matched “${result.query}”. This mode reads stored records only; switch to workspace files to read repository text on demand.`}
          action={
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Clear results
            </Button>
          }
        />
      ) : (
        <div className="memory-list">
          {result.hits.map((hit) => (
            <article key={hit.id} className="memory-hit" data-testid="memory-hit">
              <h3 className="memory-hit__title">
                <Badge tone="neutral">{MEMORY_SOURCE_LABELS[hit.source]}</Badge>
                <span>{hit.title}</span>
              </h3>
              <p className="memory-hit__snippet mono">{hit.snippet}</p>
              <p className="memory-meta">
                <span>{`${hit.occurrences} occurrence(s)`}</span>
                {hit.pointer.path ? <span className="mono">{hit.pointer.path}</span> : null}
              </p>
            </article>
          ))}
        </div>
      )}
      {result.truncated ? (
        <p className="muted">The hit list is truncated; narrow the query.</p>
      ) : null}
      <p className="muted">{result.note}</p>
    </>
  );
}

function WorkspaceResults({
  result,
  busy,
  onDismiss,
}: {
  result: WorkspaceSearchResult | null;
  busy: boolean;
  onDismiss: () => void;
}): JSX.Element {
  if (!result) {
    return (
      <p className="muted">
        {busy ? "Searching…" : "Run a search to read repository text on demand."}
      </p>
    );
  }
  return (
    <>
      <p className="memory-meta" aria-live="polite">
        {`${result.hits.length} hit(s) · ${result.filesScanned} file(s) scanned · ${result.filesSkipped} skipped · ${result.bytesScanned} bytes · not persisted`}
      </p>
      <dl className="detail-list">
        <div className="detail-row">
          <dt>Scope</dt>
          <dd className="mono">{result.scope}</dd>
        </div>
        <div className="detail-row">
          <dt>Files scanned</dt>
          <dd>{result.filesScanned}</dd>
        </div>
        <div className="detail-row">
          <dt>Files skipped</dt>
          <dd>{result.filesSkipped}</dd>
        </div>
        <div className="detail-row">
          <dt>Truncated</dt>
          <dd>{result.truncated ? "yes" : "no"}</dd>
        </div>
      </dl>
      {result.skippedReasons.length > 0 ? (
        <ul className="memory-list">
          {result.skippedReasons.map((entry) => (
            <li key={entry.reason} className="memory-list__item">
              <span>{entry.reason}</span>
              <span className="memory-meta">{entry.count}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.hits.length === 0 ? (
        <EmptyState
          title="Nothing matched in workspace files"
          description={`No workspace line matched “${result.query}”. Files are read on demand and never copied into the database.`}
          action={
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Clear results
            </Button>
          }
        />
      ) : (
        <div className="memory-list">
          {result.hits.map((hit) => (
            <article
              key={`${hit.path}:${hit.line}`}
              className="memory-hit"
              data-testid="memory-hit"
            >
              <h3 className="memory-hit__title">
                <Badge tone="neutral">Workspace</Badge>
                <span className="mono">{`${hit.path}:${hit.line}`}</span>
              </h3>
              <p className="memory-hit__snippet mono">{hit.text}</p>
              {hit.truncated ? <p className="memory-meta">line truncated</p> : null}
            </article>
          ))}
        </div>
      )}
      <p className="muted">{result.note}</p>
    </>
  );
}

/* --------------------------------------------------------------- tab: shelf */

function ShelfTab({ active }: { active: boolean }): JSX.Element {
  const [view, setView] = useState<PromptShelfView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [version, setVersion] = useState(1);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PromptRenderResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", body: "", acceptance: "" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [packNote, setPackNote] = useState<string | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<PromptImportResult | null>(null);

  const load = useCallback(async () => {
    const result = await window.mona.promptShelf();
    if (!result.ok) {
      setError(errorLine(result.error));
      return;
    }
    setError(null);
    setView(result.value);
    setSelectedId((current) => {
      if (current && result.value.prompts.some((prompt) => prompt.id === current)) return current;
      return result.value.prompts[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const selected = view?.prompts.find((prompt) => prompt.id === selectedId) ?? null;
  const currentVersion = selected?.currentVersion ?? 1;

  useEffect(() => {
    setVersion(currentVersion);
    setValues({});
    setPreview(null);
    setPreviewError(null);
    setCopyNote(null);
  }, [selectedId, currentVersion]);

  const selectedVersion =
    selected?.versions.find((entry) => entry.version === version) ??
    selected?.versions[selected.versions.length - 1] ??
    null;

  const acceptance =
    preview?.acceptance ?? selectedVersion?.acceptance ?? selected?.acceptance ?? [];

  const requestPreview = useCallback(async () => {
    if (!selected) return;
    setPreviewError(null);
    const result = await window.mona.renderShelfPrompt({
      promptId: selected.id,
      version,
      values,
    });
    if (!result.ok) {
      setPreview(null);
      setPreviewError(errorLine(result.error));
      return;
    }
    setPreview(result.value);
    setCopyNote(null);
  }, [selected, version, values]);

  const copyText = useCallback(async () => {
    const text = preview?.text ?? selectedVersion?.body ?? "";
    if (text.length === 0) return;
    try {
      if (typeof navigator.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(text);
        setCopyNote("Copied to the clipboard.");
      } else {
        setCopyNote("The clipboard is unavailable; select the text instead.");
      }
    } catch {
      setCopyNote("Copy failed; select the text instead.");
    }
  }, [preview, selectedVersion]);

  const confirmRemove = useCallback(async () => {
    if (!selected) return;
    const result = await window.mona.removeShelfPrompt(selected.id);
    if (!result.ok) {
      setRemoveError(errorLine(result.error));
      return;
    }
    setRemoveError(null);
    setRemoveOpen(false);
    setSelectedId(null);
    await load();
  }, [selected, load]);

  const submitPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const label = form.label.trim();
    const body = form.body;
    if (label.length === 0 || body.trim().length === 0) {
      setSaveError("A label and a prompt body are required.");
      return;
    }
    const acceptanceItems = form.acceptance
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    setSaveBusy(true);
    const result = await window.mona.saveShelfPrompt({ label, body, acceptance: acceptanceItems });
    setSaveBusy(false);
    if (!result.ok) {
      // The bridge error names a secret class; the prompt body is never echoed.
      setSaveError(errorLine(result.error));
      return;
    }
    setSaveError(null);
    setForm({ label: "", body: "", acceptance: "" });
    await load();
    setSelectedId(result.value.id);
  };

  const exportPack = async () => {
    setPackError(null);
    const result = await window.mona.exportShelfPackFile();
    if (!result.ok) {
      setPackNote(null);
      setPackError(errorLine(result.error));
      return;
    }
    setPackNote(
      result.value.saved
        ? `Pack saved to ${result.value.path ?? "the chosen file"}.`
        : "Pack export was cancelled.",
    );
  };

  const importPack = async () => {
    setPackError(null);
    const result = await window.mona.importShelfPackFile();
    if (!result.ok) {
      setImportResult(null);
      setPackError(errorLine(result.error));
      return;
    }
    if (result.value === null) {
      setImportResult(null);
      setPackNote("Pack import was cancelled.");
      return;
    }
    setPackNote(null);
    setImportResult(result.value);
    await load();
  };

  return (
    <>
      <div className="memory-toolbar">
        <Button onClick={() => void exportPack()}>Export pack…</Button>
        <Button onClick={() => void importPack()}>Import pack…</Button>
      </div>

      {error ? (
        <Callout tone="danger" title="Prompt shelf unavailable">
          {error}
        </Callout>
      ) : null}
      {packError ? (
        <Callout tone="danger" title="Prompt pack failed">
          {packError}
        </Callout>
      ) : null}
      {packNote ? <p className="muted">{packNote}</p> : null}

      {importResult ? (
        <Card title="Pack import" eyebrow={importResult.packName}>
          <p>
            {`${importResult.created.length} created · ${importResult.skipped.length} skipped · ${importResult.redactions} redaction(s)`}
          </p>
          <p>{"Import stored text only; nothing was executed or inserted."}</p>
          {importResult.skipped.length > 0 ? (
            <ul className="memory-list">
              {importResult.skipped.map((entry) => (
                <li key={entry.label} className="memory-list__item">
                  <span>{entry.label}</span>
                  <span className="muted">{entry.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <div className="memory-split">
        <Card title="Stored prompts" eyebrow="Reusable text with variables">
          {view && view.prompts.length === 0 ? (
            <EmptyState
              title="No prompts stored yet"
              description="Save a prompt below. Saving stores text; it never runs or sends anything."
            />
          ) : null}
          <ul className="memory-list" data-testid="memory-shelf-list">
            {(view?.prompts ?? []).map((prompt) => (
              <li key={prompt.id}>
                <button
                  type="button"
                  className={cx(
                    "memory-list__item",
                    prompt.id === selectedId && "memory-list__item--active",
                  )}
                  aria-pressed={prompt.id === selectedId}
                  onClick={() => setSelectedId(prompt.id)}
                >
                  <span>{prompt.label}</span>
                  <Badge tone="neutral">{`v${prompt.currentVersion}`}</Badge>
                  <Badge tone="neutral">{`${prompt.variables.length} variable(s)`}</Badge>
                </button>
              </li>
            ))}
          </ul>
          {view ? (
            <>
              <p className="memory-meta">
                {`Limits: ${view.limits.prompts} prompts · ${view.limits.versionsPerPrompt} versions per prompt · ${view.limits.bodyBytes} bytes per body.`}
              </p>
              <p className="muted">{view.note}</p>
            </>
          ) : null}
        </Card>

        <div data-testid="memory-shelf-detail">
          <Card
            title={selected ? selected.label : "Prompt detail"}
            eyebrow={
              selected ? `Stored text · ${selected.tags.join(", ") || "untagged"}` : undefined
            }
          >
            {selected ? (
              <>
                <p className="muted">{selected.description}</p>
                <SelectField
                  label="Version"
                  value={String(version)}
                  options={selected.versions.map((entry) => ({
                    value: String(entry.version),
                    label: `Version ${entry.version}`,
                  }))}
                  onChange={(event) => {
                    setVersion(Number(event.target.value));
                    setPreview(null);
                    setPreviewError(null);
                  }}
                />
                {selected.variables.length === 0 ? (
                  <p className="muted">This prompt declares no variables.</p>
                ) : (
                  selected.variables.map((variable) => (
                    <TextField
                      key={variable.name}
                      label={variable.name}
                      hint={variable.description}
                      mono
                      data-testid="memory-variable-input"
                      value={values[variable.name] ?? ""}
                      onChange={(event) =>
                        setValues((previous) => ({
                          ...previous,
                          [variable.name]: event.target.value,
                        }))
                      }
                    />
                  ))
                )}
                <div className="memory-toolbar">
                  <Button variant="primary" onClick={() => void requestPreview()}>
                    Preview
                  </Button>
                  <Button onClick={() => void copyText()}>Copy text</Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setRemoveError(null);
                      setRemoveOpen(true);
                    }}
                  >
                    Delete prompt
                  </Button>
                </div>
                {copyNote ? <p className="muted">{copyNote}</p> : null}
                {previewError ? (
                  <Callout tone="danger" title="Preview failed">
                    {previewError}
                  </Callout>
                ) : null}
                {preview ? (
                  <>
                    <pre className="memory-preview mono" data-testid="memory-prompt-preview">
                      {preview.text}
                    </pre>
                    <p className="memory-meta">{`${preview.bytes} bytes · v${preview.version}`}</p>
                    <dl className="detail-list">
                      <div className="detail-row">
                        <dt>Missing variables</dt>
                        <dd>{preview.missing.length > 0 ? preview.missing.join(", ") : "none"}</dd>
                      </div>
                      <div className="detail-row">
                        <dt>Unknown variables</dt>
                        <dd>{preview.unknown.length > 0 ? preview.unknown.join(", ") : "none"}</dd>
                      </div>
                    </dl>
                    <p className="muted">
                      {
                        "Text substitution only — previewing, saving, and importing a prompt never runs or sends anything."
                      }
                    </p>
                  </>
                ) : null}
                <h3 className="section__title">Acceptance checklist</h3>
                {acceptance.length === 0 ? (
                  <p className="muted">No acceptance criteria are recorded for this version.</p>
                ) : (
                  <ul className="memory-list">
                    {acceptance.map((item) => (
                      <li key={item} className="memory-list__item">
                        <CheckIcon size={14} />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <EmptyState
                title="No prompt selected"
                description="Select a stored prompt to read, preview, or delete it."
              />
            )}
          </Card>
        </div>
      </div>

      <div data-testid="memory-shelf-save">
        <Card title="New prompt" eyebrow="Stored text only">
          <form onSubmit={(event) => void submitPrompt(event)} aria-label="Save a prompt">
            <TextField
              label="Label"
              value={form.label}
              maxLength={80}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, label: event.target.value }))
              }
              placeholder="Short name"
            />
            <TextArea
              label="Prompt body"
              hint="Use {{variable_name}} placeholders. Text is stored verbatim; a prompt that contains secret-shaped text is refused, not stored."
              rows={6}
              value={form.body}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, body: event.target.value }))
              }
            />
            <TextArea
              label="Acceptance criteria"
              hint="One criterion per line."
              rows={4}
              value={form.acceptance}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, acceptance: event.target.value }))
              }
            />
            {saveError ? (
              <Callout tone="danger" title="Prompt was not saved">
                {saveError}
              </Callout>
            ) : null}
            <Button type="submit" variant="primary" disabled={saveBusy}>
              {saveBusy ? "Saving…" : "Save prompt"}
            </Button>
          </form>
        </Card>
      </div>

      <Dialog
        open={removeOpen}
        title="Delete prompt"
        description={
          selected
            ? `Delete “${selected.label}” and every stored version? This cannot be undone.`
            : undefined
        }
        onClose={() => setRemoveOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmRemove()}>
              Delete prompt
            </Button>
          </>
        }
      >
        {removeError ? (
          <Callout tone="danger" title="Delete failed">
            {removeError}
          </Callout>
        ) : null}
        <p className="muted">Deleting a stored prompt never runs or sends anything.</p>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------- tab: resume */

function ResumeTab({
  projectId,
  boardTasks,
  active,
}: {
  projectId: string;
  boardTasks: Array<BoardTask>;
  active: boolean;
}): JSX.Element {
  const [packet, setPacket] = useState<ResumePacket | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState("");
  const [slots, setSlots] = useState<ContextSlotView[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [included, setIncluded] = useState<ContextSlot[]>([]);
  const [preview, setPreview] = useState<ContextSelectionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.mona.memoryResume(projectId as ProjectId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setPacket(null);
        setResumeError(errorLine(result.error));
        return;
      }
      setResumeError(null);
      setPacket(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [active, projectId]);

  useEffect(() => {
    if (!active || taskId.length === 0) return;
    let cancelled = false;
    setSlots(null);
    setSlotsError(null);
    setPreview(null);
    setPreviewError(null);
    void (async () => {
      const result = await window.mona.memoryContextSlots(projectId as ProjectId, taskId as TaskId);
      if (cancelled) return;
      if (!result.ok) {
        setSlotsError(errorLine(result.error));
        return;
      }
      setSlots(result.value);
      const defaults = result.value.filter((slot) => slot.included).map((slot) => slot.slot);
      setIncluded(defaults);
      const previewResult = await window.mona.memoryContextPreview({
        projectId: projectId as ProjectId,
        taskId: taskId as TaskId,
        include: defaults,
      });
      if (cancelled) return;
      if (!previewResult.ok) {
        setPreviewError(errorLine(previewResult.error));
        return;
      }
      setPreview(previewResult.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, projectId, taskId]);

  const toggleSlot = (slot: ContextSlot) => {
    const next = included.includes(slot)
      ? included.filter((entry) => entry !== slot)
      : CONTEXT_SLOTS.filter((entry) => entry === slot || included.includes(entry));
    setIncluded(next);
    if (taskId.length === 0) return;
    void (async () => {
      const result = await window.mona.memoryContextPreview({
        projectId: projectId as ProjectId,
        taskId: taskId as TaskId,
        include: next,
      });
      if (!result.ok) {
        setPreview(null);
        setPreviewError(errorLine(result.error));
        return;
      }
      setPreviewError(null);
      setPreview(result.value);
    })();
  };

  return (
    <>
      <div data-testid="memory-resume">
        <Card
          title="Resume packet"
          eyebrow={packet ? packet.projectName : "Assembled from stored records"}
        >
          {resumeError ? (
            <Callout tone="danger" title="Resume packet unavailable">
              {resumeError}
            </Callout>
          ) : null}
          {packet ? (
            <>
              <p className="memory-meta">
                {`${packet.bytes} bytes · state revision ${packet.stateRevision} · generated ${packet.generatedAt}`}
              </p>
              <pre className="memory-preview mono" data-testid="memory-resume-text">
                {packet.text}
              </pre>
              <h3 className="section__title">Pointers</h3>
              <dl className="detail-list">
                {packet.pointers.map((pointer) => (
                  <div className="detail-row" key={`${pointer.kind}-${pointer.label}`}>
                    <dt>{pointer.label}</dt>
                    <dd>
                      <span className="mono">{pointer.value}</span>{" "}
                      <Badge tone={pointer.available ? "success" : "neutral"}>
                        {pointer.available ? "present" : "missing"}
                      </Badge>
                      {pointer.note ? <span className="muted"> {pointer.note}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
              <h3 className="section__title">Not in the packet</h3>
              {packet.excluded.length === 0 ? (
                <p className="muted">Nothing is excluded.</p>
              ) : (
                <ul className="memory-list">
                  {packet.excluded.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              <Callout tone="neutral" title="What this packet is">
                {`${packet.note} Mona cannot show the assembled provider request; this packet is Mona's own text.`}
              </Callout>
            </>
          ) : resumeError ? null : (
            <p className="muted">Reading the resume packet…</p>
          )}
        </Card>
      </div>

      <Card title="Context selection" eyebrow="What Mona would submit">
        <SelectField
          label="Task"
          value={taskId}
          options={[
            { value: "", label: "Choose a task" },
            ...boardTasks.map((task) => ({ value: task.id, label: task.title })),
          ]}
          onChange={(event) => setTaskId(event.target.value)}
        />
        {boardTasks.length === 0 ? <p className="muted">The board has no tasks yet.</p> : null}
        {taskId.length === 0 ? (
          <EmptyState
            title="Choose a task to preview the context Mona would submit."
            description="Mona assembles this text from stored records. The engine assembles the provider request, and Mona cannot show it."
          />
        ) : (
          <>
            {slotsError ? (
              <Callout tone="danger" title="Context slots unavailable">
                {slotsError}
              </Callout>
            ) : null}
            <div data-testid="memory-context-slots">
              {(slots ?? []).map((slot) => {
                const checked = included.includes(slot.slot);
                const inputId = `memory-slot-${slot.slot}`;
                return (
                  <label
                    key={slot.slot}
                    htmlFor={inputId}
                    className={cx("memory-slot", checked && "memory-slot--included")}
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked}
                      disabled={!slot.available}
                      onChange={() => toggleSlot(slot.slot)}
                    />
                    <span>{slot.label}</span>
                    <span className="memory-meta">{`${slot.items} item(s) · ${slot.bytes} bytes`}</span>
                    {slot.available ? null : <Badge tone="neutral">unavailable</Badge>}
                  </label>
                );
              })}
              {slots && slots.length === 0 ? (
                <p className="muted">No context slots are available for this task.</p>
              ) : null}
            </div>

            {previewError ? (
              <Callout tone="danger" title="Context preview failed">
                {previewError}
              </Callout>
            ) : null}
            {preview ? (
              <div data-testid="memory-context-preview">
                <pre className="memory-preview mono">{preview.text}</pre>
                <p className="memory-meta" aria-live="polite">
                  {`${preview.bytes} bytes · ${preview.redactions} redaction(s)`}
                </p>
                <h3 className="section__title">Included</h3>
                <ul className="memory-list">
                  {preview.included.map((slot) => (
                    <li key={slot} className="memory-list__item">
                      {CONTEXT_SLOT_LABELS[slot]}
                    </li>
                  ))}
                </ul>
                <h3 className="section__title">Excluded</h3>
                {preview.excluded.length === 0 ? (
                  <p className="muted">Nothing is excluded from this selection.</p>
                ) : (
                  <ul className="memory-list">
                    {preview.excluded.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                <Callout tone="neutral" title="Provider request">
                  {preview.providerRequestNote}
                </Callout>
                <p className="muted">{preview.note}</p>
              </div>
            ) : previewError ? null : (
              <p className="muted">Reading the context selection…</p>
            )}
          </>
        )}
      </Card>
    </>
  );
}

/* ------------------------------------------------------------- tab: handoff */

function HandoffTab({ projectId, active }: { projectId: string; active: boolean }): JSX.Element {
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [bundlePath, setBundlePath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<HandoffInspection | null>(null);
  const [importMode, setImportMode] = useState<"create" | "replace">("create");
  const [rootPath, setRootPath] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [importResult, setImportResult] = useState<HandoffImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [settings, setSettings] = useState<SettingsBackupView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsPath, setSettingsPath] = useState<string | null>(null);
  const [settingsInspection, setSettingsInspection] = useState<SettingsBackupInspection | null>(
    null,
  );
  const [settingsNote, setSettingsNote] = useState<string | null>(null);
  const [restoreMode, setRestoreMode] = useState<"merge" | "replace">("merge");
  const [replaceConfirmText, setReplaceConfirmText] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreResult, setRestoreResult] = useState<SettingsRestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const [diagnostics, setDiagnostics] = useState<DiagnosticsPreview | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [diagnosticsNote, setDiagnosticsNote] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const [previewResult, settingsResult, diagnosticsResult] = await Promise.all([
        window.mona.handoffPreview(projectId as ProjectId),
        window.mona.settingsBackupPreview(),
        window.mona.diagnosticsPreview(projectId as ProjectId),
      ]);
      if (cancelled) return;
      if (previewResult.ok) {
        setPreview(previewResult.value);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(errorLine(previewResult.error));
      }
      if (settingsResult.ok) {
        setSettings(settingsResult.value);
        setSettingsError(null);
      } else {
        setSettings(null);
        setSettingsError(errorLine(settingsResult.error));
      }
      if (diagnosticsResult.ok) {
        setDiagnostics(diagnosticsResult.value);
        setDiagnosticsError(null);
      } else {
        setDiagnostics(null);
        setDiagnosticsError(errorLine(diagnosticsResult.error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, projectId]);

  const exportBundle = async () => {
    setHandoffError(null);
    const result = await window.mona.exportHandoff(projectId as ProjectId);
    if (!result.ok) {
      setExportNote(null);
      setHandoffError(errorLine(result.error));
      return;
    }
    setExportNote(
      result.value.saved
        ? `Handoff saved to ${result.value.path ?? "the chosen file"} · ${result.value.entries} entries · ${result.value.bytes} bytes · ${result.value.redactions} redaction(s).`
        : "Handoff export was cancelled.",
    );
  };

  const chooseBundle = async () => {
    setHandoffError(null);
    const chosen = await window.mona.chooseHandoff();
    if (!chosen.ok) {
      setHandoffError(errorLine(chosen.error));
      return;
    }
    if (chosen.value === null) return;
    setBundlePath(chosen.value);
    const result = await window.mona.inspectHandoff(chosen.value);
    if (!result.ok) {
      setInspection(null);
      setHandoffError(errorLine(result.error));
      return;
    }
    setInspection(result.value);
  };

  const runImport = async () => {
    if (!bundlePath) {
      setImportError("Inspect a handoff bundle before importing.");
      return;
    }
    setReplaceOpen(false);
    setImportError(null);
    const result = await window.mona.importHandoff({
      path: bundlePath,
      rootPath: rootPath.trim().length > 0 ? rootPath.trim() : undefined,
      mode: importMode,
    });
    if (!result.ok) {
      setImportResult(null);
      setImportError(errorLine(result.error));
      return;
    }
    setImportResult(result.value);
  };

  const exportBackup = async () => {
    setSettingsError(null);
    const result = await window.mona.exportSettingsBackup();
    if (!result.ok) {
      setSettingsNote(null);
      setSettingsError(errorLine(result.error));
      return;
    }
    setSettingsNote(
      result.value.saved
        ? `Backup saved to ${result.value.path ?? "the chosen file"} · ${result.value.scopes} scope(s) · ${result.value.bytes} bytes.`
        : "Backup export was cancelled.",
    );
  };

  const chooseBackup = async () => {
    setSettingsError(null);
    const chosen = await window.mona.chooseSettingsBackup();
    if (!chosen.ok) {
      setSettingsError(errorLine(chosen.error));
      return;
    }
    if (chosen.value === null) return;
    setSettingsPath(chosen.value);
    const result = await window.mona.inspectSettingsBackup(chosen.value);
    if (!result.ok) {
      setSettingsInspection(null);
      setSettingsError(errorLine(result.error));
      return;
    }
    setSettingsInspection(result.value);
  };

  const runRestore = async (mode: "merge" | "replace") => {
    if (!settingsPath) {
      setRestoreError("Choose a settings backup before restoring.");
      return;
    }
    setRestoreOpen(false);
    setRestoreError(null);
    const result = await window.mona.restoreSettings({
      path: settingsPath,
      mode,
      confirm: mode === "replace" ? true : undefined,
    });
    if (!result.ok) {
      setRestoreResult(null);
      setRestoreError(errorLine(result.error));
      return;
    }
    setRestoreResult(result.value);
  };

  const exportDiagnostics = async () => {
    setDiagnosticsError(null);
    const result = await window.mona.exportDiagnosticsBundle(projectId as ProjectId);
    if (!result.ok) {
      setDiagnosticsNote(null);
      setDiagnosticsError(errorLine(result.error));
      return;
    }
    setDiagnosticsNote(
      result.value.saved
        ? `Diagnostics saved to ${result.value.path ?? "the chosen file"} · ${result.value.bytes} bytes · ${result.value.redactions} redaction(s).`
        : "Diagnostics export was cancelled.",
    );
  };

  return (
    <>
      <div data-testid="memory-handoff-preview">
        <Card
          title="Handoff bundle"
          eyebrow="Mona-owned records, not an engine session"
          actions={
            <>
              <Button size="sm" onClick={() => void exportBundle()}>
                Export handoff…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void chooseBundle()}>
                Inspect bundle…
              </Button>
            </>
          }
        >
          {previewError ? (
            <Callout tone="danger" title="Handoff preview unavailable">
              {previewError}
            </Callout>
          ) : null}
          {handoffError ? (
            <Callout tone="danger" title="Handoff action failed">
              {handoffError}
            </Callout>
          ) : null}
          {exportNote ? <p className="muted">{exportNote}</p> : null}
          {preview ? (
            <>
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Counts</dt>
                  <dd>
                    {`${preview.counts.tasks} tasks · ${preview.counts.decisions} decisions · ${preview.counts.evidence} evidence · ${preview.counts.attempts} attempts · ${preview.counts.prompts} prompts · ${preview.counts.pointers} pointers`}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Total size</dt>
                  <dd>{`${preview.totalBytes} bytes`}</dd>
                </div>
                <div className="detail-row">
                  <dt>Redactions</dt>
                  <dd>{preview.redactions}</dd>
                </div>
                <div className="detail-row">
                  <dt>Can export</dt>
                  <dd>{preview.canExport ? "yes" : "no"}</dd>
                </div>
              </dl>
              <h3 className="section__title">Entries</h3>
              {preview.entries.length === 0 ? (
                <p className="muted">This bundle would carry no entries.</p>
              ) : (
                <ul className="memory-list">
                  {preview.entries.map((entry) => (
                    <li key={entry.path} className="memory-list__item">
                      <span className="mono">{entry.path}</span>
                      <Badge tone="neutral">{entry.kind}</Badge>
                      <span className="memory-meta">{`${entry.sizeBytes} bytes`}</span>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="section__title">Artifact checks</h3>
              {preview.artifactChecks.length === 0 ? (
                <p className="muted">No artifacts are referenced by this project.</p>
              ) : (
                <ul className="memory-list">
                  {preview.artifactChecks.map((check) => (
                    <li key={check.artifactId} className="memory-slot">
                      <span className="mono">{check.relPath}</span>
                      <Badge tone={check.present ? "success" : "attention"}>
                        {check.present ? "present" : "missing"}
                      </Badge>
                      <Badge tone={check.matches ? "success" : "danger"}>
                        {check.matches ? "digest matches" : "digest differs"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="section__title">Excluded</h3>
              {preview.excluded.length === 0 ? (
                <p className="muted">Nothing is excluded from this bundle.</p>
              ) : (
                <ul className="memory-list">
                  {preview.excluded.map((entry) => (
                    <li key={entry.what} className="memory-list__item">
                      <span>{entry.what}</span>
                      <span className="muted">{entry.why}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">{preview.note}</p>
            </>
          ) : previewError ? null : (
            <p className="muted">Reading the handoff preview…</p>
          )}
        </Card>
      </div>

      <div data-testid="memory-handoff-inspection">
        <Card title="Bundle inspection" eyebrow={inspection?.path ?? "Choose a bundle"}>
          {inspection ? (
            <>
              <p className="memory-meta">
                <Badge tone={inspection.ok ? "success" : "danger"}>
                  {inspection.ok ? "ok" : "problems"}
                </Badge>
                <span>{`${inspection.bytes} bytes · ${inspection.path}`}</span>
              </p>
              {inspection.problems.length > 0 ? (
                <ul className="memory-list">
                  {inspection.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              ) : null}
              {inspection.ok && inspection.project ? (
                <dl className="detail-list">
                  <div className="detail-row">
                    <dt>Project</dt>
                    <dd>{`${inspection.project.name} · ${inspection.project.rootPath}`}</dd>
                  </div>
                  <div className="detail-row">
                    <dt>Records</dt>
                    <dd>
                      {`${inspection.project.tasks} tasks · ${inspection.project.decisions} decisions · ${inspection.project.evidence} evidence · ${inspection.project.attempts} attempts`}
                    </dd>
                  </div>
                  <div className="detail-row">
                    <dt>Missing local files</dt>
                    <dd>
                      {inspection.missingLocalFiles.length === 0
                        ? "none"
                        : inspection.missingLocalFiles
                            .map((entry) => `${entry.path} (${entry.requirement})`)
                            .join(", ")}
                    </dd>
                  </div>
                  <div className="detail-row">
                    <dt>Stale digests</dt>
                    <dd>
                      {inspection.staleDigests.length === 0
                        ? "none"
                        : inspection.staleDigests.map((entry) => entry.path).join(", ")}
                    </dd>
                  </div>
                  <div className="detail-row">
                    <dt>Requalification</dt>
                    <dd>
                      {`required: ${inspection.requalification.required ? "yes" : "no"} · engine ${inspection.requalification.localEngine.version ?? "not recorded"} · source ${inspection.requalification.source} · machine binding ${inspection.requalification.machineBinding}`}
                    </dd>
                  </div>
                </dl>
              ) : null}
              {inspection.ok && inspection.requalification.reasons.length > 0 ? (
                <ul className="memory-list">
                  {inspection.requalification.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
              <h3 className="section__title">Cannot transfer</h3>
              <ul className="memory-list">
                {inspection.cannotTransfer.map((item) => (
                  <li key={item}>{`• ${item}`}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">Inspect a bundle to see what it carries and what it cannot.</p>
          )}
        </Card>
      </div>

      <Card title="Import a handoff" eyebrow="Creates records only">
        <div className="memory-toolbar">
          <SelectField
            label="Import mode"
            value={importMode}
            options={[
              { value: "create", label: "Create a new project" },
              { value: "replace", label: "Replace the existing project" },
            ]}
            onChange={(event) =>
              setImportMode(event.target.value === "replace" ? "replace" : "create")
            }
          />
          <TextField
            label="Root path (optional)"
            hint="Leave empty to use the bundle path."
            mono
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="/Users/you/Projects/Atlas"
          />
          <Button
            variant={importMode === "replace" ? "danger" : "primary"}
            data-testid="memory-handoff-import"
            disabled={bundlePath === null}
            onClick={() => {
              setImportError(null);
              if (importMode === "replace") {
                setReplaceOpen(true);
                return;
              }
              void runImport();
            }}
          >
            Import
          </Button>
        </div>
        <p className="memory-meta">
          {bundlePath ? `Bundle: ${bundlePath}` : "Inspect a bundle to choose the import path."}
        </p>
        {importError ? (
          <Callout tone="danger" title="Import failed">
            {importError}
          </Callout>
        ) : null}
        {importResult ? (
          <Callout
            tone="success"
            title="Import finished"
            action={
              <Button size="sm" variant="ghost" onClick={() => setImportResult(null)}>
                Dismiss
              </Button>
            }
          >
            <p>
              {`${importResult.imported.tasks} tasks · ${importResult.imported.decisions} decisions · ${importResult.imported.evidence} evidence · ${importResult.imported.attempts} attempts · ${importResult.imported.acceptance} acceptance · ${importResult.imported.steps} steps`}
            </p>
            <p>{`${importResult.projectName} · mode ${importResult.mode}`}</p>
            <p>{"Import created records only. No task was started and no engine was contacted."}</p>
          </Callout>
        ) : null}
        <Dialog
          open={replaceOpen}
          title="Replace the existing project?"
          description="A replace import overwrites matching records and cannot be undone."
          onClose={() => setReplaceOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setReplaceOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void runImport()}>
                Replace and import
              </Button>
            </>
          }
        >
          <p className="mono">{bundlePath ?? ""}</p>
        </Dialog>
      </Card>

      <div data-testid="memory-settings-preview">
        <Card
          title="Settings backup"
          eyebrow="Global preferences"
          actions={
            <>
              <Button size="sm" onClick={() => void exportBackup()}>
                Export backup…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void chooseBackup()}>
                Choose backup…
              </Button>
            </>
          }
        >
          {settingsError ? (
            <Callout tone="danger" title="Settings backup failed">
              {settingsError}
            </Callout>
          ) : null}
          {settingsNote ? <p className="muted">{settingsNote}</p> : null}
          {settings ? (
            <>
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Scopes included</dt>
                  <dd>{settings.scopes.filter((scope) => scope.included).length}</dd>
                </div>
                <div className="detail-row">
                  <dt>Scopes excluded</dt>
                  <dd>{settings.excluded.length}</dd>
                </div>
                <div className="detail-row">
                  <dt>Digest</dt>
                  <dd className="mono">{settings.digest}</dd>
                </div>
                <div className="detail-row">
                  <dt>State revision</dt>
                  <dd>{settings.stateRevision}</dd>
                </div>
              </dl>
              <h3 className="section__title">Excluded scopes</h3>
              {settings.excluded.length === 0 ? (
                <p className="muted">No scopes are excluded.</p>
              ) : (
                <ul className="memory-list">
                  {settings.excluded.map((entry) => (
                    <li key={entry.scope} className="memory-list__item">
                      <span>{entry.scope}</span>
                      <span className="muted">{entry.why}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">{settings.note}</p>
            </>
          ) : settingsError ? null : (
            <p className="muted">Reading the settings backup preview…</p>
          )}
        </Card>
      </div>

      <Card title="Settings inspection and restore" eyebrow={settingsPath ?? "Choose a backup"}>
        {settingsInspection ? (
          <>
            <p className="memory-meta">
              <Badge tone={settingsInspection.ok ? "success" : "danger"}>
                {settingsInspection.ok ? "ok" : "problems"}
              </Badge>
              <span>{`${settingsInspection.bytes} bytes`}</span>
            </p>
            {settingsInspection.problems.length > 0 ? (
              <ul className="memory-list">
                {settingsInspection.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
            <ul className="memory-list">
              {settingsInspection.scopes.map((scope) => (
                <li key={scope.scope} className="memory-slot">
                  <span>{scope.scope}</span>
                  <Badge
                    tone={
                      scope.action === "downgrade"
                        ? "attention"
                        : scope.action === "noop"
                          ? "neutral"
                          : "primary"
                    }
                  >
                    {scope.action}
                  </Badge>
                  <span className="memory-meta">
                    {`local v${scope.localVersion ?? "none"} → backup v${scope.version}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">Choose a backup to list what a restore would change.</p>
        )}
        <div className="memory-toolbar">
          <SelectField
            label="Restore mode"
            value={restoreMode}
            options={[
              { value: "merge", label: "Merge" },
              { value: "replace", label: "Replace" },
            ]}
            onChange={(event) =>
              setRestoreMode(event.target.value === "replace" ? "replace" : "merge")
            }
          />
          <Button
            variant={restoreMode === "replace" ? "danger" : "primary"}
            disabled={settingsPath === null}
            onClick={() => {
              setRestoreError(null);
              if (restoreMode === "replace") {
                setReplaceConfirmText("");
                setRestoreOpen(true);
                return;
              }
              void runRestore("merge");
            }}
          >
            Restore
          </Button>
        </div>
        <p className="memory-meta">
          {settingsPath ? `Backup: ${settingsPath}` : "Choose a backup to restore from."}
        </p>
        {restoreError ? (
          <Callout tone="danger" title="Restore failed">
            {restoreError}
          </Callout>
        ) : null}
        {restoreResult ? (
          <Callout tone="success" title="Restore receipt">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>Applied</dt>
                <dd>{restoreResult.applied.length}</dd>
              </div>
              <div className="detail-row">
                <dt>Reset</dt>
                <dd>{restoreResult.reset.length}</dd>
              </div>
              <div className="detail-row">
                <dt>Journal</dt>
                <dd className="mono">{restoreResult.journal}</dd>
              </div>
              <div className="detail-row">
                <dt>Verification</dt>
                <dd>{restoreResult.verification}</dd>
              </div>
            </dl>
          </Callout>
        ) : null}
        <Dialog
          open={restoreOpen}
          title="Replace settings from a backup"
          description="Type replace to confirm. Scopes absent from the backup are reset, except credential-bearing scopes and the prompt shelf, which a replace never removes; version history is retained."
          onClose={() => setRestoreOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRestoreOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={replaceConfirmText.trim().toLowerCase() !== "replace"}
                onClick={() => void runRestore("replace")}
              >
                Replace settings
              </Button>
            </>
          }
        >
          <TextField
            label="Type replace"
            value={replaceConfirmText}
            onChange={(event) => setReplaceConfirmText(event.target.value)}
          />
        </Dialog>
      </Card>

      <div data-testid="memory-diagnostics-preview">
        <Card
          title="Diagnostics"
          eyebrow="Redacted local snapshot"
          actions={
            <Button size="sm" onClick={() => void exportDiagnostics()}>
              Export diagnostics…
            </Button>
          }
        >
          {diagnosticsError ? (
            <Callout tone="danger" title="Diagnostics unavailable">
              {diagnosticsError}
            </Callout>
          ) : null}
          {diagnosticsNote ? <p className="muted">{diagnosticsNote}</p> : null}
          {diagnostics ? (
            <>
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Digest</dt>
                  <dd className="mono">{diagnostics.digest}</dd>
                </div>
                <div className="detail-row">
                  <dt>Size</dt>
                  <dd>{`${diagnostics.bytes} bytes`}</dd>
                </div>
                <div className="detail-row">
                  <dt>Redactions</dt>
                  <dd>{`${diagnostics.redactions} redaction(s)`}</dd>
                </div>
              </dl>
              <h3 className="section__title">Excluded</h3>
              <ul className="memory-list">
                {diagnostics.excluded.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={diagnosticsOpen}
                onClick={() => setDiagnosticsOpen((value) => !value)}
              >
                {diagnosticsOpen ? "Hide the diagnostics text" : "Show the diagnostics text"}
              </Button>
              {diagnosticsOpen ? (
                <pre className="memory-preview mono">{diagnostics.text}</pre>
              ) : null}
              <p className="muted">{diagnostics.note}</p>
            </>
          ) : diagnosticsError ? null : (
            <p className="muted">Reading the diagnostics preview…</p>
          )}
        </Card>
      </div>
    </>
  );
}
