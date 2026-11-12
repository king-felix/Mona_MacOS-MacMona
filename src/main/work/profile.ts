import type { StudioMode, StudioProfileView } from "../../shared/contracts/studio";
import type { StateStore } from "../state/store";

/**
 * Victor's saved DS Full Access profile. It is configured once in local
 * settings and shown persistently; P16 owns editing it. The default records
 * the route measured at P01 (`deepseek` / `deepseek-flash`), not an invented
 * one, and it is written to disk so a later change is a visible edit, never a
 * silent default shift.
 */
export interface ExecutionProfile {
  provider: string;
  /** Exact configured route identity for a named custom provider, else null. */
  exactId: string | null;
  model: string;
  reasoningEffort?: string;
  permissionPosture: "full_access" | "ask";
  autoApprove: boolean;
  trustMode: boolean;
  allowShell: boolean;
}

export const PROFILE_SCOPE = "engine:profile";

export const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = {
  provider: "deepseek",
  exactId: null,
  model: "deepseek-flash",
  permissionPosture: "full_access",
  autoApprove: true,
  trustMode: true,
  allowShell: true,
};

export interface LoadedProfile {
  profile: ExecutionProfile;
  source: "configured" | "default";
}

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseExecutionProfile(value: unknown): ExecutionProfile | null {
  if (!isRecord(value)) return null;
  const { provider, model, reasoningEffort } = value;
  if (typeof provider !== "string" || !PROVIDER.test(provider)) return null;
  if (typeof model !== "string" || !MODEL.test(model)) return null;
  const exactId =
    typeof value.exactId === "string" && value.exactId.length > 0 && MODEL.test(value.exactId)
      ? value.exactId
      : null;
  const posture = value.permissionPosture === "ask" ? "ask" : "full_access";
  const fullAccess = posture === "full_access";
  return {
    provider,
    exactId,
    model,
    ...(typeof reasoningEffort === "string" && reasoningEffort.length > 0
      ? { reasoningEffort }
      : {}),
    permissionPosture: posture,
    autoApprove: fullAccess && value.autoApprove !== false,
    trustMode: fullAccess && value.trustMode !== false,
    allowShell: fullAccess && value.allowShell !== false,
  };
}

/**
 * Read the saved profile. On first read the measured default is written once so
 * the value the studio displays is the value stored on disk.
 */
export async function loadExecutionProfile(store: StateStore): Promise<LoadedProfile> {
  const stored = await store.getSettings(PROFILE_SCOPE);
  const parsed = stored ? parseExecutionProfile(stored.value) : null;
  if (parsed) return { profile: parsed, source: "configured" };
  await store.putSettings(PROFILE_SCOPE, {
    ...DEFAULT_EXECUTION_PROFILE,
    configuredAt: new Date().toISOString(),
    note: "Measured default from P01; edit route in P16.",
  });
  return { profile: { ...DEFAULT_EXECUTION_PROFILE }, source: "default" };
}

export interface ModePosture {
  permissionPosture: "full_access" | "ask";
  autoApprove: boolean;
  trustMode: boolean;
  allowShell: boolean;
}

/**
 * Plan is a genuinely narrower execution posture, bound at thread creation and
 * repeated on the turn. Work uses the saved full-access profile. Nothing here
 * widens a request without the profile saying so.
 */
export function postureFor(mode: StudioMode, profile: ExecutionProfile): ModePosture {
  if (mode === "plan") {
    return {
      permissionPosture: "ask",
      autoApprove: false,
      trustMode: false,
      allowShell: false,
    };
  }
  const fullAccess = profile.permissionPosture === "full_access";
  return {
    permissionPosture: profile.permissionPosture,
    autoApprove: fullAccess && profile.autoApprove,
    trustMode: fullAccess && profile.trustMode,
    allowShell: fullAccess && profile.allowShell,
  };
}

export function profileView(
  profile: ExecutionProfile,
  source: "configured" | "default",
  effective: StudioProfileView["effective"] = null,
  effectiveTurnId: string | null = null,
): StudioProfileView {
  return {
    provider: profile.provider,
    exactId: profile.exactId,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort ?? null,
    permissionPosture: profile.permissionPosture,
    autoApprove: profile.autoApprove,
    trustMode: profile.trustMode,
    allowShell: profile.allowShell,
    source,
    effective,
    effectiveTurnId,
  };
}
