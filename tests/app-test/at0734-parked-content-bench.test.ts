/**
 * at0734-parked-content-bench.test.ts — a parked pane's content is out of
 * the render tree, and the bench that decided it.
 *
 * A parked workspace and a hidden rail's members stay mounted so a reveal
 * mounts nothing, and their frames keep their boxes so every sweep finds
 * them standing where the reveal will. What is inside those frames is the
 * half of the deck nobody is looking at, and `content-visibility: hidden`
 * on this engine skips its paint and hit-testing but not its layout: a
 * forced layout over the whole document laid the parked content out every
 * time, a fifth of a 100 ms layout on the user's deck. So the content is
 * `display: none` while it is parked (`space-layer.css`), and `CardHost`
 * puts back each scroller's offset at the reveal.
 *
 * This file stands the shapes up and reads them with the instrument that
 * priced them, `tugtool deck motion walk` with its parked arms, each of
 * which times a forced layout (a hidden fixed element's width, and an
 * inherited `word-spacing` on `body` that lays out every text box on the
 * document) against a paired baseline:
 *
 *  - **The deck.** Workspace two holds two session cards bound to real
 *    transcripts and an Overview in a rail, filled with posts; workspace one
 *    holds a Text card and a Layout rail. Two is visited first and bound,
 *    then one is shown and its rails hidden, so the shown workspace carries a
 *    parked rail and the deck carries a parked workspace.
 *  - **The switch's lead**, two to the parked workspace and back, read with
 *    the instruments off and noted: the reveal rebuilds the content's boxes
 *    inside the switch's set-up, which is a budget, recorded beside the bar.
 *  - **The bench.** `parked-absent` (the wrappers removed: the upper bound),
 *    `parked-content-hidden` and `rail-parked-content-hidden` (the content
 *    rules, written inline). With the rules shipped, the as-is baseline
 *    already carries them, so each content arm's forced-layout saving is
 *    the share the rule did not take, and `parked-absent`'s is the frames'
 *    own boxes. Noted, not asserted: a timing on a harness deck is a reading.
 *
 * Asserted, because each is a fact rather than a timing: the walk left the
 * deck as it found it (its closing restore found nothing and every scroll
 * came back); both content arms found a subject, so the readings are of
 * something; and every parked content box computes `display: none`, which is
 * the rule reaching the DOM it was written for.
 *
 * The verb is the bundle's own `tugtool`, built from this tree with the app.
 *
 * @motion
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_walk.js
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_walk.rs
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { DEFAULT_OVERVIEW_WIDTH_PX } from "../../tugdeck/src/lib/overview-measure";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  flowDeck,
  launch,
  transcriptArms,
  wait,
} from "./settle-frames-fixture";

const TEST_NAME = "at0734-parked-content-bench";
const ARMS = transcriptArms();

/** The workspace that is parked for the bench, and the one shown over it. */
const PARKED_SPACE = "at0734-two";
const SHOWN_SPACE = "at0734-one";

/** Overview posts in the parked workspace, so its column is a real subject. */
const POSTS = 60;

const WALK_ARMS = "parked-absent,parked-content-hidden,rail-parked-content-hidden";
const WALK_ROUNDS = 3;
const WALK_FRAMES = 20;

/** Named `TEST_TIMEOUT_MS` because the recipe's wedge cap reads that declaration. */
const TEST_TIMEOUT_MS = 600_000;
const VERB_TIMEOUT_MS = 240_000;

const PARKED_CONTENT = ".tug-space-layer:not([data-space-shown]) .tug-pane-content";

/**
 * Two workspaces. The parked one is `flowDeck(2)` with an Overview rail on
 * the left — the shape the user's deck parks — and it is the active one at
 * launch, so the fixture binds its session cards. The other is a Text card
 * and a Layout rail, whose rail is hidden once it is shown.
 */
