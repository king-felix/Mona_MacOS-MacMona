import type { EngineSnapshot, ProjectSummary } from "../../shared/contracts/project-bridge";
import type { Tone } from "../design/primitives";

const ACCENTS = ["violet", "mint", "coral", "amber", "indigo"] as const;

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

export function projectMonogram(project: ProjectSummary): string {
  if (project.monogram) return project.monogram.slice(0, 2).toUpperCase();
  const words = project.name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "MO";
  if (words.length === 1) return (words[0] ?? "MO").slice(0, 2).toUpperCase();
  return `${(words[0] ?? "M").slice(0, 1)}${(words[1] ?? "O").slice(0, 1)}`.toUpperCase();
}

export function projectAccent(project: ProjectSummary): (typeof ACCENTS)[number] {
  if (project.accent && (ACCENTS as readonly string[]).includes(project.accent)) {
    return project.accent as (typeof ACCENTS)[number];
  }
  return ACCENTS[hash(project.id) % ACCENTS.length] ?? "violet";
}

export function repositoryLabel(project: ProjectSummary): string {
  if (project.repositoryKind === "git_worktree") {
    return project.worktreeName ? `Worktree · ${project.worktreeName}` : "Git worktree";
  }
  if (project.repositoryKind === "git") return "Git repository";
  return "Plain folder";
}

export function engineBadge(engine: EngineSnapshot | null): { label: string; tone: Tone } {
  if (!engine) return { label: "Unknown", tone: "neutral" };
  if (engine.state === "running" && engine.canExecute)
    return { label: "Connected", tone: "success" };
  if (engine.state === "running") return { label: "Other project running", tone: "attention" };
  if (engine.state === "starting") return { label: "Starting", tone: "attention" };
  if (engine.state === "reconnecting") return { label: "Reconnecting", tone: "attention" };
  if (engine.state === "failed") return { label: "Failed", tone: "danger" };
  if (engine.state === "stopping") return { label: "Stopping", tone: "attention" };
  return { label: "Disconnected", tone: "neutral" };
}

export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "Unknown";
  const delta = Math.max(0, now - time);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "Just now";
  if (delta < hour) return `${Math.floor(delta / minute)} min ago`;
  if (delta < day) return `${Math.floor(delta / hour)} h ago`;
  if (delta < 30 * day) return `${Math.floor(delta / day)} d ago`;
  return new Date(time).toLocaleDateString();
}

export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}
