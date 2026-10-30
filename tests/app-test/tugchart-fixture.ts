/**
 * tugchart-fixture.ts — a streamed turn whose messages each carry one
 * ` ```tugchart ` fence, drawn from tugcast's renders, with the chart
 * figures on screen.
 *
 * Shared by the `at0765-*` files: each launches one session card bound to
 * a stub tugcode, streams one message per spec through
 * `streaming-stub-fixture.ts` as `at0730` does, waits for the turn to end,
 * then waits for every chart on the page to reach a terminal state —
 * `rendered` or `invalid`. The engine has a 10 s horizon and the faces 3 s,
 * so the chart wait allows for both on a cold page.
 */

import { blobFor, launch } from "./settle-frames-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, bindStreamingStubs, startStreams, stubDirectory } from "./streaming-stub-fixture";

type Launched = Awaited<ReturnType<typeof launch>>;
export type ChartPage = ReturnType<Launched["app"]["body"]>;

/** The one session card `blobFor(1)` seats. */
export const CARD = "at0622-c1";

/** Every chart figure in the card's page. */
export const CHART = `[data-card-id="${CARD}"] .tugx-chart`;

/** How long the turn may take to stream and end. */
const TURN_MS = 60_000;

/** Engine load (10 s horizon) plus faces (3 s) plus the compile, on a cold page. */
const CHARTS_MS = 16_000;

/** The bar golden: one series, a zero and a gap, integer format. */
export const BAR_SPEC = {
  tugchart: 1,
  form: "bar",
  title: "Commits per day",
  subtitle: "main, last week",
  unit: "commits",
  format: "int",
  categories: ["10-21", "10-22", "10-23", "10-24", "10-25", "10-26", "10-27"],
  series: [{ name: "commits", values: [4, 7, 0, 12, 3, null, 9] }],
};

/** A spec the validator refuses: `pie` is not a form. */
export const INVALID_SPEC = { tugchart: 1, form: "pie", title: "Share of runs" };

/** One message's markdown: a line of prose and a closed chart fence. */
export function chartMessage(spec: unknown, index: number): string {
  return [
    `Pass ${index + 1} measured the week and drew it.`,
    "",
    "```tugchart",
    JSON.stringify(spec, null, 2),
    "```",
    "",
  ].join("\n");
}

/**
 * Launch the card, stream one message per spec, and wait until the turn has
 * ended and every chart on the page is `rendered` or `invalid`.
 */
export async function launchWithCharts(
  testName: string,
  specs: readonly unknown[],
): Promise<{ app: Launched["app"]; tugbankPath: string; page: ChartPage }> {
  const stubDir = stubDirectory();
  const { app, tugbankPath } = await launch(1, blobFor(1), testName, {
    resumeCards: [],
    env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
  });
  const stubs = await bindStreamingStubs(app, [CARD], stubDir, specs.length, 1, (i) => chartMessage(specs[i], i));
  await startStreams(app, stubs);
  const page = app.body(CARD);
  await page.waitForCondition<boolean>(
    `(function(){
      var entry = document.querySelector('[data-card-id="${CARD}"] [data-slot="tug-prompt-entry"]');
      return entry !== null && entry.getAttribute("data-phase") !== "streaming";
    })()`,
    { timeoutMs: TURN_MS },
  );
  await waitForCharts(page, specs.length);
  return { app, tugbankPath, page };
}

/** Wait until `count` charts in the card's page are `rendered` or `invalid`. */
export async function waitForCharts(page: ChartPage, count: number): Promise<void> {
  await page.waitForCondition<boolean>(
    `(function(){
      var done = Array.from(document.querySelectorAll(${JSON.stringify(CHART)})).filter(function (c) {
        var s = c.getAttribute("data-tugx-chart-state");
        return s === "rendered" || s === "invalid";
      });
      return done.length === ${count};
    })()`,
    { timeoutMs: CHARTS_MS },
  );
}
