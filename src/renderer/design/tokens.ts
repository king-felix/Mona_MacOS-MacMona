/**
 * Design tokens. Colors are the single source of truth: the renderer applies
 * them as CSS custom properties and the test suite measures WCAG contrast
 * between every foreground/background pair the components actually use.
 *
 * Starting palette: Mona macOS specification §4.1, adjusted only where a
 * measured ratio required it (Daybreak danger/coral text).
 */
export type ThemeName = "daybreak" | "afterglow";
export type Density = "comfortable" | "dense";
/**
 * R06 decoration intensity. It is *only* decoration: the semantic foreground and
 * background roles are identical in both intensities, so Quiet is not a
 * lower-contrast mode and Vivid is not a second design. What changes is the
 * wash, the luminous edges, the plaque and how much surface carries colour.
 */
export type Intensity = "vivid" | "quiet";

export interface ThemeTokens {
  canvas: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  ink: string;
  muted: string;
  subtle: string;
  primary: string;
  primaryHover: string;
  onPrimary: string;
  success: string;
  successInk: string;
  successSoft: string;
  attention: string;
  attentionInk: string;
  attentionSoft: string;
  danger: string;
  dangerInk: string;
  dangerSoft: string;
  onDanger: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  border: string;
  borderInteractive: string;
  focus: string;
  overlay: string;
  /**
   * Decorative roles. They are never used for text on a surface and are
   * therefore measured as *ornament*, not as a text pair: a gradient stop may
   * sit behind an opaque content layer, a border, or a rail mark. Where one of
   * them must carry a glyph, the glyph uses the measured `ink`/`onPrimary`
   * roles on an opaque chip instead.
   */
  auroraA: string;
  auroraB: string;
  auroraC: string;
  /** A selected rail/project chip that is not the primary action. */
  selection: string;
  selectionInk: string;
  /** Luminous edge colour for a focused or live surface. */
  glow: string;
}

export const THEMES: Record<ThemeName, ThemeTokens> = {
  daybreak: {
    canvas: "#F7F8FC",
    surface: "#FFFFFF",
    surfaceRaised: "#FFFFFF",
    surfaceSunken: "#EEF1F8",
    ink: "#18213B",
    muted: "#53617A",
    subtle: "#6B7890",
    primary: "#6346DF",
    primaryHover: "#5538C9",
    onPrimary: "#FFFFFF",
    success: "#007B70",
    successInk: "#005A52",
    successSoft: "#E3F4F1",
    attention: "#8A5700",
    attentionInk: "#8A5700",
    attentionSoft: "#FFF1D6",
    danger: "#B8324C",
    dangerInk: "#8E2338",
    dangerSoft: "#FCE8EC",
    onDanger: "#FFFFFF",
    accent: "#D94A66",
    accentInk: "#A62E47",
    accentSoft: "#FCE8EC",
    border: "#DCE2EF",
    borderInteractive: "#7C8AA3",
    focus: "#6346DF",
    overlay: "rgba(16, 24, 48, 0.45)",
    // Daybreak: iris → orchid → cyan wash, mint for a live state, coral sparingly.
    auroraA: "#795CFF",
    auroraB: "#C16CFF",
    auroraC: "#38CFE8",
    selection: "#EDEAFF",
    selectionInk: "#3A2A9E",
    glow: "rgba(121, 92, 255, 0.28)",
  },
  afterglow: {
    canvas: "#12142A",
    surface: "#1B1E3A",
    surfaceRaised: "#232748",
    surfaceSunken: "#0D0F20",
    ink: "#EDEBFF",
    muted: "#B4B2D6",
    subtle: "#9A97C2",
    primary: "#A78BFA",
    primaryHover: "#B9A4FF",
    onPrimary: "#1A1233",
    success: "#5BE3B0",
    successInk: "#8FF3CF",
    successSoft: "#12352C",
    attention: "#F2B45C",
    attentionInk: "#FFD9A3",
    attentionSoft: "#3A2A14",
    danger: "#FF8FA3",
    dangerInk: "#FFC2CD",
    dangerSoft: "#3A1D27",
    onDanger: "#2A0A13",
    accent: "#FF8FA3",
    accentInk: "#FFC2CD",
    accentSoft: "#3A1D27",
    border: "#33375F",
    borderInteractive: "#6A70AD",
    focus: "#B9A4FF",
    overlay: "rgba(6, 8, 20, 0.65)",
    // Afterglow: midnight indigo with orchid, violet and a luminous mint edge.
    auroraA: "#C16CFF",
    auroraB: "#795CFF",
    auroraC: "#55E3B3",
    selection: "#2C2A55",
    selectionInk: "#E4DEFF",
    glow: "rgba(193, 108, 255, 0.32)",
  },
};

