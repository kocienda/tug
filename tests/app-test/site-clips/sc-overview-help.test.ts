/**
 * sc-overview-help.test.ts — the site's help still: a question asked in the
 * Overview, the Operator's answer, and the help card its first citation opens.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and its
 * one assertion is that the still was written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both site
 * variables are set.
 *
 * The scene: the Overview on the left rail, holding one question and one
 * answer. The answer is not written for the picture. It is what
 * `tugcast operator-ask "How do I start an arc?"` answered on 2026-10-31, kept
 * verbatim with its refs, and it is published as the post a real answer arrives
 * as, because a capture has no business spending a model turn. The How Do I…
 * card stands in the slot beside the rail, seeded rather than opened by a citation
 * so it takes the slot, and scrolled to the recipe the answer cites.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { kindPane } from "../body-grounding/_kinds";
import { RUNS, launchForMode, outDirFor, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 120_000;
const OVERVIEW = "sc-help-overview";
const HELP = "sc-help-recipes";
const CONTENT_SIZE = { width: 1320, height: 900 };
const CARD = '[data-testid="overview-card"]';
const CHIP = `${CARD} [data-overview-ref-kind="help"]`;
const REQUEST = "sc-help-question";
const AT_MS = 1_793_500_000_000;

const QUESTION = "How do I start an arc?";
const ANSWER = [
  "Type `/arc` in a Session card, followed by whatever you have. The \"Create an arc\" recipe gives three forms:",
  "",
  "- `/arc make the ring pulse` opens on an idea in prose.",
  "- `/arc ring-pulse` opens on a name, and `/arc ring-pulse make it pulse` on a name and an instruction.",
  "- `/arc briefs/ring-pulse-brief.md` hands in a brief you already wrote.",
  "",
  "The model settles what is still open, decides whether the work earns a written plan, says which shape it chose and why, and hands the arc to the app. You will see the arc's name on the card and a **Wheel** divider in the transcript as its first stage starts. The arc takes its own branch and worktree, so your checkout is untouched.",
  "",
  "There is no New Arc button in the Arcs sidebar, no menu item and no chord; the one door is `/arc`. A row in the Arcs sidebar for documents that are already waiting offers **Start**, which runs those documents and opens nothing new. `/arc-bind <name>` with a new name makes only a bare arc, with a branch and a worktree but no brief and nothing driving it, so it is not how work is started.",
  "",
  "If you want a brief first, `/tugplug:brief` writes the settled conversation down as one (\"Write a brief\"). It opens no arc, and `/arc` will write the brief itself if you have not.",
].join("\n");
const REFS = ["recipes#create-an-arc", "recipes#write-a-brief", "features#opening-an-arc", "glossary#door"];

const POSTS = [
  { id: 9901, at_ms: AT_MS, author: "user", body: QUESTION, refs: [], request_id: REQUEST },
  { id: 9902, at_ms: AT_MS + 14_000, author: "operator", body: ANSWER, refs: REFS.map((target) => ({ kind: "help", target })), request_id: REQUEST, elapsed_ms: 14_000 },
];

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: OVERVIEW, componentId: "overview", title: "Overview", closable: true },
      { id: HELP, componentId: "help", title: "How do I…", closable: true },
    ],
    panes: [
      kindPane("overview", OVERVIEW, 1),
      { id: `${HELP}-pane`, position: { x: 40, y: 40 }, size: { width: 640, height: 480 }, cardIds: [HELP], activeCardId: HELP, title: "", acceptsFamilies: ["standard"], slot: 0 },
    ],
    activePaneId: `${HELP}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: { overview: { side: "left" } }, rails: { left: { order: ["overview"] } } },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site still: asking the Overview", () => {
  test(
    "captures a question, its answer and the recipe the answer cites",
    async () => {
      // An empty launch deck: the help card mounts from the seed below, with its
      // document, rather than from the restore (see `launchForMode`).
      const app = await launchForMode("sc-overview-help", { cards: [], panes: [], imposition: { sidebars: {} } }, undefined, { contentSize: CONTENT_SIZE });
      try {
        await app.seedDeckState({ state: deck(), cardStates: { [HELP]: { content: { doc: "recipes" } } }, focusCardId: HELP });
        const overview = app.body(OVERVIEW);
        await overview.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(CARD)}) !== null`, { timeoutMs: 20_000 });
        for (const post of POSTS) {
          expect(await overview.evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`), "the post landed").toBe(true);
        }
        await overview.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(CHIP)}) !== null`, { timeoutMs: 10_000 });
        await Bun.sleep(800);

        const help = app.body(HELP);
        await help.waitForCondition<boolean>(`document.querySelector('[data-slot="help-card"][data-help-doc="recipes"] h3') !== null`, { timeoutMs: 15_000 });
        await Bun.sleep(1_500);

        await help.evalJS<null>(`(function(){
          var heads = Array.from(document.querySelectorAll('[data-slot="help-card"] h3'));
          heads.find(function (h) { return (h.textContent || "").trim() === "Create an arc"; }).scrollIntoView({ block: "start" });
          return null;
        })()`);
        await Bun.sleep(500);
        const { scale } = await stillTo(app, { x: 0, y: 0, width: CONTENT_SIZE.width, height: CONTENT_SIZE.height }, join(outDirFor("overview-help"), "still.png"));
        expect(scale, "the still was taken").toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
