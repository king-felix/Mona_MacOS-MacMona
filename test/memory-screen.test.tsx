// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcResult } from "../src/shared/contracts/project-bridge";
import {
  MEMORY_SOURCES,
  type ContextSelectionPreview,
  type ContextSlotView,
  type DiagnosticsPreview,
  type HandoffImportResult,
  type HandoffInspection,
  type HandoffPreview,
  type MemoryIndexStatus,
  type MemorySearchResult,
  type PromptRenderResult,
  type PromptShelfView,
  type ResumePacket,
  type SettingsBackupInspection,
  type SettingsBackupView,
  type SettingsRestoreResult,
  type WorkspaceSearchResult,
} from "../src/shared/contracts/memory";
import { MemoryScreen } from "../src/renderer/shell/Memory";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const PROJECT_ID = "prj_abcdefgh1234";
const TASK_ID = "tsk_abcdefgh1234";
const PROMPT_ID = "prompt-one";
const BUNDLE_PATH = "/tmp/mona-handoff/bundle";

const TASKS = [{ id: TASK_ID, title: "Wire the memory bridge", status: "pending" }];

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

/* --------------------------------------------------------------- fixtures */

const ok = <T,>(value: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true as const, value });

function counts(): MemoryIndexStatus["counts"] {
  return MEMORY_SOURCES.map((source) => ({
    source,
    records: source === "task" ? 3 : 0,
    redactions: 0,
    present: source === "task",
  }));
}

function indexStatus(): MemoryIndexStatus {
  return {
    projectId: PROJECT_ID,
    generatedAt: "2026-11-12T10:00:00.000Z",
    digest: "sha256:index",
    counts: counts(),
    totalRecords: 3,
    totalRedactions: 0,
    stateRevision: 7,
    repositoryContents: "on_demand",
    credentialsIndexed: false,
    embeddings: false,
    excluded: [{ what: "Credentials", why: "Never indexed." }],
    retention: { note: "Records live in the project database.", evidenceProtected: true },
    note: "The index counts stored records only.",
  };
}

function searchResult(): MemorySearchResult {
  return {
    projectId: PROJECT_ID,
    query: "alpha",
    terms: ["alpha"],
    hits: [
      {
        id: "hit-1",
        source: "task",
        title: "Wire the memory bridge",
        snippet: "alpha appears in the task prompt",
        score: 4,
        matchedTerms: ["alpha"],
        occurrences: 2,
        redactions: 0,
        updatedAt: "2026-11-12T09:00:00.000Z",
        pointer: { kind: "task", recordId: TASK_ID, path: "docs/task.md" },
      },
    ],
    total: 1,
    truncated: false,
    considered: 12,
    sources: counts(),
    persisted: false,
    redactions: 1,
    durationMs: 4,
    note: "Ranked by term matches; not a relevance claim.",
  };
}

function workspaceResult(): WorkspaceSearchResult {
  return {
    projectId: PROJECT_ID,
    query: "alpha",
    hits: [{ path: "src/main.ts", line: 12, text: "export const alpha = 1;", truncated: false }],
    filesScanned: 40,
    filesSkipped: 3,
    bytesScanned: 2048,
    truncated: false,
    skippedReasons: [{ reason: "binary file", count: 3 }],
    scope: "Workspace files under the project root, excluding .git, node_modules, and binaries",
    persisted: false,
    note: "Read on demand; nothing is copied into the database.",
  };
}

function resumePacket(): ResumePacket {
  return {
    projectId: PROJECT_ID,
    projectName: "Atlas",
    generatedAt: "2026-11-12T10:00:00.000Z",
    text: "Resume packet for Atlas\n3 tasks pending",
    bytes: 42,
    pointers: [
      {
        kind: "task",
        label: "Active task",
        value: "Wire the memory bridge",
        available: true,
        note: null,
      },
      {
        kind: "file",
        label: "Requirements",
        value: "docs/requirements.md",
        available: false,
        note: "missing locally",
      },
    ],
    excluded: ["Credentials", "Engine session ids"],
    stateRevision: 7,
    exactProviderRequest: false,
    engineInspection: "unavailable",
    note: "This packet is assembled from stored records.",
  };
}