function benchBlob(): Record<string, unknown> {
  const deck = flowDeck(2);
  const cards = deck.cards as Record<string, unknown>[];
  const panes = deck.panes as Record<string, unknown>[];
  const imposition = deck.imposition as Record<string, unknown>;
  return {
    version: 5,
    activeSpaceId: PARKED_SPACE,
    spaces: [
      {
        id: PARKED_SPACE,
        name: "Two",
        deck: {
          ...deck,
          cards: [...cards, { id: "at0734-o1", componentId: "overview", title: "Overview", closable: true }],
          panes: [
            ...panes,
            {
              id: "at0734-po1",
              position: { x: 0, y: 0 },
              size: { width: DEFAULT_OVERVIEW_WIDTH_PX, height: 900 },
              cardIds: ["at0734-o1"],
              activeCardId: "at0734-o1",
              title: "Overview",
              acceptsFamilies: [] as string[],
            },
          ],
          imposition: {
            ...imposition,
            sidebars: { layout: { side: "right" }, overview: { side: "left" } },
          },
        },
      },
      {
        id: SHOWN_SPACE,
        name: "One",
        deck: {
          cards: [
            { id: "at0734-t1", componentId: "text", title: "Text", closable: true },
            { id: "at0734-l1", componentId: "layout", title: "Layout", closable: true },
          ],
          panes: [
            {
              id: "at0734-pt1",
              position: { x: 60, y: 40 },
              size: { width: 700, height: 480 },
              cardIds: ["at0734-t1"],
              activeCardId: "at0734-t1",
              title: "",
              acceptsFamilies: ["standard"],
            },
            {
              id: "at0734-pl1",
              position: { x: 0, y: 0 },
              size: { width: 420, height: 900 },
              cardIds: ["at0734-l1"],
              activeCardId: "at0734-l1",
              title: "Layout",
              acceptsFamilies: [] as string[],
            },
          ],
          activePaneId: "at0734-pt1",
          imposition: { kind: "one-up", sidebars: { layout: { side: "right" } } },
          hasFocus: true,
        },
      },
    ],
  };
}

/** The bundle's own `tugtool`, beside the app binary the harness launched. */
function tugtoolPath(): string {
  const app = process.env.TUGAPP_DEBUG_PATH;
  if (app === undefined || app === "") {
    throw new Error("TUGAPP_DEBUG_PATH is unset; run this file through `just app-test`");
  }
  return join(dirname(app), "tugtool");
}

async function portOf(app: App): Promise<string> {
  const port = await app.evalJS<string>("location.port");
  if (!/^\d+$/.test(port)) throw new Error(`the page reports no tugcast port: '${port}'`);
  return port;
}

