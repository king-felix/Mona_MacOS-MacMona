import { describe, expect, it } from "vitest";
import { ErrorResult, EventEnvelope, UsageEvidence } from "../src/shared/contracts";
import { fixtures, FIXTURE_LABEL } from "../src/shared/fixtures";

const schemas = {
  event: EventEnvelope,
  usage: UsageEvidence,
  error: ErrorResult,
} as const;

describe("labeled fixtures", () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    if (name === "malformed") continue;
    it(`parses ${name}`, () => {
      const schema = schemas[fixture.schema];
      expect(() => schema.parse(fixture.data)).not.toThrow();
      expect(fixture.label).toBe(FIXTURE_LABEL);
    });
  }

  it("rejects the malformed fixture rather than tolerating it", () => {
    expect(() => EventEnvelope.parse(fixtures.malformed.data)).toThrow();
  });

  it("covers every required display state", () => {
    const names = Object.keys(fixtures);
    for (const required of [
      "connecting",
      "running",
      "completed",
      "interrupted",
      "unknownCost",
      "blocked",
      "unsupported",
      "malformed",
    ]) {
      expect(names).toContain(required);
    }
  });
});