function contextSlots(): ContextSlotView[] {
  return [
    {
      slot: "prompt",
      label: "Task prompt",
      available: true,
      included: true,
      items: 1,
      bytes: 120,
      note: "",
    },
    {
      slot: "acceptance",
      label: "Acceptance criteria",
      available: true,
      included: true,
      items: 2,
      bytes: 80,
      note: "",
    },
    {
      slot: "decisions",
      label: "Project decisions",
      available: true,
      included: false,
      items: 3,
      bytes: 200,
      note: "",
    },
  ];
}

function contextPreview(): ContextSelectionPreview {
  return {
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    text: "Task prompt\nAcceptance criteria",
    bytes: 200,
    slots: contextSlots(),
    included: ["prompt", "acceptance"],
    excluded: ["Engine session state"],
    truncated: false,
    redactions: 2,
    exactProviderRequest: false,
    providerRequestNote: "The engine assembles the provider request; Mona cannot show it.",
    note: "This text is what Mona would submit.",
  };
}

function shelfView(): PromptShelfView {
  return {
    prompts: [
      {
        id: PROMPT_ID,
        label: "Review diff",
        description: "Ask for a careful review of a diff.",
        currentVersion: 2,
        versions: [
          {
            version: 1,
            body: "Review {{path}}",
            digest: "digest-1",
            note: null,
            createdAt: "2026-11-10T10:00:00.000Z",
            variables: ["path"],
            acceptance: ["Names a file"],
          },
          {
            version: 2,
            body: "Review {{path}} for {{focus}}",
            digest: "digest-2",
            note: null,
            createdAt: "2026-11-11T10:00:00.000Z",
            variables: ["path", "focus"],
            acceptance: ["Names a file", "States focus"],
          },
        ],
        variables: [
          {
            name: "path",
            description: "Workspace-relative file path",
            required: true,
            sample: "src/main.ts",
          },
          {
            name: "focus",
            description: "What to focus on",
            required: false,
            sample: "error handling",
          },
        ],
        acceptance: ["Names a file", "States focus"],
        tags: ["review"],
        updatedAt: "2026-11-11T10:00:00.000Z",
        redacted: false,
      },
    ],
    storage: { scope: "global", version: 1 },
    limits: { prompts: 50, versionsPerPrompt: 10, bodyBytes: 20000 },
    note: "Prompts are stored text. Nothing runs.",
  };
}

function renderResult(): PromptRenderResult {
  return {
    promptId: PROMPT_ID,
    version: 2,
    text: "Review src/main.ts for error handling",
    bytes: 36,
    missing: ["focus"],
    unknown: [],
    acceptance: ["Names a file", "States focus"],
    inert: true,
  };
}

function handoffPreview(): HandoffPreview {
  return {
    projectId: PROJECT_ID,
    projectName: "Atlas",
    generatedAt: "2026-11-12T10:00:00.000Z",
    entries: [
      { path: "manifest.json", digest: "digest-manifest", sizeBytes: 120, kind: "manifest" },
      { path: "readme.md", digest: "digest-readme", sizeBytes: 240, kind: "readme" },
    ],
    totalBytes: 360,
    counts: { tasks: 3, decisions: 2, evidence: 4, attempts: 1, prompts: 2, pointers: 5 },
    redactions: 1,
    artifactChecks: [
      {
        artifactId: "art-1",
        digest: "digest-art",
        relPath: "evidence/report.md",
        present: true,
        matches: true,
        note: "",
      },
    ],
    excluded: [{ what: "Credentials", why: "A handoff never carries credentials." }],
    canExport: true,
    projectRevision: 7,
    note: "This bundle carries Mona records and file pointers, not source or sessions.",
  };
}

function requalification(): HandoffInspection["requalification"] {
  return {
    required: true,
    reasons: ["The bundle was written on another machine."],
    localEngine: { version: "0.10.2", commit: "ff466b2", checked: true },
    machineBinding: "requalified",
    note: "Re-run verification on this machine.",
  };
}

function handoffInspection(): HandoffInspection {
  return {
    path: BUNDLE_PATH,
    ok: true,
    problems: [],
    manifest: {
      format: "mona-handoff",
      format_version: 1,
      digest: "digest-manifest",
      created_at: "2026-11-12T10:00:00.000Z",
    },
    project: {
      id: PROJECT_ID,
      name: "Atlas",
      rootPath: "/Users/you/Projects/Atlas",
      revision: 7,
      tasks: 3,
      decisions: 2,
      evidence: 4,
      attempts: 1,
    },
    missingLocalFiles: [{ path: "evidence/report.md", requirement: "optional" }],
    staleDigests: [{ path: "manifest.json", expected: "digest-a", actual: null }],
    artifactChecks: [],
    requalification: requalification(),
    cannotTransfer: ["Engine session ids", "Credentials"],
    bytes: 4096,
  };
}

