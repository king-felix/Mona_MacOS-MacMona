import type { WireRuntimeInfo } from "./wire";

/**
 * Explicit compatibility policy. The installed 0.10.2 build is pinned; a
 * different version or commit is an incompatibility, not an invitation to try
 * unknown fields. Any future widening must be a recorded, tested decision.
 */
export const PINNED_ENGINE = {
  version: "0.10.2",
  commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e",
} as const;

/** Capabilities the adapter depends on for its core operations. */
export const REQUIRED_CAPABILITIES = ["threads", "turns", "event_replay"] as const;

export interface CompatibilityReport {
  compatible: boolean;
  version: string;
  commit: string;
  versionMatch: boolean;
  commitMatch: boolean;
  missingCapabilities: string[];
  reasons: string[];
}

export function evaluateCompatibility(info: WireRuntimeInfo): CompatibilityReport {
  const versionMatch = info.codewhale_version === PINNED_ENGINE.version;
  const commitMatch = info.codewhale_commit === PINNED_ENGINE.commit;
  const missingCapabilities = REQUIRED_CAPABILITIES.filter(
    (name) => info.capabilities[name] !== true,
  );
  const reasons: string[] = [];
  if (!versionMatch) {
    reasons.push(`engine version ${info.codewhale_version} is not pinned ${PINNED_ENGINE.version}`);
  }
  if (!commitMatch) {
    reasons.push(`engine commit ${info.codewhale_commit.slice(0, 12)} is not the pinned commit`);
  }
  for (const name of missingCapabilities) {
    reasons.push(`required capability "${name}" is not advertised`);
  }
  return {
    compatible: reasons.length === 0,
    version: info.codewhale_version,
    commit: info.codewhale_commit,
    versionMatch,
    commitMatch,
    missingCapabilities,
    reasons,
  };
}

export function hasCapability(info: WireRuntimeInfo, name: string): boolean {
  return info.capabilities[name] === true;
}
