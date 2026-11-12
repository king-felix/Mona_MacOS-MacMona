import type { JSX } from "react";
import { fixtureEvents, fixtureProjects, fixtureTasks, type FixtureProject } from "../fixtures";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Menu,
  ScreenHeader,
  StatusBadge,
  type Tone,
} from "../primitives";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  BranchIcon,
  ClockIcon,
  FolderIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SparkIcon,
  WarningIcon,
} from "../icons";
import type { Scenario } from "./types";

const HEALTH: Record<FixtureProject["health"], { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "success" },
  disconnected: { label: "Disconnected", tone: "attention" },
  "missing-runtime": { label: "Runtime missing", tone: "danger" },
  "missing-credentials": { label: "Credentials missing", tone: "attention" },
};

function ProjectCard({ project }: { project: FixtureProject }): JSX.Element {
  const health = HEALTH[project.health];
  return (
    <Card
      className="project-card"
      actions={
        <>
          {project.pinned ? (
            <IconButton label={`Unpin ${project.name}`}>
              <PinIcon size={16} />
            </IconButton>
          ) : null}
          <Menu
            label="Project actions"
            items={[
              {
                id: "reveal",
                label: "Reveal in Finder",
                icon: <FolderIcon size={15} />,
                onSelect: () => undefined,
              },
              { id: "rename", label: "Rename label", onSelect: () => undefined },
              {
                id: "pin",
                label: project.pinned ? "Unpin project" : "Pin project",
                icon: <PinIcon size={15} />,
                onSelect: () => undefined,
              },
              {
                id: "archive",
                label: "Archive project",
                icon: <ArchiveIcon size={15} />,
                onSelect: () => undefined,
              },
            ]}
          />
        </>
      }
    >
      <button type="button" className="project-card__open">
        <span className={`monogram monogram--${project.accent}`} aria-hidden="true">
          {project.monogram}
        </span>
        <span className="project-card__text">
          <span className="project-card__name">{project.name}</span>
          <span className="project-card__path mono" title={project.path}>
            {project.path}
          </span>
          <span className="project-card__meta">
            <span className="inline-icon">
              <BranchIcon size={14} /> {project.branch}
            </span>
            <Badge tone={health.tone}>{health.label}</Badge>
          </span>
        </span>
        <span className="project-card__activity">{project.lastActive}</span>
      </button>
    </Card>
  );
}

export function HomeScreen({ scenario }: { scenario: Scenario }): JSX.Element {
  const projects =
    scenario === "empty" ? [] : fixtureProjects.filter((project) => !project.archived);
  const pinned = projects.filter((project) => project.pinned);
  const recent = projects.filter((project) => !project.pinned);
  const blocked = fixtureTasks.find((task) => task.status === "blocked");
  const attentionEvents = fixtureEvents.slice(-2);

  return (
    <div className="screen screen--home">
      <ScreenHeader
        eyebrow="Home"
        title="A quiet studio for real work."
        lede="Open a folder, return to a project, and see what needs attention. Browsing makes no model calls."
        actions={
          <>
            <Button variant="secondary" icon={<SearchIcon size={16} />}>
              Search projects
            </Button>
            <Button variant="primary" icon={<PlusIcon size={16} />}>
              Open folder
            </Button>
          </>
        }
      />

      {scenario === "disconnected" ? (
        <Callout tone="attention" title="The engine is disconnected">
          Local history, settings, and the project catalog remain available. Execution waits for a
          runtime; nothing was restarted automatically.
        </Callout>
      ) : null}

      {projects.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderIcon size={30} />}
            title="Choose a folder to begin"
            description="No API key is required to browse, read history, or configure Mona. You can add one later through the engine's own credential flow."
            action={
              <Button variant="primary" icon={<PlusIcon size={16} />}>
                Open folder
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {pinned.length > 0 ? (
            <section className="section" aria-labelledby="pinned-heading">
              <div className="section__header">
                <h2 className="section__title" id="pinned-heading">
                  Pinned
                </h2>
                <span className="section__hint">{pinned.length} projects</span>
              </div>
              <div className="project-grid">
                {pinned.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            </section>
          ) : null}

          <div className="home-columns">
            <section className="section" aria-labelledby="recent-heading">
              <div className="section__header">
                <h2 className="section__title" id="recent-heading">
                  Recent
                </h2>
                <Button variant="ghost" size="sm" trailing={<ArrowUpRightIcon size={14} />}>
                  View all
                </Button>
              </div>
              <div className="project-grid project-grid--single">
                {recent.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            </section>

            <div className="home-side">
              <Card title="Needs attention" eyebrow="Local state only">
                <ul className="attention-list">
                  {blocked ? (
                    <li className="attention-item">
                      <span
                        className="attention-item__icon attention-item__icon--danger"
                        aria-hidden="true"
                      >
                        <WarningIcon size={16} />
                      </span>
                      <div>
                        <p className="attention-item__title">{blocked.title}</p>
                        <p className="attention-item__detail">
                          Three attempts recorded. Acknowledging the card does not clear it or reset
                          the counter.
                        </p>
                      </div>
                      <Badge tone="danger">Blocked</Badge>
                    </li>
                  ) : null}
                  <li className="attention-item">
                    <span className="attention-item__icon" aria-hidden="true">
                      <ClockIcon size={16} />
                    </span>
                    <div>
                      <p className="attention-item__title">
                        One interrupted task needs reconciliation
                      </p>
                      <p className="attention-item__detail">
                        Mona will read the thread before resuming; it will not resend a possibly
                        executed turn.
                      </p>
                    </div>
                    <StatusBadge status="interrupted" />
                  </li>
                </ul>
              </Card>

              <Card title="Since you left" eyebrow="Deterministic digest">
                <ul className="digest-list">
                  {attentionEvents.map((event) => (
                    <li key={event.id} className="digest-item">
                      <span className="digest-item__time">{event.at}</span>
                      <span className="digest-item__title">{event.title}</span>
                      {event.body ? <span className="digest-item__body">{event.body}</span> : null}
                    </li>
                  ))}
                </ul>
                <p className="hint-line">
                  <SparkIcon size={14} /> Generated from local events. No summarizer, no inference.
                </p>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
