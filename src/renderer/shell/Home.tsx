import type { JSX } from "react";
import type { ProjectSummary } from "../../shared/contracts/project-bridge";
import type { PolishDigestView, PolishScreen } from "../../shared/contracts/polish";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Menu,
  ScreenHeader,
  Switch,
} from "../design/primitives";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ClockIcon,
  FolderIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SparkIcon,
  WarningIcon,
} from "../design/icons";
import type { HomeProps } from "./types";
import { projectAccent, projectMonogram, relativeTime, repositoryLabel } from "./visual";

function ProjectRow({
  project,
  selected,
  onSelect,
  onRename,
  onPin,
  onArchive,
  onRemove,
  onRelocate,
  onReveal,
  onEditIdentity,
}: {
  project: ProjectSummary;
  selected: boolean;
} & Pick<
  HomeProps,
  | "onSelect"
  | "onRename"
  | "onPin"
  | "onArchive"
  | "onRemove"
  | "onRelocate"
  | "onReveal"
  | "onEditIdentity"
>): JSX.Element {
  return (
    <article className={`project-row ${selected ? "project-row--selected" : ""}`}>
      <button
        type="button"
        className="project-row__open"
        onClick={() => onSelect(project)}
        aria-current={selected ? "true" : undefined}
        data-project-id={project.id}
      >
        <span className={`monogram monogram--${projectAccent(project)}`} aria-hidden="true">
          {projectMonogram(project)}
        </span>
        <span className="project-row__text">
          <span className="project-row__name">
            {project.name}
            {project.archived ? <Badge tone="neutral">Archived</Badge> : null}
          </span>
          <span className="project-row__path mono" title={project.rootPath}>
            {project.rootPath}
          </span>
          <span className="project-row__meta">
            <Badge tone="neutral">{repositoryLabel(project)}</Badge>
            {project.pinned ? <Badge tone="primary">Pinned</Badge> : null}
          </span>
        </span>
        <span className="project-row__activity">{relativeTime(project.updatedAt)}</span>
      </button>
      <div className="project-row__actions">
        <IconButton
          label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
          onClick={() => onPin(project)}
        >
          <PinIcon size={15} />
        </IconButton>
        <Menu
          label="Project actions"
          items={[
            {
              id: "open",
              label: "Open project",
              icon: <FolderIcon size={15} />,
              onSelect: () => onSelect(project),
            },
            {
              id: "reveal",
              label: "Reveal in Finder",
              icon: <ArrowUpRightIcon size={15} />,
              onSelect: () => onReveal(project),
            },
            { id: "rename", label: "Rename label…", onSelect: () => onRename(project) },
            {
              id: "identity",
              label: "Project identity…",
              icon: <SparkIcon size={15} />,
              onSelect: () => onEditIdentity(project),
            },
            {
              id: "pin",
              label: project.pinned ? "Unpin" : "Pin",
              icon: <PinIcon size={15} />,
              onSelect: () => onPin(project),
            },
            {
              id: "relocate",
              label: "Relocate folder…",
              icon: <ArrowUpRightIcon size={15} />,
              onSelect: () => onRelocate(project),
            },
            {
              id: "archive",
              label: project.archived ? "Restore from archive" : "Archive",
              icon: <ArchiveIcon size={15} />,
              onSelect: () => onArchive(project),
            },
            {
              id: "remove",
              label: "Remove from catalog…",
              danger: true,
              onSelect: () => onRemove(project),
            },
          ]}
        />
      </div>
    </article>
  );
}

function toneFor(tone: string): "neutral" | "success" | "attention" | "danger" {
  return tone === "success" || tone === "attention" || tone === "danger" ? tone : "neutral";
}

