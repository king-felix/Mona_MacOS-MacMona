import type { ProjectSummary } from "../../shared/contracts/project-bridge";

export type ScreenId = "home" | "studio" | "board" | "cost" | "settings";

export interface HomeProps {
  catalog: ProjectSummary[];
  selectedId: string | null;
  query: string;
  showArchived: boolean;
  busy: boolean;
  onQuery: (query: string) => void;
  onToggleArchived: () => void;
  onOpenFolder: () => void;
  onSelect: (project: ProjectSummary) => void;
  onRename: (project: ProjectSummary) => void;
  onPin: (project: ProjectSummary) => void;
  onArchive: (project: ProjectSummary) => void;
  onRemove: (project: ProjectSummary) => void;
  onRelocate: (project: ProjectSummary) => void;
  onReveal: (project: ProjectSummary) => void;
}
