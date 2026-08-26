/**
 * at9998-probe.test.ts — scratch.
 * @covers tugdeck/src/components/lens/flow-strip.tsx
 */
import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const LENS_WIDTH = 420;
const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
function deckShape(count: number, cardWidth: number): Record<string, unknown> {
  const ids = ["A", "B", "C", "D", "E"].slice(0, count);
  return {
    cards: [...ids.map((id) => ({ id, componentId: "hello-world", title: id })), { id: "L", componentId: "lens", title: "Lens" }],
    panes: [
      ...ids.map((id, index) => ({ id: `p${index + 1}`, position: { x: 40, y: 40 }, size: { width: cardWidth, height: 400 }, cardIds: [id], activeCardId: id, title: "", acceptsFamilies: ["maker"], slot: index })),
      { id: "pLens", position: { x: 0, y: 0 }, size: { width: LENS_WIDTH, height: 900 }, cardIds: ["L"], activeCardId: "L", title: "Lens", acceptsFamilies: [] },
    ],
    activePaneId: "p2",
    imposition: { kind: ["one-up","two-up","three-up","four-up","five-up"][count - 1], layout: "flow", sidebars: { lens: { side: "right" } } },
    hasFocus: true,
  };
}
describe.skipIf(!SHOULD_RUN)("probe", () => {
  test("what a strip click does to the active pane", async () => {
    const app: App = await launchTugApp();
    try {
      await app.evalJS<null>(`(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`);
      await app.seedDeckState({ state: deckShape(5, 675), focusCardId: "B" });
      await app.waitForCondition<boolean>(`document.querySelector('[data-testid="flow-strip"]') !== null`, { timeoutMs: 8000 });
      await wait(1000);
      const before = await app.evalJS(`(function(){var s=window.tugdeck.diag.getDeckState();return {active:s.activePaneId, marked:document.querySelectorAll('[data-testid="flow-strip"] [data-state="filled"]').length};})()`);
      note(`before ${JSON.stringify(before)}`);
      await app.nativeClickAtElement(`[data-testid="flow-strip"] [aria-label="Go to slot 4"]`);
      await wait(900);
      const after = await app.evalJS(`(function(){var s=window.tugdeck.diag.getDeckState();return {active:s.activePaneId, offset:Math.round(s.flowOffset||0), marked:document.querySelectorAll('[data-testid="flow-strip"] [data-state="filled"]').length};})()`);
      note(`after ${JSON.stringify(after)}`);
      expect(true).toBe(true);
    } finally { await app.close(); }
  }, 180000);
});