function ResumeBrief({
  digest,
  onOpenScreen,
  onRevealEvidence,
}: {
  digest: PolishDigestView;
  onOpenScreen: (screen: PolishScreen) => void;
  onRevealEvidence: (path: string) => void;
}): JSX.Element {
  const { resume, sinceYouLeft } = digest;
  const current = resume.currentTask;
  return (
    <section className="resume" aria-labelledby="resume-heading" data-testid="resume-brief">
      <div className="section__header">
        <h2 className="section__title" id="resume-heading">
          Resume Brief
        </h2>
        <span className="section__hint">
          Built from stored tasks, events, receipts, and usage · no model call · no invented
          percentage
        </span>
      </div>
      <div className="resume__grid">
        <Card
          title={current ? current.title : "No task in focus"}
          eyebrow={current ? `Current prompt · ${current.status}` : "Current prompt"}
        >
          <dl className="detail-list" data-testid="resume-facts">
            {resume.facts.map((fact) => (
              <div className="detail-row" key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>
                  <Badge tone={toneFor(fact.tone)}>{fact.value}</Badge>
                </dd>
              </div>
            ))}
            {resume.lastVerifiedStep ? (
              <div className="detail-row">
                <dt>Last verified step</dt>
                <dd>{resume.lastVerifiedStep}</dd>
              </div>
            ) : null}
          </dl>
          <p className="resume__next" data-testid="resume-next">
            <strong>Next exact action.</strong> {resume.nextStep}
          </p>
          {resume.unresolvedBlocker ? (
            <Callout
              tone="danger"
              title={`Unresolved blocker · ${resume.unresolvedBlocker.requirement}`}
              action={
                <Button size="sm" variant="secondary" onClick={() => onOpenScreen("board")}>
                  Open blocker
                </Button>
              }
            >
              {resume.unresolvedBlocker.helpNeeded}
              <span className="hint-line">
                {resume.unresolvedBlocker.totalAttempts} total ·{" "}
                {resume.unresolvedBlocker.noProgressAttempts} without progress · acknowledging does
                not reset the count
              </span>
            </Callout>
          ) : null}
          <p className="hint-line">
            {resume.testResult.note} {resume.changes.note} {resume.spend.label}.
          </p>
        </Card>

        <Card
          title="Since you left"
          eyebrow={
            sinceYouLeft.since
              ? `Since ${new Date(sinceYouLeft.since).toLocaleString()}`
              : "First visit"
          }
        >
          <p className="hint-line">{sinceYouLeft.note}</p>
          {sinceYouLeft.groups.length > 0 ? (
            <div className="digest" data-testid="since-you-left">
              {sinceYouLeft.groups.map((group) => (
                <div className="digest__group" key={group.id}>
                  <h3 className="digest__title">
                    {group.id === "completion" ? (
                      <CheckIcon size={14} />
                    ) : group.id === "blocker" || group.id === "attention" ? (
                      <WarningIcon size={14} />
                    ) : group.id === "test" ? (
                      <ClockIcon size={14} />
                    ) : (
                      <SparkIcon size={14} />
                    )}
                    {group.title}
                    <span className="digest__count">{group.entries.length}</span>
                  </h3>
                  <ul className="digest__list">
                    {group.entries.map((entry) => (
                      <li key={entry.key} className="digest__item">
                        <button
                          type="button"
                          className="digest__open"
                          onClick={() => onOpenScreen(entry.screen)}
                        >
                          <span className="digest__entry-title">{entry.title}</span>
                          <span className="digest__entry-time">
                            {new Date(entry.at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {entry.detail ? (
                            <span className="digest__entry-detail">{entry.detail}</span>
                          ) : null}
                        </button>
                        {entry.evidencePath ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onRevealEvidence(entry.evidencePath ?? "")}
                          >
                            Evidence
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {sinceYouLeft.duplicatesSuppressed > 0 ? (
                <p className="hint-line">
                  {sinceYouLeft.duplicatesSuppressed} duplicate event row
                  {sinceYouLeft.duplicatesSuppressed === 1 ? "" : "s"} ignored.
                </p>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>
    </section>
  );
}

export function HomeScreen(props: HomeProps): JSX.Element {
  const { catalog, selectedId, query, showArchived, busy } = props;
  const active = catalog.filter((project) => !project.archived);
  const pinned = active.filter((project) => project.pinned);
  const recent = active.filter((project) => !project.pinned);
  const archived = catalog.filter((project) => project.archived);

  return (
    <div className="screen screen--home">
      <ScreenHeader
        eyebrow="Home"
        title="A quiet studio for real work."
        lede="Open a folder, return to a project, and see what needs attention. Browsing makes no model calls."
        actions={
          <Button
            variant="primary"
            icon={<PlusIcon size={16} />}
            onClick={props.onOpenFolder}
            disabled={busy}
          >
            Open or import folder
          </Button>
        }
      />

      {props.digest ? (
        <ResumeBrief
          digest={props.digest}
          onOpenScreen={props.onOpenScreen}
          onRevealEvidence={props.onRevealEvidence}
        />
      ) : (
        <p className="hint-line" data-testid="resume-empty">
          Select a project to see its deterministic Resume Brief. Nothing here is generated by a
          model.
        </p>
      )}

      <div className="home-toolbar">
        <div className="search-field">
          <SearchIcon size={16} />
          <input
            className="search-field__input"
            aria-label="Search projects"
            placeholder="Search names and paths"
            value={query}
            onChange={(event) => props.onQuery(event.target.value)}
          />
        </div>
        <Switch label="Show archived" checked={showArchived} onChange={props.onToggleArchived} />
        <span className="hint-line">
          {catalog.length} project{catalog.length === 1 ? "" : "s"} in the local catalog
        </span>
      </div>

      {catalog.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderIcon size={30} />}
            title={query ? "No matching projects" : "Choose a folder to begin"}
            description={
              query
                ? "Search is local to the project catalog. Clear the query or open another folder."
                : "No API key is required to browse, read history, or configure Mona. Opening an empty folder creates a project without touching its contents."
            }
            action={
              query ? undefined : (
                <Button
                  variant="primary"
                  icon={<PlusIcon size={16} />}
                  onClick={props.onOpenFolder}
                >
                  Open folder
                </Button>
              )
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
                <span className="section__hint">{pinned.length}</span>
              </div>
              <div className="catalog-list">
                {pinned.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    selected={project.id === selectedId}
                    {...props}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="section" aria-labelledby="recent-heading">
            <div className="section__header">
              <h2 className="section__title" id="recent-heading">
                Recent
              </h2>
              <span className="section__hint">Sorted by catalog update, not guessed activity</span>
            </div>
            {recent.length === 0 ? (
              <p className="hint-line">No unpinned projects. Everything here is pinned.</p>
            ) : (
              <div className="catalog-list">
                {recent.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    selected={project.id === selectedId}
                    {...props}
                  />
                ))}
              </div>
            )}
          </section>

          {showArchived && archived.length > 0 ? (
            <section className="section" aria-labelledby="archived-heading">
              <div className="section__header">
                <h2 className="section__title" id="archived-heading">
                  Archived
                </h2>
                <span className="section__hint">{archived.length}</span>
              </div>
              <div className="catalog-list">
                {archived.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    selected={project.id === selectedId}
                    {...props}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <Card title="How the catalog behaves" eyebrow="Local state only">
        <ul className="rule-list">
          <li>
            <FolderIcon size={15} /> Opening a folder registers it. Two aliases of one folder
            resolve to one project; folder contents are never scanned wholesale.
          </li>
          <li>
            <ArchiveIcon size={15} /> Archiving hides a project without deleting source files.
            Removal from the catalog also leaves the folder untouched.
          </li>
          <li>
            <PinIcon size={15} /> A moved folder is rebound deliberately with Relocate; history and
            task state follow the project id.
          </li>
        </ul>
      </Card>
    </div>
  );
}
