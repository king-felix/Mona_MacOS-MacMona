import type { JSX } from "react";
import { fixtureTasks, type FixtureTask } from "../fixtures";
import { Badge, Button, Callout, Card, EmptyState, ScreenHeader, StatusBadge } from "../primitives";
import {
  ArrowUpRightIcon,
  BoardIcon,
  BranchIcon,
  ClockIcon,
  PlusIcon,
  WarningIcon,
} from "../icons";
import type { Scenario } from "./types";

const LANES: Array<{ id: string; title: string; caption: string; match: FixtureTask["status"][] }> =
  [
    {
      id: "active",
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
    {
      id: "done",
      title: "Verified",
      caption: "Completion requires evidence",
      match: ["completed"],
    },
  ];

function TaskCard({
  task,
  allTasks,
  onOpenBlocker,
}: {
  task: FixtureTask;
  allTasks: FixtureTask[];
  onOpenBlocker?: () => void;
}): JSX.Element {
  const dependencies = task.dependsOn
    .map((id) => allTasks.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is FixtureTask => Boolean(candidate));
  return (
    <article className={`task-card task-card--${task.status}`} aria-labelledby={`${task.id}-title`}>
      <header className="task-card__header">
        <StatusBadge status={task.status} />
        <span className="task-card__time">{task.updatedAt}</span>
      </header>
      <h3 className="task-card__title" id={`${task.id}-title`}>
        {task.title}
      </h3>
      {task.note ? <p className="task-card__note">{task.note}</p> : null}
      <div className="task-card__chips">
        {task.requirements.map((requirement) => (
          <Badge key={requirement} tone="neutral">
            {requirement}
          </Badge>
        ))}
      </div>
      {dependencies.length > 0 ? (
        <p className="task-card__deps">
          <BranchIcon size={14} /> Depends on{" "}
          {dependencies.map((dependency) => (
            <span key={dependency.id} className="task-card__dep">
              {dependency.title}
            </span>
          ))}
        </p>
      ) : (
        <p className="task-card__deps task-card__deps--none">No prerequisites</p>
      )}
      <footer className="task-card__footer">
        <span className="mono task-card__id">{task.id}</span>
        {task.status === "blocked" && onOpenBlocker ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<WarningIcon size={14} />}
            onClick={onOpenBlocker}
          >
            Open blocker
          </Button>
        ) : (
          <Button size="sm" variant="ghost" trailing={<ArrowUpRightIcon size={14} />}>
            Details
          </Button>
        )}
      </footer>
    </article>
  );
}

export function WorkBoardScreen({
  scenario,
  onOpenBlocker,
}: {
  scenario: Scenario;
  onOpenBlocker?: () => void;
}): JSX.Element {
  const tasks = scenario === "empty" ? [] : fixtureTasks;
  return (
    <div className="screen screen--board">
      <ScreenHeader
        eyebrow="Work board"
        title="Prompt dependencies, verified progress"
        lede="Unstarted tasks remain unstarted. Mona never guesses a percentage from elapsed time or effort."
        actions={
          <>
            <Button variant="secondary" icon={<BoardIcon size={16} />}>
              Filter
            </Button>
            <Button variant="primary" icon={<PlusIcon size={16} />}>
              New task
            </Button>
          </>
        }
      />

      {scenario === "blocked" ? (
        <Callout
          tone="danger"
          title="P08 is blocked after three attempts without material progress"
          action={
            <Button size="sm" variant="secondary" onClick={onOpenBlocker}>
              Review blocker
            </Button>
          }
        >
          Its dependency chain pauses. Independent tasks remain eligible and visible.
        </Callout>
      ) : null}

      {tasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BoardIcon size={30} />}
            title="No tasks yet"
            description="Add a bounded prompt to this project. Dependencies and acceptance criteria stay explicit; nothing is scheduled behind your back."
            action={
              <Button variant="primary" icon={<PlusIcon size={16} />}>
                Add the first task
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="board" role="region" aria-label="Task lanes">
          {LANES.map((lane) => {
            const laneTasks = tasks.filter((task) => lane.match.includes(task.status));
            return (
              <section className="board__lane" key={lane.id} aria-labelledby={`lane-${lane.id}`}>
                <header className="board__lane-header">
                  <div>
                    <h2 className="board__lane-title" id={`lane-${lane.id}`}>
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
                    laneTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        allTasks={tasks}
                        onOpenBlocker={onOpenBlocker}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Card title="How status is decided" eyebrow="Deterministic, local">
        <ul className="rule-list">
          <li>
            <StatusBadge status="pending" /> No start time is implied. A pending task is not “80%
            done” because a sibling finished.
          </li>
          <li>
            <StatusBadge status="running" /> One mutating turn per workspace; the engine owns
            execution.
          </li>
          <li>
            <StatusBadge status="blocked" /> Three attempts without material progress stop the
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
