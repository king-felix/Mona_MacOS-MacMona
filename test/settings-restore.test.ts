import { describe, expect, it } from "vitest";
import { openTestStore } from "./helpers/state";

/**
 * The settings restore contract at the store layer. P19's handoff workbench
 * calls this; these tests pin the guarantees the barrier is supposed to carry,
 * including the ones a caller-side check cannot provide.
 */
describe("settings restore", () => {
  it("refuses a stale revision and leaves the state untouched", async () => {
    const { store } = await openTestStore();
    await store.putSettings("app:theme", { name: "daybreak" });
    const revision = await store.stateRevision();

    await expect(
      store.restoreSettings([{ scope: "app:theme", value: { name: "afterglow" } }], {
        expectedRevision: revision + 10,
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    expect(await store.stateRevision()).toBe(revision);
    expect((await store.getSettings("app:theme"))?.value).toEqual({ name: "daybreak" });
  });

  it("writes a journal and a snapshot, and reads every scope back", async () => {
    const { store } = await openTestStore();
    await store.putSettings("app:theme", { name: "daybreak" });
    const receipt = await store.restoreSettings([
      { scope: "app:theme", value: { name: "afterglow" } },
      { scope: "app:density", value: { name: "compact" } },
    ]);

    expect(receipt.applied).toHaveLength(2);
    expect(receipt.applied.find((entry) => entry.scope === "app:theme")?.fromVersion).toBe(1);
    expect(receipt.verification).toContain("2 scope(s) read back identical");
    expect(receipt.journal).toMatch(/settings-restore-journal-.*\.json$/);
    expect(receipt.snapshot).toMatch(/settings-restore-snapshot-.*\.sqlite$/);
    expect(store.barrier.snapshot().maintenance).toBe(false);
    // The previous value survives in version history, so a restore is inspectable.
    const versions = await store.listSettingsVersions("app:theme");
    expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
  });

  it("preserves a named scope through a replace and resets the rest", async () => {
    const { store } = await openTestStore();
    await store.putSettings("keep:me", { value: 1 });
    await store.putSettings("drop:me", { value: 2 });

    const receipt = await store.restoreSettings([{ scope: "only:this", value: { value: 3 } }], {
      mode: "replace",
      preserveScopes: ["keep:me"],
    });

    expect(receipt.reset).toEqual(["drop:me"]);
    expect(await store.getSettings("keep:me")).not.toBeNull();
    expect(await store.getSettings("only:this")).not.toBeNull();
    expect(await store.getSettings("drop:me")).toBeNull();
  });

  it("completes a concurrent writer without losing either write", async () => {
    const { store } = await openTestStore();
    const pendingWrite = store.putSettings("concurrent:scope", { touched: true });
    const restore = store.restoreSettings([{ scope: "restored:scope", value: { ok: true } }]);
    const [written] = await Promise.all([pendingWrite, restore]);

    // The barrier's exclusivity is exercised in `state-portable`; this pins the
    // observable contract for a caller: neither write is lost or blocked
    // forever, and the barrier is released afterwards.
    expect(written.scope).toBe("concurrent:scope");
    expect(await store.getSettings("restored:scope")).not.toBeNull();
    expect(await store.getSettings("concurrent:scope")).not.toBeNull();
    expect(store.barrier.snapshot().maintenance).toBe(false);
  });

  it("refuses a backup that repeats a scope", async () => {
    const { store } = await openTestStore();
    await expect(
      store.restoreSettings([
        { scope: "app:theme", value: { a: 1 } },
        { scope: "app:theme", value: { a: 2 } },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
