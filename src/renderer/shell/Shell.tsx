import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from "react";
import type { AppInfo, AppPathInfo, ToolDiscovery } from "../../shared/contracts/bridge";
import type { ProjectId } from "../../shared/contracts/ids";
import type { StudioActionResult, StudioMode, StudioSnapshot } from "../../shared/contracts/studio";
import type {
  IpcResult,
  ProjectDetail,
  ProjectSummary,
  RuntimeStatusView,
  StateFacts,
} from "../../shared/contracts/project-bridge";
import type { OpenResult } from "../../shared/contracts/open";
import { selectDroppedPath } from "./drop";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  KeyCap,
  Notification,
  TextField,
  VisuallyHidden,
} from "../design/primitives";
import {
  BoardIcon,
  CostIcon,
  FolderIcon,
  HomeIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  WarningIcon,
} from "../design/icons";
import {
  applyDensity,
  applyReducedMotion,
  applyTheme,
  type Density,
  type ThemeName,
} from "../design/tokens";
import { HomeScreen } from "./Home";
import { StudioScreen } from "./Studio";
import { BoardScreen } from "./Board";
import { CostScreen } from "./Cost";
import { SettingsScreen } from "./Settings";
import type { ScreenId } from "./types";
import { projectMonogram, projectAccent } from "./visual";

const SCREENS: Array<{ id: ScreenId; label: string; icon: JSX.Element }> = [
  { id: "home", label: "Home", icon: <HomeIcon size={17} /> },
  { id: "studio", label: "Studio", icon: <SparkIcon size={17} /> },
  { id: "board", label: "Work board", icon: <BoardIcon size={17} /> },
  { id: "cost", label: "Cost lens", icon: <CostIcon size={17} /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon size={17} /> },
];

const SCREEN_IDS = SCREENS.map((screen) => screen.id);

function isScreen(value: unknown): value is ScreenId {
  return typeof value === "string" && (SCREEN_IDS as string[]).includes(value);
}

type DraftStatus = "idle" | "saving" | "saved" | "error";

type DialogState =
  | { kind: "rename"; project: ProjectSummary; name: string }
  | { kind: "remove"; project: ProjectSummary }
  | null;

interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  icon: JSX.Element;
  run: () => void;
}

