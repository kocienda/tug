/**
 * sc-markdown-entry.test.ts — the site's markdown-entry clip: a prompt typed
 * into a Session card's entry and a question typed into the Overview's, both
 * styling their markdown as the words land.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: one Session card under Flow, bound to a stub it never prompts,
 * with the Overview on the right rail. The driver types a heading, a sentence
 * with bold, code and italics, and two task-list lines into the session's
 * entry, a word at a time, and then one question with code and bold into
 * the Overview's composer. Nothing is sent. The crop is the band at the
 * bottom of the window that holds both fields.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { kindPane, kindSidebars } from "../body-grounding/_kinds";
import { stubDirectory } from "../streaming-stub-fixture";
import { rectIn } from "../one-view-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor } from "./_site-clips";
import { bashTurnTranscript, bindStub, inWindow, typeSlowly } from "./_components";

const TEST_TIMEOUT_MS = 120_000;
const CARD = "sc-md";
const OVERVIEW = "sc-md-overview";
const BURST_MS = 9_600;
/** The window: the session's flow pane, the right rail, and little canvas between. */
const CONTENT_SIZE = { width: 1160, height: 900 };
const SESSION_ENTRY = '[data-slot="tug-prompt-entry"]';
const SESSION_FIELD = `${SESSION_ENTRY} [data-slot="tug-text-editor"] .cm-content`;
const OVERVIEW_FIELD = '[data-testid="overview-composer-field"]';
const OVERVIEW_CONTENT = `${OVERVIEW_FIELD} .cm-content`;
/** Room above the fields for the lines the prompt grows by. */
const HEADROOM = 100;

const SESSION_LINES = [
  "## Next up",
  "",
  "Make the **hero** static, keep `Clip.astro` lazy, and never serve a *stale* thumbnail.",
  "- [x] crop the frames",
  "- [ ] encode at crf 18",
];
const OVERVIEW_LINE = "Which sessions touched `index.astro` **today**, and what did each one change?";

/** The session in the flow band, the Overview on the right rail. */
function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: CARD, componentId: "session", title: "Session", closable: true },
      { id: OVERVIEW, componentId: "overview", title: "Overview", closable: true },
    ],
    panes: [kindPane("session", CARD, 0), kindPane("overview", OVERVIEW, 1)],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "three-up", layout: "flow", sidebars: kindSidebars(["overview"]), rails: { right: { order: ["overview"] } } },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: markdown entry", () => {
  test(
    "records markdown styling itself in the session entry and the Overview composer",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-markdown-entry", deck(), stubDir, { contentSize: CONTENT_SIZE });
      try {
        await bindStub(app, CARD, stubDir, bashTurnTranscript(), "sc-md-");
        const overview = app.body(OVERVIEW);
        await overview.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(OVERVIEW_FIELD)}) !== null`, { timeoutMs: 20_000 });
        await Bun.sleep(1_000);

        const body = app.body(CARD);
        const bodies = await app.bodies();
        const sessionView = bodies.find((b) => b.cardId === CARD)!.frame;
        const overviewView = bodies.find((b) => b.cardId === OVERVIEW)!.frame;
        const entry = await rectIn(body, SESSION_ENTRY);
        expect(entry, "the session's entry is mounted").not.toBeNull();
        const composer = await rectIn(overview, OVERVIEW_FIELD);
        expect(composer, "the Overview's composer is mounted").not.toBeNull();
        const e = inWindow(sessionView, entry!);
        const c = inWindow(overviewView, composer!);
        const crop = cropAround([{ ...e, y: e.y - HEADROOM, height: e.height + HEADROOM }, { ...c, y: c.y - HEADROOM, height: c.height + HEADROOM }], 16, await contentSize(app));

        const reading = await burstTo(app, crop, BURST_MS, outDirFor("markdown-entry"), async () => {
          await Bun.sleep(500);
          await body.nativeClickAtElement(SESSION_FIELD);
          await Bun.sleep(300);
          for (let i = 0; i < SESSION_LINES.length; i++) {
            if (i > 0) {
              await app.nativeKey("Return");
              await Bun.sleep(120);
            }
            if (SESSION_LINES[i] !== "") await typeSlowly(app, SESSION_LINES[i]!, 80);
          }
          await Bun.sleep(900);
          await overview.nativeClickAtElement(OVERVIEW_CONTENT);
          await Bun.sleep(300);
          await typeSlowly(app, OVERVIEW_LINE, 80);
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
