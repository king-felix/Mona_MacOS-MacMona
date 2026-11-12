import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveFolderRequest, type FolderProbe, type FolderRequest } from "./folder-request";
import type { FolderRequestSource, OpenResult } from "../../shared/contracts/open";

/**
 * The single dispatch path for externally supplied folders.
 *
 * Structure, not discipline, enforces the product promise: this class has no
 * supervisor, no adapter, and no task API. Opening a project from Finder (or a
 * Dock drop, a second launch, or the open dialog) can register and select a
 * project; it cannot start a runtime, submit a prompt, or resume a turn,
 * because nothing in this module can reach those operations.
 */

export interface OpenedProject {
  project: { id: string; name: string; canonicalPath: string; rootPath: string };
  created: boolean;
}

export interface OpenProjectPort {
  open(rootPath: string): Promise<OpenedProject | null>;
}

export interface OpenCoordinatorOptions {
  projects: OpenProjectPort;
  /** Bounded diagnostic journal; failures are noted, never fatal. */
  journalPath: string | null;
  probe?: FolderProbe;
  now?: () => Date;
  onResult?: (result: OpenResult) => void;
}

export class OpenCoordinator {
  private readonly inFlight = new Map<string, Promise<OpenResult>>();
  private last: OpenResult | null = null;

  constructor(private readonly options: OpenCoordinatorOptions) {}

  lastResult(): OpenResult | null {
    return this.last;
  }

  /** Validate, then register/select. Idempotent per canonical folder. */
  async open(input: string, source: FolderRequestSource): Promise<OpenResult> {
    const resolution = resolveFolderRequest(input, source, {
      probe: this.options.probe,
      now: this.options.now,
    });

    if (!resolution.ok) {
      return this.finish({
        ok: false,
        source,
        input: resolution.input,
        path: null,
        projectId: null,
        projectName: null,
        created: false,
        code: resolution.code,
        message: resolution.message,
        notes: [],
        at: (this.options.now?.() ?? new Date()).toISOString(),
        runtimeStarted: false,
        taskCreated: false,
      });
    }

    const request = resolution.request;
    const existing = this.inFlight.get(request.path);
    if (existing) {
      const result = await existing;
      return {
        ...result,
        notes: [...result.notes, "deduplicated: the same folder was already opening"],
      };
    }

    const work = this.register(request);
    this.inFlight.set(request.path, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(request.path);
    }
  }

  private async register(request: FolderRequest): Promise<OpenResult> {
    const opened = await this.options.projects.open(request.path);
    if (!opened) {
      return this.finish({
        ok: false,
        source: request.source,
        input: request.input,
        path: request.path,
        projectId: null,
        projectName: null,
        created: false,
        code: "OPEN_FAILED",
        message: "The folder was valid, but Mona could not add it to the catalog.",
        notes: request.notes,
        at: (this.options.now?.() ?? new Date()).toISOString(),
        runtimeStarted: false,
        taskCreated: false,
      });
    }
    return this.finish({
      ok: true,
      source: request.source,
      input: request.input,
      path: request.path,
      projectId: opened.project.id,
      projectName: opened.project.name,
      created: opened.created,
      code: null,
      message: null,
      notes: request.notes,
      at: (this.options.now?.() ?? new Date()).toISOString(),
      runtimeStarted: false,
      taskCreated: false,
    });
  }

  private finish(result: OpenResult): OpenResult {
    this.last = result;
    if (this.options.journalPath) {
      try {
        const path = this.options.journalPath;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        renameSync(temporary, path);
      } catch (error) {
        result.notes = [
          ...result.notes,
          `journal: could not record the handoff (${String(error)})`,
        ];
      }
    }
    try {
      this.options.onResult?.(result);
    } catch {
      // Reporting must never break opening a project.
    }
    return result;
  }
}