function handoffImportResult(): HandoffImportResult {
  return {
    projectId: PROJECT_ID,
    projectName: "Atlas",
    mode: "create",
    imported: { tasks: 3, decisions: 2, evidence: 4, attempts: 1, acceptance: 5, steps: 6 },
    missingLocalFiles: [],
    staleDigests: [],
    requalification: requalification(),
    startedWork: false,
    redactions: 1,
    problems: [],
  };
}

function settingsBackup(): SettingsBackupView {
  return {
    generatedAt: "2026-11-12T10:00:00.000Z",
    scopes: [
      {
        scope: "route",
        version: 2,
        digest: "digest-route",
        sizeBytes: 80,
        included: true,
        reason: null,
      },
    ],
    excluded: [{ scope: "credentials", why: "Secrets are never backed up." }],
    digest: "digest-settings",
    text: "{}",
    stateRevision: 4,
    note: "Backups carry preferences, never credentials.",
  };
}

function settingsInspection(): SettingsBackupInspection {
  return {
    path: "/tmp/mona-settings.json",
    ok: true,
    problems: [],
    scopes: [
      { scope: "route", version: 2, digest: "digest-route", localVersion: 1, action: "update" },
    ],
    digest: "digest-settings",
    bytes: 512,
  };
}

function restoreResult(): SettingsRestoreResult {
  return {
    restored: true,
    applied: [{ scope: "route", fromVersion: 1, toVersion: 2 }],
    reset: [],
    skipped: [],
    barrier: "exclusive",
    journal: "/tmp/journal.jsonl",
    snapshot: "/tmp/snapshot.json",
    verification: "digest verified",
    stateRevision: 5,
  };
}

function diagnosticsPreview(): DiagnosticsPreview {
  return {
    generatedAt: "2026-11-12T10:00:00.000Z",
    entries: [{ name: "app.json", sizeBytes: 100, digest: "digest-app", redactions: 7 }],
    text: '{"app":"mona"}',
    bytes: 128,
    digest: "digest-diagnostics",
    redactions: 7,
    excluded: ["Environment variables are never captured."],
    environmentIncluded: false,
    credentialsIncluded: false,
    note: "Redacted before writing.",
  };
}

/* ------------------------------------------------------------------ bridge */

