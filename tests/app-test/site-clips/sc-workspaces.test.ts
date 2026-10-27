/**
 * sc-workspaces.test.ts — the site's Workspaces clip: the Window menu cuts
 * from one workspace to another, each with its own deck and its own theme,
 * and back.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: two workspaces, each with the factory right rail up
 * (`_rails.ts`), so the Workspaces card names both and shows which is
 * current; the left rail is left down so the band has room for two Slim
 * cards under Fit without overlapping, in a window widened to hold them.
 * The cards are the site's placeholders (`_placeholders.ts`). "Site" is the
 * active one: the `picker-keys` Session card and `README.md` side by side, in the
 * mode's own theme. "Research" is parked, in a second theme of the same
 * mode chosen to differ at a glance (Galleon beside Ironclad, Pinnace beside
 * Sloop), and arranged so the cut cannot be missed: both slots split, the
 * four Harbor files in a two-by-two grid.
 * Before the burst the parked workspace is visited once so its cards stand
 * up. The burst performs Window ▸ Research, holds, and Window ▸ Site. The
 * whole content area is recorded, since a workspace is the whole window.
 *
 * @visible
 */

import { describe, test } from "bun:test";

import { kindPane } from "../body-grounding/_kinds";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { factoryRails, standUpRails } from "./_rails";
import { MODE, RUNS, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
/** Site's cards: the `picker-keys` Session card and a file, side by side. */
const SITE_CARDS = [
  { id: "sc-ws-a", session: "pickerKeys" },
  { id: "sc-ws-b", file: "README.md" },
] as const satisfies readonly Placeholder[];
/** Research's cards: the four Harbor files, two to each slot, both slots split. */
const RESEARCH_CARDS = [
  { id: "sc-ws-c", file: "notes.md" },
  { id: "sc-ws-d", file: "README.md" },
  { id: "sc-ws-e", file: "tides.ts" },
  { id: "sc-ws-f", file: "fetch_tides.py" },
] as const satisfies readonly Placeholder[];
const RESEARCH_SLOTS = [0, 0, 1, 1] as const;
const RESEARCH_SPACE = "5c11a000-0000-4000-8000-000000000002";
/** Each workspace's rail card ids, so no card stands in both decks. */
const SITE_RAILS = "sc-ws-site-rail";
const RESEARCH_RAILS = "sc-ws-research-rail";
/** The parked workspace's theme: a second theme of the mode being recorded. */
const RESEARCH_THEME: Record<"dark" | "light", string> = { dark: "galleon", light: "pinnace" };
/** The rail the scene keeps: Workspaces and Layout. */
const SIDES = ["right"] as const;
/** Wide enough that two Slim cards stand side by side in the band beside the right rail. */
const WINDOW = { width: 1900, height: 1051 };

/** Rest on Site, the hold on Research, and the settle back on Site. */
const REST_MS = 900;
const HOLD_MS = 2_200;
const SETTLE_MS = 1_800;

function deckOf(
  cards: readonly Placeholder[],
  slots: readonly number[],
  kind: string,
  railPrefix: string,
  columns: Record<number, { mode: "split" }> = {},
): Record<string, unknown> {
  const rails = factoryRails(railPrefix, SIDES);
  return {
    cards: [...cards.map(placeholderCard), ...rails.cards],
    panes: [...cards.map((p, i) => kindPane("session" in p ? "session" : "text", p.id, slots[i]!)), ...rails.panes],
    activePaneId: `${cards[0]!.id}-pane`,
    imposition: { kind, layout: "fit", contentWidth: "slim", sidebars: rails.sidebars, rails: rails.rails, columns },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: workspaces", () => {
  test(
    "records the Window menu switching to a second workspace and back",
    async () => {
      const site = deckOf(SITE_CARDS, [0, 1], "two-up", SITE_RAILS);
      const research = deckOf(RESEARCH_CARDS, RESEARCH_SLOTS, "two-up", RESEARCH_RAILS, { 0: { mode: "split" }, 1: { mode: "split" } });
      const app = await launchForMode("sc-workspaces", site, undefined, {
        contentSize: WINDOW,
        spaces: [{ id: RESEARCH_SPACE, name: "Research", theme: RESEARCH_THEME[MODE!], deck: research }],
        cardStates: placeholderStates([...SITE_CARDS, ...RESEARCH_CARDS]),
        settings: placeholderSettings(),
      });
      try {
        await standUpRails(app, SITE_RAILS, SIDES);
        // Visit the parked workspace once so its cards are standing when the
        // burst cuts to it, then come back to rest on Site. The Session card
        // is bound last, so its name reaches every rail standing by then.
        await app.performMenuItem("window.space.1");
        await standUpRails(app, RESEARCH_RAILS, SIDES);
        await standUpPlaceholders(app, RESEARCH_CARDS);
        await Bun.sleep(600);
        await app.performMenuItem("window.space.0");
        await standUpPlaceholders(app, SITE_CARDS);
        await Bun.sleep(1_500);

        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => app.performMenuItem("window.space.1"))
          .at(REST_MS + HOLD_MS, () => app.performMenuItem("window.space.0"))
          .mark("loop-end", REST_MS + HOLD_MS + SETTLE_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("workspaces") }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
