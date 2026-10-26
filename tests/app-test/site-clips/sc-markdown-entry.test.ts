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
import { RUNS, contentSize, cropAround, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";
import { bashTurnTranscript, bindStub, typeInto } from "./_components";

const TEST_TIMEOUT_MS = 120_000;
const CARD = "sc-md";
const OVERVIEW = "sc-md-overview";
/** The typing's pace: a word every this long. */
const WORD_MS = 80;
/** The pause after a Return before the next line's first word. */
const RETURN_MS = 120;
/** The pause between the session's last word and the press into the Overview, and from that press to its first word. */
const CROSS_MS = 900;
const FOCUS_MS = 300;
/** The loop holds this long past the last word. */
const TAIL_MS = 1_000;
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
        const entry = await app.elementRect(CARD, SESSION_ENTRY);
        expect(entry, "the session's entry is mounted").not.toBeNull();
        const composer = await app.elementRect(OVERVIEW, OVERVIEW_FIELD);
        expect(composer, "the Overview's composer is mounted").not.toBeNull();
        const roomAbove = (r: { x: number; y: number; width: number; height: number }) => ({ ...r, y: r.y - HEADROOM, height: r.height + HEADROOM });
        const crop = cropAround([roomAbove(entry!), roomAbove(composer!)], 16, await contentSize(app));

        const s = scene().at(500, () => body.nativeClickAtElement(SESSION_FIELD)).mark("loop-start");
        let t = 800;
        for (const [i, line] of SESSION_LINES.entries()) {
          if (i > 0) {
            s.at(t, () => app.nativeKey("Return"));
            t += RETURN_MS;
          }
          if (line !== "") t = typeInto(s, t, app, line, WORD_MS);
        }
        t += CROSS_MS;
        s.at(t, () => overview.nativeClickAtElement(OVERVIEW_CONTENT));
        t = typeInto(s, t + FOCUS_MS, app, OVERVIEW_LINE, WORD_MS);
        s.mark("loop-end", t + TAIL_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("markdown-entry"), crop }));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
