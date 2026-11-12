import type { JSX } from "react";
import type { ProjectSummary } from "../../shared/contracts/project-bridge";
import {
  Badge,
  Button,
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
  FolderIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
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
}: {
  project: ProjectSummary;
  selected: boolean;
} & Pick<
  HomeProps,
  "onSelect" | "onRename" | "onPin" | "onArchive" | "onRemove" | "onRelocate" | "onReveal"
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
