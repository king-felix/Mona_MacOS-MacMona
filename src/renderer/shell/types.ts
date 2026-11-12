import type { ProjectSummary } from "../../shared/contracts/project-bridge";
import type { PolishDigestView, PolishScreen } from "../../shared/contracts/polish";

export type ScreenId = "home" | "studio" | "board" | "changes" | "cost" | "settings";

export interface HomeProps {
  catalog: ProjectSummary[];
  selectedId: string | null;
  query: string;
  showArchived: boolean;
  busy: boolean;
  digest: PolishDigestView | null;
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
  onEditIdentity: (project: ProjectSummary) => void;
  onOpenScreen: (screen: PolishScreen) => void;
  onRevealEvidence: (path: string) => void;
}
