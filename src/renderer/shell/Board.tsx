import type { JSX } from "react";
import type { ProjectDetail } from "../../shared/contracts/project-bridge";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  StatusBadge,
  type WorkStatus,
} from "../design/primitives";
import { BoardIcon, BranchIcon, ClockIcon, FolderIcon } from "../design/icons";
import { relativeTime } from "./visual";

const LANES: Array<{ id: string; title: string; caption: string; match: string[] }> = [
  {
    id: "running",
    title: "Running",
    caption: "One mutating turn per workspace",
    match: ["running"],
  },
  {
    id: "ready",
    title: "Unstarted",
    caption: "Prerequisites verified before starting",
    match: ["pending", "paused"],
  },
  {
    id: "attention",
    title: "Needs attention",
    caption: "Blocked and interrupted work stays visible",
    match: ["blocked", "interrupted", "failed"],
  },
  { id: "done", title: "Verified", caption: "Completion requires evidence", match: ["completed"] },
];

export function BoardScreen({
  detail,
  onOpenFolder,
  onShowStudio,
}: {
  detail: ProjectDetail | null;
  onOpenFolder: () => void;
  onShowStudio: () => void;
}): JSX.Element {
  if (!detail) {
    return (
      <div className="screen">
        <Card>
          <EmptyState
            icon={<FolderIcon size={30} />}
            title="Choose a project"
            description="The work board shows real tasks from the selected project. Nothing is scheduled until you add a task."
            action={
              <Button variant="primary" onClick={onOpenFolder} icon={<FolderIcon size={16} />}>
                Open folder
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const tasks = detail.tasks;
  return (
    <div className="screen screen--board">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Work board</p>
          <h1 className="screen-title">{detail.project.name}</h1>
          <p className="screen-lede">
            Unstarted tasks remain unstarted. Dependencies and evidence are explicit; no percentage
            is guessed from elapsed time or effort.
          </p>
        </div>
        <div className="screen-header__actions">
          <Button variant="secondary" icon={<BoardIcon size={15} />} onClick={onShowStudio}>
            Open studio
          </Button>
        </div>
      </header>

      {tasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BoardIcon size={30} />}
            title="No tasks yet"
            description="Tasks are created explicitly with a bounded prompt and acceptance criteria. Live task creation arrives in P10; nothing is scheduled behind your back."
          />
        </Card>
      ) : (
        <div className="board" role="region" aria-label="Task lanes">
          {LANES.map((lane) => {
            const laneTasks = tasks.filter((task) => lane.match.includes(task.status));
            return (
              <section
                className="board__lane"
                key={lane.id}
                aria-labelledby={`shell-lane-${lane.id}`}
              >
                <header className="board__lane-header">
                  <div>
                    <h2 className="board__lane-title" id={`shell-lane-${lane.id}`}>
                      {lane.title}
                    </h2>
                    <p className="board__lane-caption">{lane.caption}</p>
                  </div>
                  <span className="board__count" aria-label={`${laneTasks.length} tasks`}>
                    {laneTasks.length}
                  </span>
                </header>
                <div className="board__lane-body">
                  {laneTasks.length === 0 ? (
                    <p className="board__empty">
                      <ClockIcon size={15} /> Nothing here
                    </p>
                  ) : (
                    laneTasks.map((task) => {
                      const dependencies = task.dependsOn
                        .map((id) => tasks.find((entry) => entry.id === id))
                        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
                      return (
                        <article
                          className={`task-card task-card--${task.status}`}
                          key={task.id}
                          aria-labelledby={`${task.id}-title`}
                        >
                          <header className="task-card__header">
                            <StatusBadge status={task.status as WorkStatus} />
                            <span className="task-card__time">{relativeTime(task.updatedAt)}</span>
                          </header>
                          <h3 className="task-card__title" id={`${task.id}-title`}>
                            {task.title}
                          </h3>
                          {dependencies.length > 0 ? (
                            <p className="task-card__deps">
                              <BranchIcon size={14} /> Depends on{" "}
                              {dependencies.map((dependency) => (
                                <span
                                  key={dependency.id}
                                  className="task-card__dep"
                                  title={dependency.title}
                                >
                                  {dependency.title}
                                </span>
                              ))}
                            </p>
                          ) : (
                            <p className="task-card__deps task-card__deps--none">
                              No prerequisites
                            </p>
                          )}
                          <footer className="task-card__footer">
                            <span className="mono task-card__id">{task.id}</span>
                            <Badge tone="neutral">Revision {task.revision}</Badge>
                          </footer>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Card title="How status is decided" eyebrow="Local state only">
        <ul className="rule-list">
          <li>
            <StatusBadge status="pending" /> A pending task is not partly done; no start time is
            implied.
          </li>
          <li>
            <StatusBadge status="running" /> One mutating turn per workspace; the engine owns
            execution.
          </li>
          <li>
            <StatusBadge status="blocked" /> Three attempts without material progress stop that
            problem and keep the requirement visible.
          </li>
          <li>
            <StatusBadge status="completed" /> Requires recorded acceptance evidence, not a model
            claim.
          </li>
        </ul>
      </Card>
    </div>
  );
}
