// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StudioScreen } from "../src/renderer/shell/Studio";
import { studioDetail, studioSnapshot } from "./helpers/studio-fixtures";
let root: Root;
let host: HTMLElement;
const noop = () => undefined;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
it.each([false, true])(
  "has no serious/critical axe violations in the real Studio (focus=%s)",
  async (focus) => {
    await act(async () =>
      root.render(
        <StudioScreen
          detail={studioDetail()}
          studio={studioSnapshot()}
          studioBusy={false}
          mode="work"
          draft="Draft"
          draftStatus="saved"
          inspectorTab="task"
          onInspectorTab={noop}
          focusMode={focus}
          favorites={[]}
          onToggleFocus={noop}
          onUseFavorite={noop}
          onRequestSaveFavorite={noop}
          onRemoveFavorite={noop}
          onDraft={noop}
          onMode={noop}
          onOpenFolder={noop}
          onShowBoard={noop}
          onOpenPalette={noop}
          onStart={noop}
          onSubmit={noop}
          onInterrupt={noop}
          onPause={noop}
          onResumeQueue={noop}
          onCancelQueued={noop}
          onStop={noop}
          onReconcile={noop}
        />,
      ),
    );
    const audit = async () => {
      // Pixel contrast is checked by token tests and the native visual gate;
      // jsdom has no layout/canvas and cannot validate rendered color contrast.
      const result = await axe.run(host, { rules: { "color-contrast": { enabled: false } } });
      expect(
        result.violations
          .filter((v) => v.impact === "critical" || v.impact === "serious")
          .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) })),
      ).toEqual([]);
    };
    await audit();
    act(() => {
      host.querySelector<HTMLDetailsElement>(".focus-bar__more")!.open = true;
    });
    await audit();
  },
);