function deckMotion(
  port: string,
  args: string[],
): { exit: number; json: Record<string, unknown> | null; stderr: string } {
  const run = Bun.spawnSync([tugtoolPath(), "deck", "motion", ...args, "--port", port, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: VERB_TIMEOUT_MS,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(run.stdout.toString()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { exit: run.exitCode ?? -1, json, stderr: run.stderr.toString() };
}

/** One `evalJS` per post: thirty in one script never got the harness's reply (at0365). */
async function publishPosts(app: App, count: number): Promise<void> {
  let accepted = 0;
  for (let i = 0; i < count; i += 1) {
    const post = JSON.stringify({
      id: 20_000 + i,
      at_ms: 1_754_600_000_000 + i * 60_000,
      author: i % 2 === 0 ? "observer" : "operator",
      body:
        `Post ${i + 1}: the parked workspace holds this column while another is shown.\n\n` +
        "Its frames keep their boxes so the reveal finds them standing; what is inside them " +
        "has none while it is parked, and comes back at the reveal with the reader's place.",
      refs: [],
      project_dir: "/tmp",
    });
    if (await app.evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(post)})`)) accepted += 1;
  }
  expect(accepted, "every post accepted").toBe(count);
}

async function activate(app: App, spaceId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId)}`,
    { timeoutMs: 20_000 },
  );
  await wait(AFTER_LAND_MS);
}

interface ArmStats {
  readonly deltas: number[];
  readonly median: number;
  readonly moved: boolean;
}

interface WalkArmReading {
  readonly arm: string;
  readonly subjects: number;
  readonly removed: Record<string, number>;
  readonly byMean: ArmStats;
  readonly forced?: {
    readonly baselineFixed: number;
    readonly baselineInherited: number;
    readonly fixed: ArmStats;
    readonly inherited: ArmStats;
  };
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0734 — a parked pane's content is out of the render tree [${arm.size}]`,
  () => {
    test(
      "the parked bench reads its arms, leaves the deck as found, and the content rule reaches the DOM",
      async () => {
        const { app, tugbankPath } = await launch(2, benchBlob(), TEST_NAME, {
          transcripts: arm.size,
        });
        try {
          await publishPosts(app, POSTS);
          await wait(AFTER_LAND_MS);

          // The first visit to workspace one mounts it; two is parked from here.
          await activate(app, SHOWN_SPACE);
          await app.dispatchControlAction("toggle-sidebars");
          await app.waitForCondition<boolean>(
            `document.querySelector('.tug-space-layer[data-space-shown] .tug-pane[data-rail-parked]') !== null`,
            { timeoutMs: 20_000 },
          );
          await wait(AFTER_LAND_MS * 2);

          const port = await portOf(app);
          const enable = deckMotion(port, ["enable"]);
          expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

          // The switch's lead: to the parked workspace and back, quiet.
          const switched = deckMotion(port, [
            "settle",
            "--gesture",
            "switch",
            "--space",
            PARKED_SPACE,
            "--count",
            "2",
            "--quiet-instruments",
          ]);
          expect(switched.exit, `settle switch exited ${switched.exit}: ${switched.stderr} ${JSON.stringify(switched.json)}`).toBe(0);
          const switchReadings = ((switched.json?.data as { readings?: unknown[] } | undefined)?.readings ?? []) as {
            gesture?: string;
            lead_ms?: number | null;
            longest_gap_ms?: number | null;
          }[];
          note(
            `at0734 [${arm.size}] switch (quiet): ` +
              switchReadings
                .map((r, i) => `#${i + 1} lead ${r.lead_ms?.toFixed(1) ?? "—"} ms, longest gap ${r.longest_gap_ms?.toFixed(1) ?? "—"} ms`)
                .join("; "),
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SHOWN_SPACE)}`,
            { timeoutMs: 20_000 },
          );
          await wait(AFTER_LAND_MS * 2);

          // The heap with the parked workspace standing: WebContent's resident
          // size and the GC's share of a rest window, beside the walk's
          // prices, so the content rule's memory side is read too.
          const heap = deckMotion(port, ["rest", "--window", "1000", "--frame-phases"]);
          expect(heap.exit, `rest --frame-phases exited ${heap.exit}: ${heap.stderr}`).toBe(0);
          const heapPhases = (heap.json?.data as { frame_phases?: { samples: number; rss_kb: number | null; phases: Record<string, { engine: number; forced: number }> } } | undefined)
            ?.frame_phases;
          note(
            `at0734 [${arm.size}] heap with the workspace parked: WebContent RSS ` +
              `${heapPhases?.rss_kb == null ? "—" : `${Math.round(heapPhases.rss_kb / 1024)} MB`}, ` +
              `gc ${(heapPhases?.phases.gc?.engine ?? 0) + (heapPhases?.phases.gc?.forced ?? 0)} of ${heapPhases?.samples ?? 0} busy sample(s)`,
          );

          const walk = deckMotion(port, [
            "walk",
            "--arms",
            WALK_ARMS,
            "--rounds",
            String(WALK_ROUNDS),
            "--frames",
            String(WALK_FRAMES),
          ]);
          deckMotion(port, ["disable"]);
          expect(walk.exit, `walk exited ${walk.exit}: ${walk.stderr} ${JSON.stringify(walk.json)}`).toBe(0);
          const data = (walk.json?.data ?? null) as {
            census?: { document?: unknown; subjects?: Record<string, unknown> };
            baseline?: Record<string, number>;
            arms?: WalkArmReading[];
            scrollMismatches?: unknown[];
          } | null;
          expect(data?.census, "the walk carries a census").toBeTruthy();
          note(
            `at0734 [${arm.size}] census: document ${JSON.stringify(data!.census!.document)}, ` +
              `parked ${JSON.stringify(data!.census!.subjects?.parked ?? null)}, ` +
              `rail-parked ${JSON.stringify(data!.census!.subjects?.railParked ?? null)}`,
          );
          note(`at0734 [${arm.size}] walk baseline: ${JSON.stringify(data!.baseline)}`);
          const arms = data!.arms ?? [];
          for (const a of arms) {
            const f = a.forced;
            note(
              `at0734 [${arm.size}] ${a.arm}: subjects ${a.subjects}, removed ${JSON.stringify(a.removed)}, ` +
                `walk saved by mean ${a.byMean.median.toFixed(2)} ms; ` +
                (f === undefined
                  ? "no forced-layout reading"
                  : `forced layout saved by mean: fixed ${f.fixed.median.toFixed(2)} of ${f.baselineFixed.toFixed(2)} ms ` +
                    `(${f.fixed.deltas.map((d) => d.toFixed(1)).join(", ")}), ` +
                    `inherited ${f.inherited.median.toFixed(2)} of ${f.baselineInherited.toFixed(2)} ms ` +
                    `(${f.inherited.deltas.map((d) => d.toFixed(1)).join(", ")})`),
            );
          }
          expect(data!.scrollMismatches ?? [], "every scroll came back").toEqual([]);
          const subjectsOf = (name: string): number => arms.find((a) => a.arm === name)?.subjects ?? 0;
          expect(subjectsOf("parked-content-hidden"), "the parked workspace has content to read").toBeGreaterThan(0);
          expect(subjectsOf("rail-parked-content-hidden"), "the hidden rail has content to read").toBeGreaterThan(0);

          const displays = await app.evalJS<string[]>(
            `Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(PARKED_CONTENT)}), function (el) {
               return getComputedStyle(el).display;
             })`,
          );
          note(`at0734 [${arm.size}] parked content displays: ${JSON.stringify(displays)}`);
          expect(displays.length, "the parked workspace has pane content").toBeGreaterThan(0);
          expect(displays.filter((d) => d !== "none"), "every parked pane's content is out of the render tree").toEqual([]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
