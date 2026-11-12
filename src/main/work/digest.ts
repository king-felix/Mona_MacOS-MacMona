import type { ProjectId, TaskId } from "../../shared/contracts/ids";
import type { BoardSnapshot, TaskView } from "../../shared/contracts/board";
import type {
  DigestEntryView,
  DigestGroupId,
  DigestGroupView,
  PolishDigestView,
  ResumeBlockerView,
  ResumeBriefView,
  ResumeChangeSummaryView,
  ResumeSpendView,
  ResumeTestResultView,
  SinceYouLeftView,
} from "../../shared/contracts/polish";
import type { ChangesSnapshot } from "../../shared/contracts/changes";
import type { CostLedgerView } from "../../shared/contracts/cost";
import type { StoredEvent, StateStore } from "../state/store";
import type { TaskBoard } from "./board";
import type { ChangeLedger } from "./changes";
import type { CostLedger } from "./costs";

const EVENT_WINDOW = 500;
const CHANGE_SETS = 10;
const MAX_ENTRIES_PER_GROUP = 20;
const MAX_DETAIL = 240;

const TEST_COMMAND =
  /(?:^|[\s;&|(])((?:npm\s+(?:run\s+)?test|node\s+--test|vitest|pytest|jest|swift\s+test|xcodebuild\s+test|go\s+test|cargo\s+test)\b[^\n]{0,120})/i;

const TEST_TOOL_KINDS = new Set(["tool_call", "command_execution", "file_change", "web_search"]);

function seenScope(projectId: ProjectId): string {
  return `polish:seen:${projectId}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function clamp(value: string, max = MAX_DETAIL): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function after(at: string | null, since: string | null): boolean {
  if (!at || !since) return false;
  const value = Date.parse(at);
  const mark = Date.parse(since);
  if (Number.isNaN(value) || Number.isNaN(mark)) return false;
  return value > mark;
}

interface Context {
  projectName: string;
  board: BoardSnapshot;
  changes: ChangesSnapshot | null;
  changesError: string | null;
  cost: CostLedgerView | null;
  costError: string | null;
  events: StoredEvent[];
  seenAt: string | null;
}

export interface DigestOptions {
  store: StateStore;
  board: TaskBoard;
  /** Optional so a test can omit receipts; the brief then says they are unavailable. */
  changes?: ChangeLedger | null;
  cost?: CostLedger | null;
  now?: () => Date;
}

/**
 * The Resume Brief and "Since you left" are deterministic projections of stored
 * records. There is no summarizer, no hidden model call, and no completion
 * percentage: a claim appears only when a task, receipt, or usage record says
 * it. Both surfaces are safe to read on every navigation.
 */
export class PolishDigest {
  private readonly store: StateStore;
  private readonly board: TaskBoard;
  private readonly changes: ChangeLedger | null;
  private readonly cost: CostLedger | null;
  private readonly now: () => Date;

  constructor(options: DigestOptions) {
    this.store = options.store;
    this.board = options.board;
    this.changes = options.changes ?? null;
    this.cost = options.cost ?? null;
    this.now = options.now ?? (() => new Date());
  }

  async digest(projectId: ProjectId): Promise<PolishDigestView> {
    const context = await this.context(projectId);
    return {
      resume: this.resumeFrom(context),
      sinceYouLeft: this.sinceFrom(context),
    };
  }

  async resume(projectId: ProjectId): Promise<ResumeBriefView> {
    return this.resumeFrom(await this.context(projectId));
  }

  async sinceYouLeft(projectId: ProjectId): Promise<SinceYouLeftView> {
    return this.sinceFrom(await this.context(projectId));
  }

  /**
   * Advance the catch-up watermark. Acknowledging a notification or reading a
   * brief never advances a task, an attempt counter, or a verification state.
   */
  async markSeen(projectId: ProjectId): Promise<{ seenAt: string }> {
    const seenAt = this.now().toISOString();
    await this.store.putSettings(seenScope(projectId), { seenAt });
    return { seenAt };
  }

  private async context(projectId: ProjectId): Promise<Context> {
    const project = await this.store.getProject(projectId, { includeRemoved: true });
    if (!project) {
      throw new Error("project is not in the catalog");
    }
    const board = await this.board.snapshot(projectId);
    let changes: ChangesSnapshot | null = null;
    let changesError: string | null = null;
    if (this.changes) {
      try {
        changes = await this.changes.snapshot(projectId, { limit: CHANGE_SETS });
      } catch (error) {
        changesError = error instanceof Error ? error.message : String(error);
      }
    } else {
      changesError = "the changes ledger is unavailable in this launch";
    }
    let cost: CostLedgerView | null = null;
    let costError: string | null = null;
    if (this.cost) {
      try {
        cost = await this.cost.ledger(projectId, {});
      } catch (error) {
        costError = error instanceof Error ? error.message : String(error);
      }
    } else {
      costError = "the cost ledger is unavailable in this launch";
    }
    const [events, seen] = await Promise.all([
      this.store.readProjectEvents(projectId, EVENT_WINDOW),
      this.store.getSettings(seenScope(projectId)).catch(() => null),
    ]);
    const seenAt =
      seen && typeof seen.value === "object" && seen.value !== null
        ? typeof (seen.value as { seenAt?: unknown }).seenAt === "string"
          ? ((seen.value as { seenAt: string }).seenAt ?? null)
          : null
        : null;
    return {
      projectName: project.name,
      board,
      changes,
      changesError,
      cost,
      costError,
      events,
      seenAt,
    };
  }

  // ------------------------------------------------------------------ resume

  private resumeFrom(context: Context): ResumeBriefView {
    const handoff = context.board.handoff;
    const focus = context.board.tasks.find((task) => task.id === handoff.currentTaskId) ?? null;
    const blockers = handoff.blockedProblems.map((card) => ({
      problemId: card.problemId,
      taskId: card.taskId,
      taskTitle: card.taskTitle,
      requirement: card.requirement,
      helpNeeded: card.helpNeeded,
      totalAttempts: card.totalAttempts,
      noProgressAttempts: card.noProgressAttempts,
      evidence: card.evidence,
      blockedAt: card.blockedAt,
    })) satisfies ResumeBlockerView[];
    const testResult = this.testResult(focus, context.board.tasks, context.events);
    const changes = this.changeSummary(context);
    const spend = this.spendSummary(context);
    const unresolved = blockers[0] ?? null;

    const facts: ResumeBriefView["facts"] = [
      {
        label: "Current prompt",
        value: focus
          ? `${focus.title} · ${focus.status}`
          : context.board.tasks.length === 0
            ? "No task recorded"
            : "No eligible task",
        tone: focus
          ? focus.status === "blocked"
            ? "danger"
            : focus.status === "running"
              ? "success"
              : "neutral"
          : "neutral",
      },
      {
        label: "Test result",
        value: testResult.label,
        // A failed observed command must never render as success just because
        // there are no acceptance checks to compare against.
        tone: !testResult.available
          ? "neutral"
          : testResult.observedCommand?.status === "failed"
            ? "danger"
            : testResult.totalChecks > 0 &&
                testResult.satisfiedChecks === testResult.totalChecks &&
                (testResult.observedCommand === null ||
                  testResult.observedCommand.status === "completed")
              ? "success"
              : "attention",
      },
      {
        label: "Changed files",
        value: changes.label,
        tone: changes.available ? "neutral" : "attention",
      },
      {
        label: "Spend confidence",
        value: spend.label,
        tone: spend.complete ? "neutral" : "attention",
      },
    ];
    if (unresolved) {
      facts.unshift({
        label: "Unresolved blocker",
        value: `${unresolved.requirement} · ${clamp(unresolved.helpNeeded, 120)}`,
        tone: "danger",
      });
    }

    return {
      projectId: context.board.projectId,
      projectName: context.projectName,
      generatedAt: this.now().toISOString(),
      source: {
        lastSeenAt: context.seenAt,
        eventsConsidered: context.events.length,
        tasksConsidered: context.board.tasks.length,
        changeSetsConsidered: context.changes?.sets.length ?? 0,
      },
      currentTask: focus
        ? {
            id: focus.id,
            title: focus.title,
            status: focus.status,
            prompt: focus.prompt,
            nextStep: focus.nextStep,
          }
        : null,
      lastVerifiedStep: handoff.lastVerifiedStep,
      unresolvedBlocker: unresolved,
      blockers,
      testResult,
      changes,
      spend,
      nextStep: handoff.nextExactAction,
      facts,
      noCompletionPercentage: true,
    };
  }

  private testResult(
    focus: TaskView | null,
    tasks: readonly TaskView[],
    events: readonly StoredEvent[],
  ): ResumeTestResultView {
    const scope = focus ? [focus] : tasks;
    const checks = scope.flatMap((task) => task.acceptance.filter((item) => item.kind === "check"));
    const satisfied = checks.filter((item) => item.satisfied);
    const latestEvidence = satisfied
      .filter((item) => typeof item.evidencePath === "string")
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    const observed = this.observedTest(events);
    const totalChecks = checks.length;
    const satisfiedChecks = satisfied.length;

    let label: string;
    if (totalChecks === 0 && !observed) {
      label = "No machine check recorded";
    } else if (totalChecks === 0 && observed) {
      label = `Observed: ${observed.command} (${observed.status})`;
    } else {
      label = `${satisfiedChecks} of ${totalChecks} acceptance checks satisfied`;
      if (satisfiedChecks < totalChecks) label += " · not verified";
      if (observed) label += ` · command ${observed.status}`;
    }

    return {
      available: totalChecks > 0 || observed !== null,
      satisfiedChecks,
      totalChecks,
      label,
      lastEvidencePath: latestEvidence?.evidencePath ?? null,
      lastAt: latestEvidence?.updatedAt ?? null,
      observedCommand: observed,
      note:
        totalChecks === 0
          ? observed
            ? "A test command was observed in stored engine events. Its exit status is not interpreted here; the tool status is shown."
            : "No acceptance check or test command is recorded. Mona does not invent a passing result."
          : "Checks are satisfied only by a recorded action with evidence. A checked box alone is not a test result.",
    };
  }

  private observedTest(
    events: readonly StoredEvent[],
  ): { command: string; status: string; at: string } | null {
    let latest: { command: string; status: string; at: string } | null = null;
    for (const event of events) {
      if (event.kind !== "item.completed" && event.kind !== "item.failed") continue;
      const item = record(record(event.payload)?.item);
      if (!item) continue;
      const kind = firstString(item, ["kind"]);
      if (kind && !TEST_TOOL_KINDS.has(kind)) continue;
      const text = [firstString(item, ["tool_name"]), firstString(item, ["summary"])]
        .filter(Boolean)
        .join(" ");
      const detail = firstString(item, ["detail"]);
      const match = TEST_COMMAND.exec(`${text}\n${detail}`);
      if (!match) continue;
      const command = clamp(match[1] ?? text, 160);
      const status =
        firstString(item, ["status"]) || (event.kind === "item.failed" ? "failed" : "completed");
      const candidate = { command, status, at: event.timestamp };
      if (!latest || Date.parse(candidate.at) >= Date.parse(latest.at)) latest = candidate;
    }
    return latest;
  }

  private changeSummary(context: Context): ResumeChangeSummaryView {
    if (!context.changes) {
      return {
        available: false,
        countedFiles: 0,
        turns: 0,
        unreceiptedPaths: 0,
        truncated: false,
        label: "Changes unavailable",
        note: context.changesError ?? "No change receipts are available in this launch.",
      };
    }
    const snapshot = context.changes;
    const settled = snapshot.sets.filter((set) => set.state === "settled");
    // A turn whose delta the engine could not produce is a missing receipt, not
    // an empty change. Counting only settled sets and then saying "0 files"
    // would rewrite that gap as "nothing changed".
    const missing = snapshot.sets.filter((set) => set.state === "unavailable");
    const pending = snapshot.sets.filter((set) => set.state === "pending");
    const paths = new Set<string>();
    for (const set of settled) {
      for (const file of set.files) {
        if (file.kind === "file") paths.add(file.path);
      }
    }
    const unreceipted = snapshot.git.entries.filter(
      (entry) => entry.attribution === "unreceipted",
    ).length;
    const truncated = settled.some((set) => set.truncated) || snapshot.git.truncated;
    const counted = settled.length > 0;
    // Stored receipts and Git are both evidence even when no live studio can
    // re-read them from the engine; the note distinguishes the two cases. A
    // stored receipt that says "the engine recorded no delta" is still a
    // receipt, so it makes the section available rather than absent.
    const available = counted || snapshot.sets.length > 0 || snapshot.git.available;
    const label = !available
      ? "Changes unavailable"
      : counted
        ? `${paths.size} file${paths.size === 1 ? "" : "s"} in ${settled.length} recorded turn${
            settled.length === 1 ? "" : "s"
          }${missing.length > 0 ? ` · ${missing.length} turn${missing.length === 1 ? "" : "s"} with no recorded delta` : ""}${
            unreceipted > 0 ? ` · ${unreceipted} unreceipted` : ""
          }`
        : missing.length > 0
          ? `${missing.length} turn${missing.length === 1 ? "" : "s"} with no recorded delta`
          : pending.length > 0
            ? "A turn receipt is still pending"
            : "No recorded turn changed files";
    return {
      available,
      countedFiles: paths.size,
      turns: settled.length,
      unreceiptedPaths: unreceipted,
      truncated,
      label,
      note: !available
        ? (snapshot.receipts.reason ?? snapshot.git.reason ?? "No receipt source answered.")
        : missing.length > 0
          ? `${missing.length} stored turn${missing.length === 1 ? "" : "s"} have no workspace delta from the engine. That is a missing receipt, not an empty diff.${
              missing[0]?.reason ? ` The engine said: ${missing[0].reason}.` : ""
            }`
          : !snapshot.receipts.available
            ? (snapshot.receipts.reason ??
              "Stored receipts are shown; connect the studio to re-read them from the engine.")
            : truncated
              ? "The receipt listing is bounded; counts shown are partial."
              : "Counts come from settled engine receipts. Unreceipted paths are dirty Git entries no recorded turn names.",
    };
  }

  private spendSummary(context: Context): ResumeSpendView {
    if (!context.cost) {
      return {
        observed: false,
        knownUsd: 0,
        complete: false,
        label: "Spend unavailable",
        reportedTurns: 0,
        estimatedTurns: 0,
        unknownTurns: 0,
        missingTurns: 0,
      };
    }
    const totals = context.cost.totals;
    const unpriced = totals.unknownTurns + totals.missingTurns + totals.unallocatedTurns;
    const label = !totals.turns
      ? "No usage recorded"
      : totals.costComplete
        ? `$${totals.costUsd.toFixed(4)} reported`
        : `At least $${totals.costUsd.toFixed(4)}; ${unpriced} of ${totals.turns} turns unpriced`;
    return {
      observed: totals.turns > 0,
      knownUsd: totals.costUsd,
      complete: totals.costComplete,
      label,
      reportedTurns: totals.reportedTurns,
      estimatedTurns: totals.estimatedTurns,
      unknownTurns: totals.unknownTurns,
      missingTurns: totals.missingTurns,
    };
  }

  // ----------------------------------------------------------- since you left

  private sinceFrom(context: Context): SinceYouLeftView {
    const since = context.seenAt;
    if (!since) {
      return {
        projectId: context.board.projectId,
        since: null,
        generatedAt: this.now().toISOString(),
        groups: [],
        entryCount: 0,
        duplicatesSuppressed: 0,
        note: "No earlier visit is recorded for this project. The brief shows the current state; nothing is reconstructed as if you had been away.",
      };
    }
    const entries: DigestEntryView[] = [];
    const seen = new Set<string>();
    let duplicates = 0;

    const push = (entry: DigestEntryView): void => {
      if (seen.has(entry.key)) {
        duplicates += 1;
        return;
      }
      seen.add(entry.key);
      entries.push(entry);
    };

    for (const event of context.events) {
      const key = `${event.threadId}:${event.seq}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      if (!after(event.timestamp, since)) continue;
      const payload = record(event.payload);
      const base = {
        key,
        at: event.timestamp,
        taskId: null,
        turnId: typeof event.turnId === "string" ? event.turnId : null,
        changeSetId: null,
        problemId: null,
        evidencePath: null,
      } as const;
      const turnId = typeof payload?.turn_id === "string" ? payload.turn_id : base.turnId;
      const set = context.changes?.sets.find((candidate) => candidate.turnId === turnId) ?? null;
      switch (event.kind) {
        case "turn.completed": {
          push({
            ...base,
            group: "completion",
            title: set
              ? `Turn completed · ${set.files.length} file receipt${set.files.length === 1 ? "" : "s"}`
              : "Turn completed",
            detail: set?.files.length
              ? set.files
                  .slice(0, 3)
                  .map((file) => file.path)
                  .join(", ")
              : null,
            turnId,
            changeSetId: set?.id ?? null,
            taskId: set?.taskId as TaskId | null,
            screen: "changes",
          });
          break;
        }
        case "turn.failed":
          push({
            ...base,
            group: "attention",
            title: "Turn failed",
            detail:
              firstString(payload, ["reason", "error"]) || "The engine reported the turn failed.",
            turnId,
            screen: "studio",
          });
          break;
        case "turn.interrupted":
          push({
            ...base,
            group: "session",
            title: "Turn interrupted",
            detail: firstString(payload, ["reason"]) || null,
            turnId,
            screen: "studio",
          });
          break;
        case "item.completed":
        case "item.failed": {
          const item = record(payload?.item);
          const kind = firstString(item, ["kind"]) || "unknown";
          const status =
            firstString(item, ["status"]) ||
            (event.kind === "item.failed" ? "failed" : "completed");
          const text = [firstString(item, ["tool_name"]), firstString(item, ["summary"])]
            .filter(Boolean)
            .join(" ");
          const detail = firstString(item, ["detail"]) || firstString(item, ["summary"]) || null;
          const isTest = TEST_COMMAND.test(`${text}\n${firstString(item, ["detail"])}`);
          if (
            event.kind === "item.failed" ||
            kind === "agent_message" ||
            kind === "assistant_message" ||
            kind === "user_message"
          ) {
            if (event.kind === "item.failed") {
              push({
                ...base,
                group: "attention",
                title: "Item failed",
                detail: clamp(detail ?? "An engine item failed."),
                turnId,
                screen: "studio",
              });
            }
          } else {
            push({
              ...base,
              group: isTest ? "test" : "session",
              title: isTest
                ? `Test command ${status}`
                : `${(kind || "tool").replace(/_/g, " ")} ${status}`,
              detail: clamp(detail ?? text) || null,
              turnId,
              screen: "studio",
            });
          }
          break;
        }
        case "approval.decided":
        case "user_input.answered":
          push({
            ...base,
            group: "attention",
            title:
              event.kind === "approval.decided" ? "Approval decided" : "Engine question answered",
            detail: firstString(payload, ["decision", "answer", "note"]) || null,
            screen: "studio",
          });
          break;
        default:
          if (event.kind.startsWith("status.") || event.kind.startsWith("thread.")) {
            push({
              ...base,
              group: "session",
              title: event.kind,
              detail: firstString(payload, ["note", "reason", "status", "message"]) || null,
              screen: "studio",
            });
          }
      }
    }

    // Blocked problems are state, not events; they belong to the catch-up view
    // when the block is newer than the watermark.
    for (const card of context.board.handoff.blockedProblems) {
      if (!after(card.blockedAt, since)) continue;
      push({
        key: `blocker:${card.problemId}`,
        group: "blocker",
        title: `Blocked: ${card.taskTitle ?? card.requirement}`,
        detail: clamp(card.helpNeeded),
        at: card.blockedAt ?? since,
        taskId: card.taskId,
        turnId: null,
        changeSetId: null,
        problemId: card.problemId,
        evidencePath: card.evidence[0] ?? null,
        screen: "board",
      });
    }

    // A task verified since the watermark is a real completion even if its
    // turn event was captured before the last visit.
    for (const task of context.board.tasks) {
      if (task.status !== "completed" || !task.completedAt || !after(task.completedAt, since))
        continue;
      const evidence =
        task.acceptance.find((criterion) => criterion.evidencePath)?.evidencePath ?? null;
      push({
        key: `task-completed:${task.id}`,
        group: "completion",
        title: `Verified: ${task.title}`,
        detail: `${task.acceptance.filter((item) => item.satisfied).length} of ${task.acceptance.length} acceptance criteria satisfied`,
        at: task.completedAt,
        taskId: task.id,
        turnId: null,
        changeSetId: null,
        problemId: null,
        evidencePath: evidence,
        screen: "board",
      });
    }
    const order: DigestGroupId[] = [
      "completion",
      "blocker",
      "test",
      "change",
      "attention",
      "session",
    ];
    const titles: Record<DigestGroupId, string> = {
      completion: "Finished",
      blocker: "Needs you",
      test: "Tests observed",
      change: "Files changed",
      attention: "Attention",
      session: "Session",
    };
    let truncated = false;
    const groups: DigestGroupView[] = order.flatMap((id) => {
      const all = entries
        .filter((entry) => entry.group === id)
        .sort((left, right) => {
          const delta = Date.parse(left.at) - Date.parse(right.at);
          return delta !== 0 ? delta : left.key.localeCompare(right.key);
        });
      if (all.length === 0) return [];
      if (all.length > MAX_ENTRIES_PER_GROUP) truncated = true;
      return [
        {
          id,
          title: titles[id],
          entries: all.slice(-MAX_ENTRIES_PER_GROUP),
        },
      ];
    });
    const entryCount = groups.reduce((sum, group) => sum + group.entries.length, 0);
    return {
      projectId: context.board.projectId,
      since,
      generatedAt: this.now().toISOString(),
      groups,
      entryCount,
      duplicatesSuppressed: duplicates,
      note:
        entryCount === 0
          ? "Nothing recorded since your last visit."
          : truncated
            ? `Showing the latest ${MAX_ENTRIES_PER_GROUP} entries per group; older entries remain in the project record.`
            : "Grouped from stored engine events, task transitions, blockers, and receipts. No model summarized this.",
    };
  }
}