function installBridge() {
  const fake = {
    memoryIndex: vi.fn(async (): Promise<IpcResult<MemoryIndexStatus>> => ok(indexStatus())),
    memorySearch: vi.fn(async (): Promise<IpcResult<MemorySearchResult>> => ok(searchResult())),
    memoryWorkspaceSearch: vi.fn(async (): Promise<IpcResult<WorkspaceSearchResult>> =>
      ok(workspaceResult()),
    ),
    memoryResume: vi.fn(async (): Promise<IpcResult<ResumePacket>> => ok(resumePacket())),
    memoryContextSlots: vi.fn(async (): Promise<IpcResult<ContextSlotView[]>> =>
      ok(contextSlots()),
    ),
    memoryContextPreview: vi.fn(async (): Promise<IpcResult<ContextSelectionPreview>> =>
      ok(contextPreview()),
    ),
    promptShelf: vi.fn(async (): Promise<IpcResult<PromptShelfView>> => ok(shelfView())),
    renderShelfPrompt: vi.fn(async (): Promise<IpcResult<PromptRenderResult>> =>
      ok(renderResult()),
    ),
    saveShelfPrompt: vi.fn(async (): Promise<IpcResult<PromptShelfView["prompts"][number]>> =>
      ok(shelfView().prompts[0]!),
    ),
    removeShelfPrompt: vi.fn(async (): Promise<IpcResult<{ removed: boolean; id: string }>> =>
      ok({ removed: true, id: PROMPT_ID }),
    ),
    exportShelfPackFile: vi.fn(
      async (): Promise<IpcResult<{ saved: boolean; path: string | null }>> =>
        ok({ saved: true, path: "/tmp/prompt-pack.json" }),
    ),
    importShelfPackFile: vi.fn(
      async (): Promise<
        IpcResult<{ packName: string; created: []; skipped: []; redactions: 0; inert: true } | null>
      > => ok(null),
    ),
    handoffPreview: vi.fn(async (): Promise<IpcResult<HandoffPreview>> => ok(handoffPreview())),
    exportHandoff: vi.fn(
      async (): Promise<
        IpcResult<{
          saved: boolean;
          path: string | null;
          digest: string;
          entries: number;
          bytes: number;
          redactions: number;
        }>
      > =>
        ok({
          saved: true,
          path: "/tmp/handoff",
          digest: "digest",
          entries: 2,
          bytes: 360,
          redactions: 1,
        }),
    ),
    chooseHandoff: vi.fn(async (): Promise<IpcResult<string | null>> => ok(BUNDLE_PATH)),
    inspectHandoff: vi.fn(async (): Promise<IpcResult<HandoffInspection>> =>
      ok(handoffInspection()),
    ),
    importHandoff: vi.fn(async (): Promise<IpcResult<HandoffImportResult>> =>
      ok(handoffImportResult()),
    ),
    settingsBackupPreview: vi.fn(async (): Promise<IpcResult<SettingsBackupView>> =>
      ok(settingsBackup()),
    ),
    exportSettingsBackup: vi.fn(
      async (): Promise<
        IpcResult<{
          saved: boolean;
          path: string | null;
          digest: string;
          scopes: number;
          bytes: number;
        }>
      > =>
        ok({
          saved: true,
          path: "/tmp/mona-settings.json",
          digest: "digest",
          scopes: 1,
          bytes: 512,
        }),
    ),
    chooseSettingsBackup: vi.fn(async (): Promise<IpcResult<string | null>> =>
      ok("/tmp/mona-settings.json"),
    ),
    inspectSettingsBackup: vi.fn(async (): Promise<IpcResult<SettingsBackupInspection>> =>
      ok(settingsInspection()),
    ),
    restoreSettings: vi.fn(async (): Promise<IpcResult<SettingsRestoreResult>> =>
      ok(restoreResult()),
    ),
    diagnosticsPreview: vi.fn(async (): Promise<IpcResult<DiagnosticsPreview>> =>
      ok(diagnosticsPreview()),
    ),
    exportDiagnosticsBundle: vi.fn(
      async (): Promise<
        IpcResult<{
          saved: boolean;
          path: string | null;
          digest: string;
          bytes: number;
          redactions: number;
        }>
      > =>
        ok({
          saved: true,
          path: "/tmp/diagnostics.json",
          digest: "digest",
          bytes: 128,
          redactions: 7,
        }),
    ),
  };
  Object.defineProperty(window, "mona", { value: fake, configurable: true });
  return fake;
}

/* ----------------------------------------------------------------- helpers */

async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  }
}