const CSS_NAMES: Record<keyof ThemeTokens, string> = {
  canvas: "--canvas",
  surface: "--surface",
  surfaceRaised: "--surface-raised",
  surfaceSunken: "--surface-sunken",
  ink: "--ink",
  muted: "--muted",
  subtle: "--subtle",
  primary: "--primary",
  primaryHover: "--primary-hover",
  onPrimary: "--on-primary",
  success: "--success",
  successInk: "--success-ink",
  successSoft: "--success-soft",
  attention: "--attention",
  attentionInk: "--attention-ink",
  attentionSoft: "--attention-soft",
  danger: "--danger",
  dangerInk: "--danger-ink",
  dangerSoft: "--danger-soft",
  onDanger: "--on-danger",
  accent: "--accent",
  accentInk: "--accent-ink",
  accentSoft: "--accent-soft",
  border: "--border",
  borderInteractive: "--border-interactive",
  focus: "--focus",
  overlay: "--overlay",
  auroraA: "--aurora-a",
  auroraB: "--aurora-b",
  auroraC: "--aurora-c",
  selection: "--selection",
  selectionInk: "--selection-ink",
  glow: "--glow",
};

export function themeVariables(theme: ThemeName): Record<string, string> {
  const tokens = THEMES[theme];
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens) as Array<[keyof ThemeTokens, string]>) {
    variables[CSS_NAMES[key]] = value;
  }
  return variables;
}

export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(themeVariables(theme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "afterglow" ? "dark" : "light";
}

export function applyDensity(density: Density, root: HTMLElement = document.documentElement): void {
  root.dataset.density = density;
}

/**
 * Vivid is the expressive treatment; Quiet keeps the same layout and the same
 * measured colours with calmer chrome. The attribute is on the document root so
 * one CSS rule set governs every screen, including the immersive Studio.
 */
export function applyIntensity(
  intensity: Intensity,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.intensity = intensity;
}

export function applyReducedMotion(
  reduced: boolean,
  root: HTMLElement = document.documentElement,
): void {
  if (reduced) root.dataset.reducedMotion = "true";
  else delete root.dataset.reducedMotion;
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) throw new Error(`expected a #rrggbb color, received ${hex}`);
  const digits = match[1];
  const red = channel(parseInt(digits.slice(0, 2), 16));
  const green = channel(parseInt(digits.slice(2, 4), 16));
  const blue = channel(parseInt(digits.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export interface ContrastPair {
  name: string;
  foreground: keyof ThemeTokens;
  background: keyof ThemeTokens;
  /** 4.5 for normal text, 3.0 for large text and non-text UI boundaries. */
  minimum: 4.5 | 3;
}

const TEXT = 4.5 as const;
const UI = 3 as const;

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { name: "primary text on canvas", foreground: "ink", background: "canvas", minimum: TEXT },
  { name: "primary text on surface", foreground: "ink", background: "surface", minimum: TEXT },
  {
    name: "primary text on raised surface",
    foreground: "ink",
    background: "surfaceRaised",
    minimum: TEXT,
  },
  {
    name: "primary text on sunken surface",
    foreground: "ink",
    background: "surfaceSunken",
    minimum: TEXT,
  },
  { name: "muted text on canvas", foreground: "muted", background: "canvas", minimum: TEXT },
  { name: "muted text on surface", foreground: "muted", background: "surface", minimum: TEXT },
  {
    name: "muted text on sunken surface",
    foreground: "muted",
    background: "surfaceSunken",
    minimum: TEXT,
  },
  { name: "link text on canvas", foreground: "primary", background: "canvas", minimum: TEXT },
  { name: "link text on surface", foreground: "primary", background: "surface", minimum: TEXT },
  { name: "primary button label", foreground: "onPrimary", background: "primary", minimum: TEXT },
  {
    name: "primary hover label",
    foreground: "onPrimary",
    background: "primaryHover",
    minimum: TEXT,
  },
  {
    name: "success ink on soft",
    foreground: "successInk",
    background: "successSoft",
    minimum: TEXT,
  },
  {
    name: "attention ink on soft",
    foreground: "attentionInk",
    background: "attentionSoft",
    minimum: TEXT,
  },
  { name: "danger ink on soft", foreground: "dangerInk", background: "dangerSoft", minimum: TEXT },
  { name: "danger button label", foreground: "onDanger", background: "danger", minimum: TEXT },
  { name: "accent ink on soft", foreground: "accentInk", background: "accentSoft", minimum: TEXT },
  // R06: the selected rail/project chip is text on a decorative fill, so it is
  // measured like any other text pair rather than trusted because it is "just"
  // decoration.
  {
    name: "selection chip label",
    foreground: "selectionInk",
    background: "selection",
    minimum: TEXT,
  },
  { name: "success icon on canvas", foreground: "success", background: "canvas", minimum: UI },
  { name: "danger icon on canvas", foreground: "danger", background: "canvas", minimum: UI },
  { name: "attention icon on canvas", foreground: "attention", background: "canvas", minimum: UI },
  { name: "focus ring on canvas", foreground: "focus", background: "canvas", minimum: UI },
  { name: "focus ring on surface", foreground: "focus", background: "surface", minimum: UI },
  {
    name: "input border on surface",
    foreground: "borderInteractive",
    background: "surface",
    minimum: UI,
  },
  {
    name: "input border on canvas",
    foreground: "borderInteractive",
    background: "canvas",
    minimum: UI,
  },
];

export interface ContrastResult extends ContrastPair {
  ratio: number;
  pass: boolean;
}

export function auditContrast(theme: ThemeName): ContrastResult[] {
  const tokens = THEMES[theme];
  return CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastRatio(tokens[pair.foreground], tokens[pair.background]);
    return { ...pair, ratio, pass: ratio >= pair.minimum };
  });
}
