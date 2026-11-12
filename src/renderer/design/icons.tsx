import type { JSX, SVGProps } from "react";

/**
 * Local, inline SVG icons. No icon font, no network request, no external
 * asset. Icons are decorative; the adjacent text (or an aria-label on the
 * control) carries the meaning.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
}

function iconProps({ size = 18, ...props }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: "false",
    ...props,
  };
}

export function FolderIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.2M17.6 15.3l2.2 1.2M4.2 16.5l2.2-1.2M17.6 8.7l2.2-1.2" />
    </svg>
  );
}

export function WarningIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 4.5 21 20H3z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function PlayIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M8 5.5v13l10-6.5z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M9 5v14M15 5v14" />
    </svg>
  );
}

export function StopIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function BranchIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="8" r="2" />
      <path d="M7 8v8M9 18h3a4 4 0 0 0 4-4V10" />
    </svg>
  );
}

export function ChangesIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13.5 3.5v4h4" />
      <path d="M9 12.5h6M9 16.5h4" />
    </svg>
  );
}

export function CostIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 2s1 1.8 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2-.4-2.5-1.2M12 6.5v11" />
    </svg>
  );
}

export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function CommandIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M9 9h6v6H9zM9 9H7.5A2.5 2.5 0 1 1 10 6.5V9M15 9h1.5A2.5 2.5 0 1 0 14 6.5V9M9 15H7.5A2.5 2.5 0 1 0 10 17.5V15M15 15h1.5a2.5 2.5 0 1 1-2.5 2.5V15" />
    </svg>
  );
}

export function InfoIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function OfflineIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 4l16 16" />
      <path d="M8.5 12.5a5 5 0 0 1 7 0M5.5 9a9 9 0 0 1 3-1.7M18.5 9a9 9 0 0 1 1.6 1.4M12 17h.01" />
    </svg>
  );
}

export function LockIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <rect x="5.5" y="10" width="13" height="9" rx="2" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  );
}

export function SparkIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5 13.7 9l5.3 1.8-5.3 1.7L12 18l-1.7-5.5L5 10.8 10.3 9z" />
    </svg>
  );
}

export function BoardIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9 4.5v15M15 4.5v15" />
    </svg>
  );
}

export function HomeIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="m4 10 8-6 8 6v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" />
      <path d="M9.5 20.5v-6h5v6" />
    </svg>
  );
}

export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
    </svg>
  );
}

export function ArchiveIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <rect x="4" y="4.5" width="16" height="4" rx="1" />
      <path d="M5.5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-10M10 12.5h4" />
    </svg>
  );
}

export function PinIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M9 4.5h6l-.8 5 3 3H6.8l3-3z" />
      <path d="M12 12.5V20" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5 19 6v5.5c0 4-2.8 7.2-7 9-4.2-1.8-7-5-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M19 12a7 7 0 1 1-2.1-5" />
      <path d="M19 4.5V9h-4.5" />
    </svg>
  );
}

export function ArrowUpRightIcon(props: IconProps): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}