export function Shell(): JSX.Element {
  const [catalog, setCatalog] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatusView | null>(null);
  const [facts, setFacts] = useState<StateFacts | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [paths, setPaths] = useState<AppPathInfo | null>(null);
  const [tools, setTools] = useState<ToolDiscovery[]>([]);
  const [screen, setScreen] = useState<ScreenId>("home");
  const [inspectorTab, setInspectorTab] = useState("task");
  const [theme, setTheme] = useState<ThemeName>(() => {
    const stored = localStorage.getItem("mona.theme");
    return stored === "afterglow" ? "afterglow" : "daybreak";
  });
  const [density, setDensity] = useState<Density>(() => {
    const stored = localStorage.getItem("mona.density");
    return stored === "dense" ? "dense" : "comfortable";
  });
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [draft, setDraft] = useState("");
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("idle");
  const [studio, setStudio] = useState<StudioSnapshot | null>(null);
  const [studioMode, setStudioMode] = useState<StudioMode>("work");
  const [studioBusy, setStudioBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const queryRef = useRef(query);
  const archivedRef = useRef(showArchived);
  const selectedRef = useRef<ProjectDetail | null>(null);
  const draftRef = useRef<{ projectId: ProjectId | null; threadId: string | null; text: string }>({
    projectId: null,
    threadId: null,
    text: "",
  });
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const studioTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFolderRef = useRef<() => void>(() => undefined);

  queryRef.current = query;
  archivedRef.current = showArchived;
  selectedRef.current = selected;

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("mona.theme", theme);
  }, [theme]);
  useEffect(() => {
    applyDensity(density);
    localStorage.setItem("mona.density", density);
  }, [density]);
  useEffect(() => {
    applyReducedMotion(false);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.screen = screen;
  }, [screen]);

  const refreshCatalog = useCallback(async (): Promise<void> => {
    const result = await window.mona.listProjects(
      queryRef.current.trim() || undefined,
      archivedRef.current,
    );
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setCatalog(result.value);
  }, []);

  const persistDraft = useCallback(async (): Promise<void> => {
    const snapshot = { ...draftRef.current };
    if (!snapshot.projectId || !snapshot.threadId) {
      setDraftStatus("idle");
      return;
    }
    const result = await window.mona.saveDraft(
      snapshot.projectId,
      snapshot.threadId,
      snapshot.text,
    );
    if (!result.ok) {
      setDraftStatus("error");
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setDraftStatus("saved");
  }, []);

  const flushDraft = useCallback(async (): Promise<void> => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    await persistDraft();
  }, [persistDraft]);

  const onDraft = useCallback(
    (text: string) => {
      setDraft(text);
      draftRef.current.text = text;
      setDraftStatus("saving");
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        draftTimer.current = null;
        void persistDraft();
      }, 500);
    },
    [persistDraft],
  );

  const selectProject = useCallback(
    async (project: ProjectSummary, target?: ScreenId): Promise<void> => {
      await flushDraft();
      setBusy(true);
      const [result, studioResult] = await Promise.all([
        window.mona.projectDetail(project.id),
        window.mona.studioState(project.id),
      ]);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        setBusy(false);
        return;
      }
      const detail = result.value;
      setSelected(detail);
      setStudio(studioResult.ok ? studioResult.value : null);
      const text = detail.draft?.text ?? "";
      setDraft(text);
      draftRef.current = {
        projectId: detail.project.id,
        threadId: detail.draft?.threadId ?? detail.threads[0]?.id ?? null,
        text,
      };
      setDraftStatus(text ? "saved" : "idle");
      const view = detail.view as {
        screen?: unknown;
        inspectorTab?: unknown;
        studioMode?: unknown;
      } | null;
      setInspectorTab(typeof view?.inspectorTab === "string" ? view.inspectorTab : "task");
      setStudioMode(view?.studioMode === "plan" ? "plan" : "work");
      setScreen(target ?? (isScreen(view?.screen) ? view.screen : "studio"));
      localStorage.setItem("mona.lastProject", detail.project.id);
      setError(null);
      setBusy(false);
    },
    [flushDraft],
  );

  const refreshSelected = useCallback(async (): Promise<void> => {
    const current = selectedRef.current;
    if (!current) return;
    const [detailResult, studioResult] = await Promise.all([
      window.mona.projectDetail(current.project.id),
      window.mona.studioState(current.project.id),
    ]);
    if (detailResult.ok && selectedRef.current?.project.id === current.project.id) {
      setSelected(detailResult.value);
    }
    if (studioResult.ok) setStudio(studioResult.value);
  }, []);

  /**
   * A Finder handoff opens the project and puts the cursor in the composer.
   * It does not start the engine and it does not submit anything.
   */
  const focusComposer = useCallback((): void => {
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      composer?.focus();
    });
  }, []);

  const handleOpenResult = useCallback(
    async (result: OpenResult): Promise<void> => {
      if (!result.ok) {
        setError(
          `${result.code ?? "OPEN_FAILED"}: ${result.message ?? "Mona could not open that folder."}`,
        );
        return;
      }
      setNotice(
        result.created
          ? `Added “${result.projectName ?? "project"}” to the catalog. Runtime not started.`
          : `Opened “${result.projectName ?? "project"}”. Runtime not started.`,
      );
      const list = await window.mona.listProjects(undefined, true);
      if (list.ok) {
        setCatalog(list.value);
        const project = list.value.find((entry) => entry.id === result.projectId);
        if (project) {
          await selectProject(project, "studio");
          focusComposer();
        }
      }
    },
    [focusComposer, selectProject],
  );

  const boot = useCallback(async (): Promise<void> => {
    try {
      const [app, appPaths, list, status, stateFacts, discovered] = await Promise.all([
        window.mona.getAppInfo(),
        window.mona.getPaths(),
        window.mona.listProjects(),
        window.mona.runtimeStatus(),
        window.mona.stateFacts(),
        window.mona.discoverTools(["codewhale", "git", "node"]),
      ]);
      setAppInfo(app);
      setPaths(appPaths);
      setRuntime(status);
      setFacts(stateFacts);
      setTools(discovered);
      if (!list.ok) {
        setError(`${list.error.code}: ${list.error.message}`);
        return;
      }
      setCatalog(list.value);
      const last = localStorage.getItem("mona.lastProject");
      const target = list.value.find((project) => project.id === last) ?? list.value[0];
      if (target) await selectProject(target, "home");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      document.body.dataset.ready = "true";
    }
  }, [selectProject]);

  useEffect(() => {
    void boot();
    const off = window.mona.onProjectsChanged((projectId) => {
      void (async () => {
        const result = await window.mona.listProjects(undefined, true);
        if (result.ok) {
          setCatalog(result.value);
          const target = projectId
            ? result.value.find((project) => project.id === projectId)
            : undefined;
          if (target) {
            await selectProject(target, "studio");
            focusComposer();
          }
        }
      })();
    });
    const offOpen = window.mona.onOpenResult((result) => {
      // Drops and the native dialog are answered by the caller that started
      // them; a Service handoff, second launch, or open-file event is announced
      // here. The catalog refresh and selection arrive on `projects:changed`.
      if (result.source === "drop" || result.source === "dialog") return;
      if (!result.ok) {
        setError(
          `${result.code ?? "OPEN_FAILED"}: ${result.message ?? "Mona could not open that folder."}`,
        );
        return;
      }
      setNotice(
        result.created
          ? `Added “${result.projectName ?? "project"}” from Finder. Runtime not started.`
          : `Opened “${result.projectName ?? "project"}” from Finder. Runtime not started.`,
      );
    });
    const offStudio = window.mona.onStudioChanged((push) => {
      const current = selectedRef.current?.project.id;
      if (!current || push.projectId !== current) return;
      if (push.kind !== "event" && studioTimer.current) {
        clearTimeout(studioTimer.current);
        studioTimer.current = null;
      }
      if (studioTimer.current) return;
      studioTimer.current = setTimeout(
        () => {
          studioTimer.current = null;
          void refreshSelected();
        },
        push.kind === "event" ? 400 : 40,
      );
    });
    return () => {
      off();
      offOpen();
      offStudio();
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (studioTimer.current) clearTimeout(studioTimer.current);
    };
  }, [boot, focusComposer, refreshCatalog, refreshSelected, selectProject]);

  useEffect(() => {
    if (!selected) return;
    const timer = setTimeout(() => {
      void window.mona.saveProjectView(selected.project.id, { screen, inspectorTab, studioMode });
    }, 300);
    return () => clearTimeout(timer);
  }, [screen, inspectorTab, selected, studioMode]);

  const openFolder = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await window.mona.openProject();
    setBusy(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    if (!result.value) {
      setNotice("Folder selection canceled.");
      return;
    }
    setNotice(
      result.value.created ? "Project added to the catalog." : "Project opened from the catalog.",
    );
    await refreshCatalog();
    await selectProject(result.value.project, "studio");
  }, [refreshCatalog, selectProject]);
  openFolderRef.current = () => void openFolder();

  const onDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>): Promise<void> => {
      event.preventDefault();
      setDropActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      const selection = selectDroppedPath(files, (file) =>
        window.mona.pathForDroppedFile(file as File),
      );
      if (!selection.path) {
        if (selection.error) setError(selection.error);
        return;
      }
      setBusy(true);
      const result = await window.mona.openDroppedFolder(selection.path);
      setBusy(false);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      await handleOpenResult(result.value.result);
    },
    [handleOpenResult],
  );

  const performProjectAction = useCallback(
    async (
      work: () => Promise<IpcResult<ProjectSummary>>,
      options: { success?: string; refreshDetail?: boolean } = {},
    ): Promise<void> => {
      setBusy(true);
      setError(null);
      const result = await work();
      setBusy(false);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      if (options.success) setNotice(options.success);
      await refreshCatalog();
      if (options.refreshDetail && selectedRef.current?.project.id === result.value.id) {
        await selectProject(result.value);
      }
    },
    [refreshCatalog, selectProject],
  );

  const togglePin = useCallback(
    (project: ProjectSummary) => {
      void performProjectAction(
        () => window.mona.setProjectPinned(project.id, !project.pinned, project.revision),
        { success: project.pinned ? "Project unpinned." : "Project pinned.", refreshDetail: true },
      );
    },
    [performProjectAction],
  );

  const toggleArchive = useCallback(
    (project: ProjectSummary) => {
      void performProjectAction(
        () => window.mona.setProjectArchived(project.id, !project.archived, project.revision),
        {
          success: project.archived
            ? "Project restored from archive."
            : "Project archived; source untouched.",
        },
      );
    },
    [performProjectAction],
  );

  const relocate = useCallback(
    async (project: ProjectSummary): Promise<void> => {
      setBusy(true);
      setError(null);
      const result = await window.mona.relocateProject(project.id, project.revision);
      setBusy(false);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      if (!result.value) {
        setNotice("Relocation canceled.");
        return;
      }
      setNotice("Project rebound to the new folder.");
      await refreshCatalog();
      await selectProject(result.value);
    },
    [refreshCatalog, selectProject],
  );

  const reveal = useCallback((project: ProjectSummary) => {
    void window.mona.revealProject(project.id).then((result) => {
      if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
      else setNotice("Revealed in Finder.");
    });
  }, []);

  const submitRename = useCallback(async (): Promise<void> => {
    if (!dialog || dialog.kind !== "rename") return;
    const name = dialog.name.trim();
    if (!name) return;
    setDialog(null);
    await performProjectAction(
      () => window.mona.renameProject(dialog.project.id, name, dialog.project.revision),
      { success: "Project label renamed.", refreshDetail: true },
    );
  }, [dialog, performProjectAction]);

  const submitRemove = useCallback(async (): Promise<void> => {
    if (!dialog || dialog.kind !== "remove") return;
    const project = dialog.project;
    setDialog(null);
    setBusy(true);
    const result = await window.mona.removeProject(project.id, project.revision);
    setBusy(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    if (selectedRef.current?.project.id === project.id) {
      setSelected(null);
      setDraft("");
      draftRef.current = { projectId: null, threadId: null, text: "" };
      setScreen("home");
    }
    setNotice("Removed from the catalog. The source folder was not touched.");
    await refreshCatalog();
  }, [dialog, refreshCatalog]);

  const startStudio = useCallback(async (): Promise<void> => {
    const project = selectedRef.current?.project.id;
    if (!project) return;
    setStudioBusy(true);
    const result = await window.mona.startStudio(project);
    setStudioBusy(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setStudio(result.value);
    setNotice(
      result.value.connection.state === "connected"
        ? "Owned runtime connected to this workspace."
        : result.value.connection.reason,
    );
    await refreshSelected();
  }, [refreshSelected]);

  const submitTask = useCallback(async (): Promise<void> => {
    const current = selectedRef.current;
    if (!current) return;
    const prompt = draftRef.current.text;
    if (prompt.trim().length === 0) {
      setError("A task prompt must not be empty.");
      return;
    }
    await flushDraft();
    setStudioBusy(true);
    const result = await window.mona.submitTask(current.project.id, prompt, studioMode);
    setStudioBusy(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setStudio(result.value.snapshot);
    if (result.value.outcome === "accepted") {
      setDraft("");
      draftRef.current = { ...draftRef.current, text: "" };
      const threadId = draftRef.current.threadId ?? current.threads[0]?.id;
      if (threadId) await window.mona.saveDraft(current.project.id, threadId, "");
      setDraftStatus("idle");
      setNotice(`Turn accepted${result.value.turnId ? `: ${result.value.turnId}` : ""}.`);
    } else if (result.value.outcome === "outcome_unknown") {
      setNotice(result.value.guidance ?? "Outcome unknown: reconcile the lookup before resending.");
    } else {
      setNotice(result.value.note ?? "The runtime did not accept the turn.");
    }
    await refreshSelected();
  }, [flushDraft, refreshSelected, studioMode]);

  const runStudioAction = useCallback(
    async (
      action: (projectId: ProjectId) => Promise<IpcResult<StudioActionResult>>,
    ): Promise<void> => {
      const project = selectedRef.current?.project.id;
      if (!project) return;
      setStudioBusy(true);
      const result = await action(project);
      setStudioBusy(false);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      setStudio(result.value.snapshot);
      setNotice(result.value.note);
      await refreshSelected();
    },
    [refreshSelected],
  );

  const reconcileStudio = useCallback(async (): Promise<void> => {
    const project = selectedRef.current?.project.id;
    if (!project) return;
    setStudioBusy(true);
    const result = await window.mona.reconcileSubmission(project);
    setStudioBusy(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setStudio(result.value.snapshot);
    setNotice(
      `Reconciliation: ${result.value.status}${
        result.value.guidance ? ` · ${result.value.guidance}` : ""
      }`,
    );
    await refreshSelected();
  }, [refreshSelected]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = SCREENS.map((entry) => ({
      id: `screen-${entry.id}`,
      label: `Go to ${entry.label}`,
      hint: "Screen",
      icon: entry.icon,
      run: () => setScreen(entry.id),
    }));
    actions.push({
      id: "open-folder",
      label: "Open or import folder…",
      hint: "Project",
      icon: <FolderIcon size={16} />,
      run: () => void openFolder(),
    });
    if (selectedRef.current) {
      actions.push({
        id: "reveal",
        label: `Reveal ${selectedRef.current.project.name} in Finder`,
        hint: "Project",
        icon: <SearchIcon size={16} />,
        run: () => reveal(selectedRef.current!.project),
      });
    }
    for (const project of catalog) {
      actions.push({
        id: `project-${project.id}`,
        label: `Open ${project.name}`,
        hint: project.rootPath,
        icon: (
          <span className={`monogram monogram--${projectAccent(project)} monogram--tiny`}>
            {projectMonogram(project)}
          </span>
        ),
        run: () => void selectProject(project, "studio"),
      });
    }
    return actions;
  }, [catalog, openFolder, reveal, selectProject]);

  const filteredActions = useMemo(() => {
    const needle = paletteQuery.trim().toLowerCase();
    if (!needle) return paletteActions.slice(0, 12);
    return paletteActions
      .filter(
        (action) =>
          action.label.toLowerCase().includes(needle) || action.hint.toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }, [paletteActions, paletteQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        setPaletteQuery("");
        return;
      }
      if (event.metaKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        openFolderRef.current();
        return;
      }
      if (!typing && event.metaKey && !event.shiftKey && /^[1-5]$/.test(event.key)) {
        const next = SCREEN_IDS[Number(event.key) - 1];
        if (next) {
          event.preventDefault();
          setScreen(next);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeScreen = SCREENS.find((entry) => entry.id === screen) ?? SCREENS[0];
  const engineState = selected?.engine ?? null;

  return (
    <div
      className={`harness shell ${dropActive ? "shell--drop-active" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => void onDrop(event)}
    >
      {dropActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <span className="drop-overlay__label">Drop a folder to open it in Mona</span>
          <span className="drop-overlay__hint">
            One folder at a time · opening never starts the engine or submits a task
          </span>
        </div>
      ) : null}
      <a className="skip-link" href="#screen-main">
        Skip to content
      </a>
      <div className="titlebar" aria-hidden="true">
        <span className="titlebar__title">Mona</span>
      </div>

      <aside className="rail" aria-label="Primary">
        <div className="rail__brand">
          <span className="brand-mark" aria-hidden="true">
            ◐
          </span>
          <span className="brand-name">Mona</span>
        </div>

        <nav className="rail__nav" aria-label="Screens">
          {SCREENS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-nav
              className={`rail__item ${entry.id === screen ? "rail__item--current" : ""}`}
              aria-current={entry.id === screen ? "page" : undefined}
              aria-label={entry.label}
              title={entry.label}
              onClick={() => setScreen(entry.id)}
            >
              <span className="rail__icon" aria-hidden="true">
                {entry.icon}
              </span>
              <span className="rail__label">{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="rail__group" aria-label="Projects">
          <p className="rail__group-title">Projects</p>
          {catalog.length === 0 ? (
            <p className="rail__hint">No projects yet</p>
          ) : (
            catalog.slice(0, 6).map((project) => (
              <button
                key={project.id}
                type="button"
                className={`rail__project ${selected?.project.id === project.id ? "rail__project--current" : ""}`}
                onClick={() => void selectProject(project)}
                title={project.rootPath}
              >
                <span
                  className={`monogram monogram--${projectAccent(project)} monogram--tiny`}
                  aria-hidden="true"
                >
                  {projectMonogram(project)}
                </span>
                <span className="rail__project-name">{project.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="rail__footer">
          <span
            className={`status-dot ${selected?.engine.canExecute ? "status-dot--success" : "status-dot--attention"}`}
            aria-hidden="true"
          />
          <div>
            <p className="rail__footer-line">
              {selected
                ? selected.engine.canExecute
                  ? "Engine connected"
                  : "Engine disconnected"
                : "No project selected"}
            </p>
            <p className="rail__footer-line rail__footer-line--muted" data-testid="app-version">
              Mona {appInfo?.version ?? "0.1.0-p02"}
            </p>
          </div>
        </div>
      </aside>

      <main className="harness__main shell__main" id="screen-main" tabIndex={-1}>
        <div className="shell-topbar">
          <div className="shell-topbar__crumb">
            <span className="eyebrow">Workspace</span>
            <span className="shell-topbar__screen">{activeScreen?.label}</span>
            {selected ? <Badge tone="neutral">{selected.project.name}</Badge> : null}
          </div>
          <div className="shell-topbar__actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshIcon size={14} />}
              onClick={() => void refreshCatalog()}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<SearchIcon size={14} />}
              onClick={() => setPaletteOpen(true)}
            >
              Palette <KeyCap>⌘K</KeyCap>
            </Button>
          </div>
        </div>

        {error ? (
          <Callout
            tone="danger"
            title="Action could not be completed"
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
          <Notification tone="success" title={notice} onDismiss={() => setNotice(null)} />
        ) : null}

        <VisuallyHidden>
          <p aria-live="polite">Screen: {activeScreen?.label}</p>
        </VisuallyHidden>

        {screen === "home" ? (
          <HomeScreen
            catalog={catalog}
            selectedId={selected?.project.id ?? null}
            query={query}
            showArchived={showArchived}
            busy={busy}
            onQuery={(value) => {
              setQuery(value);
              void window.mona
                .listProjects(value.trim() || undefined, showArchived)
                .then((result) => {
                  if (result.ok) setCatalog(result.value);
                  else setError(`${result.error.code}: ${result.error.message}`);
                });
            }}
            onToggleArchived={() => {
              const next = !showArchived;
              setShowArchived(next);
              void window.mona.listProjects(query.trim() || undefined, next).then((result) => {
                if (result.ok) setCatalog(result.value);
              });
            }}
            onOpenFolder={() => void openFolder()}
            onSelect={(project) => void selectProject(project, "studio")}
            onRename={(project) => setDialog({ kind: "rename", project, name: project.name })}
            onPin={togglePin}
            onArchive={toggleArchive}
            onRemove={(project) => setDialog({ kind: "remove", project })}
            onRelocate={(project) => void relocate(project)}
            onReveal={reveal}
          />
        ) : null}
        {screen === "studio" ? (
          <StudioScreen
            detail={selected}
            studio={studio}
            studioBusy={studioBusy}
            mode={studioMode}
            draft={draft}
            draftStatus={draftStatus}
            inspectorTab={inspectorTab}
            onInspectorTab={setInspectorTab}
            onDraft={onDraft}
            onMode={setStudioMode}
            onOpenFolder={() => void openFolder()}
            onShowBoard={() => setScreen("board")}
            onStart={() => void startStudio()}
            onSubmit={() => void submitTask()}
            onInterrupt={() => void runStudioAction((id) => window.mona.interruptNow(id))}
            onPause={() => void runStudioAction((id) => window.mona.pauseAfterTask(id))}
            onResumeQueue={() => void runStudioAction((id) => window.mona.resumeQueue(id))}
            onCancelQueued={() => void runStudioAction((id) => window.mona.cancelQueued(id))}
            onStop={() => void runStudioAction((id) => window.mona.stopStudio(id))}
            onReconcile={() => void reconcileStudio()}
          />
        ) : null}
        {screen === "board" ? (
          <BoardScreen
            detail={selected}
            onOpenFolder={() => void openFolder()}
            onShowStudio={() => setScreen("studio")}
          />
        ) : null}
        {screen === "cost" ? (
          <CostScreen detail={selected} onOpenFolder={() => void openFolder()} />
        ) : null}
        {screen === "settings" ? (
          <SettingsScreen
            app={appInfo}
            paths={paths}
            facts={facts}
            runtime={runtime}
            detail={selected}
            tools={tools}
            theme={theme}
            density={density}
            onTheme={setTheme}
            onDensity={setDensity}
          />
        ) : null}

        <footer className="harness__footer">
          <FolderIcon size={14} /> {catalog.length} local project{catalog.length === 1 ? "" : "s"} ·{" "}
          {engineState?.blockedReason
            ? "Execution unavailable"
            : engineState
              ? "Execution ready"
              : "No project selected"}{" "}
          · zero inference in navigation
        </footer>
      </main>

      <Dialog
        open={paletteOpen}
        title="Command palette"
        description="Local navigation over real projects and screens. No model call is made."
        onClose={() => setPaletteOpen(false)}
      >
        <div className="palette">
          <label className="field__label" htmlFor="shell-palette-filter">
            Search projects and actions
          </label>
          <input
            id="shell-palette-filter"
            className="input"
            value={paletteQuery}
            onChange={(event) => setPaletteQuery(event.target.value)}
            placeholder="Project, screen, or action…"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                const first = document.querySelector<HTMLButtonElement>(".palette__item");
                first?.focus();
              } else if (event.key === "Enter" && filteredActions[0]) {
                event.preventDefault();
                filteredActions[0].run();
                setPaletteOpen(false);
              }
            }}
          />
          <ul className="palette__list">
            {filteredActions.map((action) => (
              <li key={action.id}>
                <button
                  type="button"
                  className="palette__item"
                  onClick={() => {
                    action.run();
                    setPaletteOpen(false);
                  }}
                >
                  <span className="palette__icon" aria-hidden="true">
                    {action.icon}
                  </span>
                  <span className="palette__label">{action.label}</span>
                  <span className="palette__hint">{action.hint}</span>
                </button>
              </li>
            ))}
            {filteredActions.length === 0 ? (
              <li className="palette__empty">No matching action.</li>
            ) : null}
          </ul>
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === "rename"}
        title="Rename project label"
        description="The label is local to Mona. The folder name and its contents are unchanged."
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submitRename()}
              disabled={!dialog || dialog.kind !== "rename" || !dialog.name.trim()}
            >
              Rename
            </Button>
          </>
        }
      >
        {dialog?.kind === "rename" ? (
          <TextField
            label="Project label"
            value={dialog.name}
            maxLength={200}
            autoFocus
            onChange={(event) =>
              setDialog({ kind: "rename", project: dialog.project, name: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitRename();
            }}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={dialog?.kind === "remove"}
        title="Remove from the project catalog?"
        description="This removes Mona's catalog entry only. The source folder and its files are not deleted."
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void submitRemove()}>
              Remove entry
            </Button>
          </>
        }
      >
        {dialog?.kind === "remove" ? (
          <div className="remove-summary">
            <p className="remove-summary__name">{dialog.project.name}</p>
            <p className="mono wrap">{dialog.project.rootPath}</p>
            <p className="hint-line">
              <WarningIcon size={14} /> Archive is the reversible option; removal frees the path for
              a fresh catalog entry.
            </p>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