function renderScreen(projectId: string | null = PROJECT_ID): void {
  act(() => {
    root!.render(
      <MemoryScreen
        projectId={projectId}
        projectName={projectId === null ? null : "Atlas"}
        boardTasks={TASKS}
      />,
    );
  });
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function chooseOption(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submitSearch(query: string): Promise<void> {
  const input = container!.querySelector<HTMLInputElement>('[data-testid="memory-search-input"]');
  expect(input).not.toBeNull();
  typeInto(input!, query);
  const form = input!.closest("form");
  expect(form).not.toBeNull();
  act(() => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function clickTab(label: string): Promise<void> {
  const tab = [...container!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => (button.textContent ?? "").trim() === label,
  );
  expect(tab, `tab ${label}`).toBeTruthy();
  act(() => tab!.click());
  await settle();
}

function buttonWith(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    (button.textContent ?? "").trim().includes(text),
  );
  expect(found, `button containing ${text}`).toBeTruthy();
  return found!;
}

function byTestId(id: string): HTMLElement {
  const found = container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  expect(found, `test id ${id}`).toBeTruthy();
  return found!;
}

function allByTestId(id: string): NodeListOf<HTMLElement> {
  return container!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`);
}

async function selectTask(): Promise<void> {
  const select = [...container!.querySelectorAll<HTMLSelectElement>("select")].find((element) =>
    [...element.options].some((option) => option.value === TASK_ID),
  );
  expect(select, "task select").toBeTruthy();
  chooseOption(select!, TASK_ID);
  await settle();
}

/* ------------------------------------------------------------------- tests */

describe("MemoryScreen", () => {
  it("renders the empty state, states no model call, and calls no bridge method", async () => {
    const fake = installBridge();
    renderScreen(null);
    await settle();

    const screen = byTestId("memory-screen");
    expect(screen.textContent).toContain("Open a project to use project memory");
    expect(screen.textContent).toContain("No model call is made here");
    expect(screen.textContent).toContain("nothing on this screen starts work");
    expect(container!.querySelectorAll('[role="tab"]')).toHaveLength(0);

    for (const method of Object.values(fake)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("searches stored records with the trimmed query and shows the summary and index", async () => {
    const fake = installBridge();
    renderScreen();
    await settle();

    await submitSearch("  alpha  ");

    expect(fake.memorySearch).toHaveBeenCalledTimes(1);
    expect(fake.memorySearch.mock.calls[0]?.[0]).toMatchObject({ query: "alpha", limit: 50 });

    const results = byTestId("memory-results").textContent ?? "";
    expect(results).toContain("1 hit(s) across 12 record(s)");
    expect(results).toContain("4 ms");
    expect(results).toContain("not persisted");
    expect(results).toContain("Wire the memory bridge");
    expect(allByTestId("memory-hit")).toHaveLength(1);

    const index = byTestId("memory-index").textContent ?? "";
    expect(index).toContain("Credentials are never indexed.");
    expect(index).toContain(
      "Repository contents are searched on demand, never copied into the database.",
    );
    expect(index).toContain("Search is a local read; nothing is persisted.");
    expect(index).toContain("Digest");
  });

  it("searches workspace files on demand and states the scope", async () => {
    const fake = installBridge();
    renderScreen();
    await settle();

    act(() => buttonWith("Workspace files (on demand)").click());
    await settle();
    await submitSearch("alpha");

    expect(fake.memoryWorkspaceSearch).toHaveBeenCalledTimes(1);
    expect(fake.memoryWorkspaceSearch.mock.calls[0]?.[0]).toMatchObject({
      query: "alpha",
      limit: 100,
    });
    expect(fake.memorySearch).not.toHaveBeenCalled();

    const results = byTestId("memory-results").textContent ?? "";
    expect(results).toContain(
      "Workspace files under the project root, excluding .git, node_modules, and binaries",
    );
    expect(results).toContain("src/main.ts:12");
    expect(results).toContain("not persisted");
  });

  it("reports a failed search without rendering hits", async () => {
    const fake = installBridge();
    fake.memorySearch.mockResolvedValue({
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
    });
    renderScreen();
    await settle();

    await submitSearch("alpha");

    expect(container!.textContent).toContain("NOT_FOUND: missing");
    expect(allByTestId("memory-hit")).toHaveLength(0);
    expect(byTestId("memory-results").textContent).not.toContain("not persisted");
  });

  it("lists prompts and previews substituted text without claiming a run", async () => {
    const fake = installBridge();
    renderScreen();
    await settle();
    await clickTab("Prompt shelf");

    expect(fake.promptShelf).toHaveBeenCalledTimes(1);
    const list = byTestId("memory-shelf-list").textContent ?? "";
    expect(list).toContain("Review diff");
    expect(list).toContain("v2");
    expect(list).toContain("2 variable(s)");
    expect(allByTestId("memory-variable-input")).toHaveLength(2);

    const detail = byTestId("memory-shelf-detail");
    act(() => buttonWith("Preview").click());
    await settle();

    expect(fake.renderShelfPrompt).toHaveBeenCalledTimes(1);
    expect(fake.renderShelfPrompt.mock.calls[0]?.[0]).toMatchObject({
      promptId: PROMPT_ID,
      version: 2,
    });
    expect(byTestId("memory-prompt-preview").textContent).toContain(
      "Review src/main.ts for error handling",
    );
    expect(detail.textContent).toContain("Text substitution only");
    expect(detail.textContent).toContain("Names a file");
  });

  it("renders the resume packet with pointer availability and the provider-request limit", async () => {
    const fake = installBridge();
    renderScreen();
    await settle();
    await clickTab("Resume & context");

    expect(fake.memoryResume).toHaveBeenCalledTimes(1);
    const resume = byTestId("memory-resume");
    expect(byTestId("memory-resume-text").textContent).toContain("3 tasks pending");
    expect(resume.textContent).toContain("present");
    expect(resume.textContent).toContain("missing");
    expect(resume.textContent).toContain(
      "Mona cannot show the assembled provider request; this packet is Mona's own text.",
    );
  });

  it("loads context slots, re-previews on toggle, and shows the provider note", async () => {
    const fake = installBridge();
    renderScreen();
    await settle();
    await clickTab("Resume & context");
    await selectTask();

    expect(fake.memoryContextSlots).toHaveBeenCalledWith(PROJECT_ID, TASK_ID);
    expect(byTestId("memory-context-slots").textContent).toContain("Task prompt");

    act(() => {
      container!.querySelector<HTMLInputElement>("#memory-slot-decisions")!.click();
    });
    await settle();

    const lastCall = fake.memoryContextPreview.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      include: ["prompt", "acceptance", "decisions"],
    });
    const preview = byTestId("memory-context-preview");
    expect(preview.textContent).toContain("200 bytes");
    expect(preview.textContent).toContain("2 redaction(s)");
    expect(preview.textContent).toContain(
      "The engine assembles the provider request; Mona cannot show it.",
    );
  });

  it("previews a handoff and imports it without starting work", async () => {
    const fake = installBridge();
    renderScreen();
    await settle();
    await clickTab("Handoff & diagnostics");

    const preview = byTestId("memory-handoff-preview").textContent ?? "";
    expect(preview).toContain("3 tasks");
    expect(preview).toContain("A handoff never carries credentials.");

    act(() => buttonWith("Inspect bundle").click());
    await settle();
    expect(fake.chooseHandoff).toHaveBeenCalledTimes(1);
    expect(fake.inspectHandoff).toHaveBeenCalledWith(BUNDLE_PATH);
    const inspection = byTestId("memory-handoff-inspection").textContent ?? "";
    expect(inspection).toContain("Cannot transfer");
    expect(inspection).toContain("Engine session ids");

    const importButton = byTestId("memory-handoff-import") as HTMLButtonElement;
    act(() => importButton.click());
    await settle();

    expect(fake.importHandoff).toHaveBeenCalledTimes(1);
    expect(fake.importHandoff.mock.calls[0]?.[0]).toMatchObject({
      path: BUNDLE_PATH,
      mode: "create",
    });
    expect(container!.textContent).toContain(
      "Import created records only. No task was started and no engine was contacted.",
    );
  });

  it("renders the diagnostics preview with redactions and exclusions", async () => {
    const fake = installBridge();
    renderScreen();
    await settle();
    await clickTab("Handoff & diagnostics");

    expect(fake.diagnosticsPreview).toHaveBeenCalledTimes(1);
    const diagnostics = byTestId("memory-diagnostics-preview").textContent ?? "";
    expect(diagnostics).toContain("7 redaction(s)");
    expect(diagnostics).toContain("Environment variables are never captured.");
    expect(diagnostics).toContain("128 bytes");
  });

  it("exposes every documented test id on the tab that owns it", async () => {
    installBridge();
    renderScreen();
    await settle();

    expect(byTestId("memory-search-input")).not.toBeNull();
    expect(byTestId("memory-search-submit")).not.toBeNull();
    expect(byTestId("memory-results")).not.toBeNull();
    expect(byTestId("memory-index")).not.toBeNull();
    await submitSearch("alpha");
    expect(allByTestId("memory-hit")).toHaveLength(1);

    await clickTab("Prompt shelf");
    expect(byTestId("memory-shelf-list")).not.toBeNull();
    expect(byTestId("memory-shelf-detail")).not.toBeNull();
    expect(byTestId("memory-shelf-save")).not.toBeNull();
    expect(allByTestId("memory-variable-input").length).toBeGreaterThan(0);
    act(() => buttonWith("Preview").click());
    await settle();
    expect(byTestId("memory-prompt-preview")).not.toBeNull();

    await clickTab("Resume & context");
    expect(byTestId("memory-resume")).not.toBeNull();
    expect(byTestId("memory-resume-text")).not.toBeNull();
    await selectTask();
    expect(byTestId("memory-context-slots")).not.toBeNull();
    expect(byTestId("memory-context-preview")).not.toBeNull();

    await clickTab("Handoff & diagnostics");
    expect(byTestId("memory-handoff-preview")).not.toBeNull();
    expect(byTestId("memory-handoff-inspection")).not.toBeNull();
    expect(byTestId("memory-handoff-import")).not.toBeNull();
    expect(byTestId("memory-settings-preview")).not.toBeNull();
    expect(byTestId("memory-diagnostics-preview")).not.toBeNull();
  });
});
