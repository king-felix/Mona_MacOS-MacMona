import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StateError } from "../src/main/state/errors";
import {
  MAX_SHELF_PROMPTS,
  MAX_SHELF_VERSIONS,
  PromptShelf,
  SHELF_SCOPE,
} from "../src/main/work/shelf";
import type { PromptPack, PromptPackPrompt } from "../src/shared/contracts/memory";
import { makeClock, openTestStore } from "./helpers/state";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digestOf(prompts: readonly PromptPackPrompt[]): string {
  const ordered = [...prompts].sort((left, right) => {
    const byLabel = left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
    if (byLabel !== 0) return byLabel;
    return left.body < right.body ? -1 : left.body > right.body ? 1 : 0;
  });
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

function emptyPrompt(overrides: Partial<PromptPackPrompt> = {}): PromptPackPrompt {
  return {
    label: "Sample",
    description: "",
    body: "Do the thing.",
    acceptance: [],
    tags: [],
    variables: [],
    ...overrides,
  };
}

function packOf(prompts: PromptPackPrompt[], name = "Test pack"): PromptPack {
  return {
    format: "mona-prompt-pack",
    format_version: 1,
    name,
    exported_at: "2026-11-12T00:00:00.000Z",
    digest_algorithm: "sha256",
    digest: digestOf(prompts),
    prompts,
  };
}

describe("prompt shelf", () => {
  it("creates version 1 and renders declared variables literally", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const saved = await shelf.save({
      label: "Review the diff",
      description: "Summarize a change without applying it.",
      body: "Summarize {{scope}} for {{audience}}.",
      acceptance: ["No file is changed"],
    });

    expect(saved.id).toBe("review-the-diff");
    expect(saved.currentVersion).toBe(1);
    expect(saved.versions).toHaveLength(1);
    expect(saved.versions[0]?.variables).toEqual(["scope", "audience"]);
    expect(saved.variables.map((variable) => variable.name)).toEqual(["scope", "audience"]);
    expect(saved.variables.every((variable) => variable.required)).toBe(true);
    expect(saved.versions[0]?.digest).toBe(
      createHash("sha256").update("Summarize {{scope}} for {{audience}}.").digest("hex"),
    );

    const rendered = await shelf.render({
      promptId: saved.id,
      values: { scope: "the change" },
    });
    expect(rendered.text).toBe("Summarize the change for {{audience}}.");
    expect(rendered.missing).toEqual(["audience"]);
    expect(rendered.unknown).toEqual([]);
    expect(rendered.acceptance).toEqual(["No file is changed"]);
    expect(rendered.bytes).toBe(Buffer.byteLength(rendered.text, "utf8"));
    expect(rendered.inert).toBe(true);
  });

  it("appends a version only when the text actually changed", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const created = await shelf.save({ label: "Triage", body: "Triage {{bug}}." });

    const updated = await shelf.save({
      id: created.id,
      label: "Triage",
      body: "Triage {{bug}} with {{owner}}.",
    });
    expect(updated.currentVersion).toBe(2);
    expect(updated.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(updated.variables.map((variable) => variable.name)).toEqual(["bug", "owner"]);

    const old = await shelf.render({
      promptId: created.id,
      version: 1,
      values: { bug: "flaky test" },
    });
    expect(old.version).toBe(1);
    expect(old.text).toBe("Triage flaky test.");
    expect(old.missing).toEqual([]);

    const identical = await shelf.save({
      id: created.id,
      label: "Triage",
      body: "Triage {{bug}} with {{owner}}.",
    });
    expect(identical.currentVersion).toBe(2);
    expect(identical.versions).toHaveLength(2);
  });

  it("reports unknown values and leaves non-variable brace runs verbatim", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const saved = await shelf.save({
      label: "Mixed tokens",
      body: "Use {{name}}, {{ name }}, {{Name}}, {{{x}}}, and {{a.b}}.",
    });
    expect(saved.variables.map((variable) => variable.name)).toEqual(["name"]);

    const rendered = await shelf.render({
      promptId: saved.id,
      values: { name: "Ada", Name: "nope", x: "nope" },
    });
    expect(rendered.text).toBe("Use Ada, Ada, {{Name}}, {{{x}}}, and {{a.b}}.");
    expect(rendered.unknown).toEqual(["Name", "x"]);
    expect(rendered.missing).toEqual([]);
  });

  it("refuses secret-shaped text without writing or echoing the value", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    // Built at run time so no literal key exists in the repository.
    const secret = "sk-" + "a".repeat(24);
    const before = await store.stateRevision();

    const error = await shelf
      .save({ label: "Leaky", description: "Ship it", body: `Run with ${secret}` })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StateError);
    const failure = error as StateError;
    expect(failure.code).toBe("INVALID_INPUT");
    expect(failure.details.classes).toEqual(["provider_key"]);
    expect(failure.message).not.toContain(secret);
    expect(JSON.stringify(failure.toJSON())).not.toContain(secret);
    expect(await store.stateRevision()).toBe(before);
    expect(await store.getSettings(SHELF_SCOPE)).toBeNull();
  });

  it("exports deterministically and imports identical text with a verified digest", async () => {
    const source = await openTestStore();
    const sourceShelf = new PromptShelf({ store: source.store, now: makeClock().now });
    await sourceShelf.save({
      label: "Audit",
      description: "Checks a diff.",
      body: "Audit {{target}} for {{risk}}.",
      acceptance: ["No file is changed", "The diff is quoted"],
      tags: ["review"],
    });
    const pack = await sourceShelf.exportPack();
    expect(pack.format).toBe("mona-prompt-pack");
    expect(pack.format_version).toBe(1);
    expect(pack.digest_algorithm).toBe("sha256");
    expect(pack.prompts).toHaveLength(1);
    expect(pack.digest).toBe(digestOf(pack.prompts));

    const fixed = (): Date => new Date("2026-11-12T00:00:00.000Z");
    const deterministic = new PromptShelf({ store: source.store, now: fixed });
    const first = await deterministic.exportPack();
    const second = await deterministic.exportPack();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const target = await openTestStore();
    const targetShelf = new PromptShelf({ store: target.store, now: makeClock().now });
    const imported = await targetShelf.importPack(pack);
    expect(imported.inert).toBe(true);
    expect(imported.packName).toBe("Mona prompt shelf");
    expect(imported.created).toEqual([{ label: "Audit", promptId: "audit" }]);
    expect(imported.skipped).toEqual([]);

    const [prompt] = (await targetShelf.view()).prompts;
    expect(prompt?.versions[0]?.body).toBe("Audit {{target}} for {{risk}}.");
    expect(prompt?.acceptance).toEqual(["No file is changed", "The diff is quoted"]);
    expect(prompt?.tags).toEqual(["review"]);

    const again = await targetShelf.importPack(pack);
    expect(again.created[0]?.promptId).toBe("audit-2");
    expect((await targetShelf.view()).prompts).toHaveLength(2);

    const tampered: PromptPack = {
      ...pack,
      prompts: [{ ...pack.prompts[0]!, body: "Audit nothing." }],
    };
    await expect(targetShelf.importPack(tampered)).rejects.toMatchObject({
      code: "IMPORT_DIGEST_MISMATCH",
    });
    expect((await targetShelf.view()).prompts).toHaveLength(2);
  });

  it("refuses foreign formats, non-objects, and oversized packs", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const empty = await shelf.exportPack();
    expect(empty.prompts).toEqual([]);

    const zip64 = Buffer.from([0x50, 0x4b, 0x06, 0x06, 0x2d, 0x00, 0x00, 0x00]);
    for (const value of [null, "PK\x03\x04", 42, [], zip64]) {
      await expect(shelf.importPack(value)).rejects.toMatchObject({ code: "IMPORT_INVALID" });
    }
    await expect(shelf.importPack({ ...empty, format: "not-mona" })).rejects.toMatchObject({
      code: "IMPORT_INVALID",
    });
    await expect(shelf.importPack({ ...empty, format_version: 2 })).rejects.toMatchObject({
      code: "IMPORT_INVALID",
    });
    const { prompts: _omitted, ...withoutPrompts } = empty;
    await expect(shelf.importPack(withoutPrompts)).rejects.toMatchObject({
      code: "IMPORT_INVALID",
    });
    await expect(
      shelf.importPack({
        ...empty,
        prompts: new Array(51).fill(emptyPrompt()),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_INVALID" });
  });

  it("reports limits and a note, and remove deletes without erroring twice", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const empty = await shelf.view();
    expect(empty.limits).toEqual({
      prompts: MAX_SHELF_PROMPTS,
      versionsPerPrompt: MAX_SHELF_VERSIONS,
      bodyBytes: 20_000,
    });
    expect(empty.storage).toEqual({ scope: SHELF_SCOPE, version: 0 });
    expect(empty.note.toLowerCase()).toContain("inert text");
    expect(empty.note.toLowerCase()).toContain("literally");
    expect(empty.note.toLowerCase()).toContain("call a model");

    const saved = await shelf.save({ label: "Delete me", body: "Do nothing." });
    const view = await shelf.view();
    expect(view.storage.version).toBeGreaterThan(0);
    expect(view.prompts.map((prompt) => prompt.id)).toEqual(["delete-me"]);

    expect(await shelf.remove(saved.id)).toEqual({ removed: true, id: saved.id });
    expect((await shelf.view()).prompts).toEqual([]);
    expect(await shelf.remove(saved.id)).toEqual({ removed: false, id: saved.id });
    expect((await shelf.view()).prompts).toEqual([]);
  });

  it("keeps version 1 while capping history at the newest 20 versions", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const created = await shelf.save({ label: "Version cap", body: "Body 1" });
    for (let index = 2; index <= 22; index += 1) {
      await shelf.save({ id: created.id, label: "Version cap", body: `Body ${index}` });
    }

    const [prompt] = (await shelf.view()).prompts;
    expect(prompt?.versions).toHaveLength(MAX_SHELF_VERSIONS);
    expect(prompt?.currentVersion).toBe(22);
    expect(prompt?.versions[0]?.version).toBe(1);
    expect(prompt?.versions.map((version) => version.version)).toEqual([
      1,
      ...Array.from({ length: 19 }, (_unused, index) => index + 4),
    ]);
    expect(prompt?.versions.at(-1)?.body).toBe("Body 22");
  });

  it("redacts stored home paths from the view projection", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({
      store,
      now: makeClock().now,
      homeDir: "/Users/example",
    });
    await shelf.save({
      label: "Home path",
      description: "Saved under /Users/example/work/mona.",
      body: "Read the notes.",
      acceptance: ["/Users/example/work/mona stays put"],
    });

    const [prompt] = (await shelf.view()).prompts;
    expect(prompt?.description).not.toContain("/Users/example");
    expect(prompt?.description).toContain("~");
    expect(prompt?.acceptance[0]).not.toContain("/Users/example");
  });

  it("shows an empty shelf with a reason when the stored value drifted", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    await store.putSettings(SHELF_SCOPE, { schema_version: 2, prompts: [] });

    const view = await shelf.view();
    expect(view.prompts).toEqual([]);
    expect(view.storage.version).toBe(1);
    expect(view.note).toContain("schema version 1");
    expect(view.note.toLowerCase()).toContain("untouched");
  });

  it("skips a pack prompt containing secret text and continues with the rest", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now, homeDir: "/Users/example" });
    const secret = "sk-" + "b".repeat(24);
    const leaky = emptyPrompt({ label: "Leaky", body: `Run with ${secret}` });
    const clean = emptyPrompt({
      label: "Clean",
      description: "Saved under /Users/example/notes.",
      body: "Keep the notes.",
    });
    const result = await shelf.importPack(packOf([leaky, clean]));

    expect(result.inert).toBe(true);
    expect(result.created).toEqual([{ label: "Clean", promptId: "clean" }]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.label).toBe("Leaky");
    expect(result.skipped[0]?.reason).toContain("provider_key");
    expect(result.skipped[0]?.reason).not.toContain(secret);
    expect(result.redactions).toBeGreaterThan(0);
    const [prompt] = (await shelf.view()).prompts;
    expect(prompt?.description).toContain("~");
  });

  it("rejects an oversized variable value and does not substitute unknown names", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const saved = await shelf.save({ label: "Bound", body: "Read {{note}}." });

    await expect(
      shelf.render({ promptId: saved.id, values: { note: "x".repeat(8_001) } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const rendered = await shelf.render({
      promptId: saved.id,
      values: { note: "ok", extra: "ignored" },
    });
    expect(rendered.text).toBe("Read ok.");
    expect(rendered.unknown).toEqual(["extra"]);
  });

  it("lands a metadata-only edit instead of silently dropping it", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now });
    const saved = await shelf.save({ label: "Meta", body: "Read {{note}}.", description: "first" });

    const edited = await shelf.save({
      id: saved.id,
      label: "Meta",
      body: "Read {{note}}.",
      description: "second",
    });
    expect(edited.description).toBe("second");
    // A description-only change is a real change, so it earns a version.
    expect(edited.currentVersion).toBe(2);

    // An equivalent save is not a change: tags are order-insensitive.
    const tagged = await shelf.save({
      id: saved.id,
      label: "Meta",
      body: "Read {{note}}.",
      description: "second",
      tags: ["b", "a"],
    });
    const again = await shelf.save({
      id: saved.id,
      label: "Meta",
      body: "Read {{note}}.",
      description: "second",
      tags: ["a", "b"],
    });
    expect(again.currentVersion).toBe(tagged.currentVersion);
  });

  it("redacts a body that reached the store some other way", async () => {
    const { store } = await openTestStore();
    const shelf = new PromptShelf({ store, now: makeClock().now, homeDir: "/Users/leaky" });
    // Simulate a restore from a settings backup: the value never passed `save`.
    const secret = "s" + "k-" + "z".repeat(24);
    await store.putSettings("prompts:shelf", {
      schema_version: 1,
      prompts: [
        {
          id: "restored-prompt",
          label: "Restored",
          description: "restored from a backup",
          currentVersion: 1,
          versions: [
            {
              version: 1,
              body: `Use ${secret} and /Users/leaky/work`,
              digest: "0".repeat(64),
              note: null,
              createdAt: "2026-11-12T00:00:00.000Z",
              variables: [],
              acceptance: [],
            },
          ],
          variables: [],
          acceptance: [],
          tags: [],
          updatedAt: "2026-11-12T00:00:00.000Z",
          redacted: false,
        },
      ],
    });

    const view = await shelf.view();
    const body = view.prompts[0]?.versions[0]?.body ?? "";
    expect(body).not.toContain(secret);
    expect(body).not.toContain("/Users/leaky");
    expect(view.prompts[0]?.redacted).toBe(true);
  });
});
