import { describe, expect, it } from "vitest";
import {
  EffectiveProfile,
  ErrorResult,
  EventEnvelope,
  Project,
  ProjectId,
  SubmissionState,
  UsageEvidence,
  isTerminalSubmission,
} from "../src/shared/contracts";

const project = {
  id: "prj_0123456789abcdef",
  name: "Mona",
  rootPath: "/Users/example/Projects/Mona",
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  archived: false,
  pinned: true,
};

describe("branded identities", () => {
  it("accepts a project id with the right prefix", () => {
    expect(ProjectId.parse("prj_0123456789abcdef")).toBe("prj_0123456789abcdef");
  });

  it("rejects a project id carrying another entity's prefix", () => {
    expect(() => ProjectId.parse("thr_0123456789abcdef")).toThrow();
    expect(() => ProjectId.parse("turn_0123456789abcdef")).toThrow();
  });

  it("rejects a bare string where a project id is required", () => {
    expect(() => Project.parse({ ...project, id: "0123456789abcdef" })).toThrow();
  });
});

describe("domain schemas", () => {
  it("parses a valid project", () => {
    expect(Project.parse(project).name).toBe("Mona");
  });

  it("rejects unknown fields on a Mona-owned input record", () => {
    expect(() => Project.parse({ ...project, surprise: true })).toThrow();
  });

  it("requires an absolute macOS path", () => {
    expect(() => Project.parse({ ...project, rootPath: "relative/path" })).toThrow();
  });
});

describe("event envelope", () => {
  const envelope = {
    schema_version: 1,
    seq: 7,
    event: "some.future.event",
    kind: "some.future.event",
    thread_id: "thr_0123456789abcdef",
    timestamp: "2026-11-11T00:00:00.000Z",
    payload: { anything: true },
    upstream_extra: "kept",
  };

  it("keeps unknown event kinds and extra upstream fields for diagnostics", () => {
    const parsed = EventEnvelope.parse(envelope);
    expect(parsed.event).toBe("some.future.event");
    expect((parsed as Record<string, unknown>).upstream_extra).toBe("kept");
  });

  it("rejects a wrong thread identity", () => {
    expect(() => EventEnvelope.parse({ ...envelope, thread_id: "prj_0123456789abcdef" })).toThrow();
  });

  it("rejects a non-numeric sequence", () => {
    expect(() => EventEnvelope.parse({ ...envelope, seq: "7" })).toThrow();
  });
});

describe("submission state", () => {
  const base = {
    operationKey: "cwc-op-0123456789",
    threadId: "thr_0123456789abcdef",
    turnId: null,
    status: "outcome_unknown" as const,
    submittedAt: "2026-11-11T00:00:00.000Z",
    reconciled: false,
  };

  it("treats outcome_unknown as non-terminal, never success", () => {
    const parsed = SubmissionState.parse(base);
    expect(parsed.status).toBe("outcome_unknown");
    expect(isTerminalSubmission(parsed.status)).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(() => SubmissionState.parse({ ...base, status: "probably_fine" })).toThrow();
  });
});

describe("usage evidence and errors", () => {
  const usage = {
    provider: "deepseek",
    model: "deepseek-flash",
    inputTokens: 10,
    outputTokens: 2,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    costState: "unknown" as const,
    source: "fixture" as const,
    capturedAt: "2026-11-11T00:00:00.000Z",
  };

  it("accepts unknown cost instead of coercing it to zero", () => {
    const parsed = UsageEvidence.parse(usage);
    expect(parsed.costUsd).toBeNull();
    expect(parsed.costState).toBe("unknown");
  });

  it("rejects a negative token count", () => {
    expect(() => UsageEvidence.parse({ ...usage, inputTokens: -1 })).toThrow();
  });

  it("rejects a lower-case error code", () => {
    expect(() => ErrorResult.parse({ code: "bad_code", message: "x", retryable: false })).toThrow();
  });
});

describe("effective profile", () => {
  it("requires effective identity, including permission posture", () => {
    const profile = {
      requested: { provider: "deepseek", model: "deepseek-flash" },
      effective: {
        provider: "deepseek",
        model: "deepseek-flash",
        permissionPosture: "full_access",
      },
      usedFallback: false,
      source: "configured" as const,
      engine: { version: "0.10.2", commit: "ff466b2ed0bf" },
    };
    expect(EffectiveProfile.parse(profile).effective.permissionPosture).toBe("full_access");
    expect(() =>
      EffectiveProfile.parse({
        ...profile,
        effective: { provider: "deepseek", model: "deepseek-flash" },
      }),
    ).toThrow();
  });
});
