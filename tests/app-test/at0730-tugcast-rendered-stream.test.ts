/**
 * at0730-tugcast-rendered-stream.test.ts — a streamed turn drawn from
 * tugcast's renders, with no parse on the page.
 *
 * tugcast renders every live session's assistant text natively and ships the
 * changed blocks on `RENDERED`; the ingest engine writes each Message's
 * render into its `.rendered` path, and the row draws from it. This file
 * streams one stubbed turn (`streaming-stub-fixture.ts`) whose messages carry
 * a heading, prose with inline math, a list and a fenced block, and holds the
 * three things that make the move honest:
 *
 *  - No row of the turn parsed on the page, from its first delta through its
 *    end: the turn's rows draw from tugcast's records alone.
 *  - Each finished row holds a current record, and every block on screen
 *    carries the hash the page's own parse computes for the same text — the
 *    same `tugmark` crate on both sides.
 *  - Each row's text on screen equals what the page's own parse of the same
 *    text renders, read through `renderedRows`, which renders it into a
 *    detached element.
 *  - The `ts` fence arrives highlighted by tugcast: its `<code>` is stamped
 *    `data-tug-highlighted` and carries the shared `tug-syn-*` slot classes,
 *    so the page ran no highlighter of its own over it.
 *
 * @covers tugdeck/src/lib/code-session-store/session-engine.ts
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/ingest/ingest-host.ts
 * @covers tugdeck/src/lib/ingest/session-link.ts
 * @covers tugdeck/src/lib/ingest/session-patch.ts
 * @covers tugdeck/src/lib/ingest/rendered-merge.ts
 * @covers tugdeck/src/lib/ingest/text-hash.ts
 * @covers tugdeck/src/lib/markdown/rendered-record.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/lib/markdown/enhance-fenced-code.ts
 * @covers tugdeck/crates/tugmark/src/highlight.rs
 * @covers tugdeck/src/test-surface.ts
 * @covers tugrust/crates/tugcast/src/feeds/render_bridge.rs
 * @covers tugrust/crates/tugcast/src/feeds/render_stage.rs
 * @covers tests/app-test/streaming-stub-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN, blobFor, launch } from "./settle-frames-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, bindStreamingStubs, startStreams, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0730-tugcast-rendered-stream";
const CARD = "at0622-c1";

/** Messages in the streamed turn. */
const MESSAGES = 2;

/** How long the turn may take to stream and end: a few seconds at the stub's cadence. */
const TURN_MS = 60_000;

/** Past both of the engine's finishers, so a late `null` would have landed. */
const AFTER_TURN_MS = 1_000;

/** One message's markdown: every construct the row has to draw. */
function messageText(index: number): string {
  const n = index + 1;
  return [
    `## Pass ${n}: the measured shape`,
    "",
    `The reader timed pass ${n} at $O(n \\log n)$ and found the bound holds ` +
      "across every recorded run, with no outlier worth a second look.",
    "",
    "- The cached branch returns early when the entry is fresh.",
    "- The recompute writes the entry and marks the row dirty.",
    "- The fallback has never been reached.",
    "",
    "```ts",
    `const total${n} = values.reduce((a, b) => a + b, 0);`,
    "```",
    "",
    `So the quadratic bound $n^2$ never appears in pass ${n}.`,
    "",
  ].join("\n");
}

interface RowFacts {
  messageKey: string;
  rendered: string;
  streaming: boolean | null;
  current: boolean | null;
  pageHashes: string[];
  pageText: string;
}

describe.skipIf(!SHOULD_RUN)("at0730 — a streamed turn drawn from tugcast's renders", () => {
  test(
    "no row of the turn parses, and every row matches the page's parse of its text",
    async () => {
      const stubDir = stubDirectory();
      const { app, tugbankPath } = await launch(1, blobFor(1), TEST_NAME, {
        resumeCards: [],
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        const stubs = await bindStreamingStubs(app, [CARD], stubDir, MESSAGES, 1, messageText);
        await startStreams(app, stubs);
        await app.waitForCondition<boolean>(
          `(function(){
            var entry = document.querySelector('[data-card-id="${CARD}"] [data-slot="tug-prompt-entry"]');
            return entry !== null && entry.getAttribute("data-phase") !== "streaming";
          })()`,
          { timeoutMs: TURN_MS },
        );
        await Bun.sleep(AFTER_TURN_MS);

        const parses = await app.evalJS<{ byIdentity: Record<string, number> }>("window.__tug.rowParsesByIdentity()");
        const turnParses = Object.entries(parses.byIdentity).filter(([id]) => id.includes(".message.stub-msg-"));
        note(`at0730 turn row parses: ${JSON.stringify(turnParses)}`);
        expect(turnParses, "no row of the streamed turn parsed on the page").toEqual([]);

        // The read is async (it lets math typeset) and `evalJS` cannot return a
        // promise, so kick it off, park the result, and poll.
        await app.evalJS<null>(
          `(window.__at0730rows = undefined,
            window.__tug.renderedRows(${JSON.stringify(CARD)}).then(function (r) {
              window.__at0730rows = JSON.stringify(r);
            }),
            null)`,
        );
        await app.waitForCondition<boolean>("window.__at0730rows !== undefined", { timeoutMs: 8_000 });
        const rows = JSON.parse(await app.evalJS<string>("window.__at0730rows")) as RowFacts[] | null;
        expect(rows).not.toBeNull();
        expect(rows!.map((r) => r.messageKey)).toEqual(
          Array.from({ length: MESSAGES }, (_, i) => `stub-msg-${i}-b0`),
        );
        for (const row of rows!) {
          expect({ key: row.messageKey, rendered: row.rendered, streaming: row.streaming, current: row.current }).toEqual({
            key: row.messageKey,
            rendered: "record",
            streaming: false,
            current: true,
          });
        }

        const onScreen = await app.evalJS<
          { hashes: string[]; text: string; stamped: number; keywords: string[] }[]
        >(`(function(){
          var rows = document.querySelectorAll('[data-card-id="${CARD}"] .session-card-transcript-code-body');
          return Array.from(rows).map(function (row) {
            var keywords = row.querySelectorAll('code[data-tug-highlighted] .tug-syn-keyword');
            return {
              hashes: Array.from(row.children).map(function (c) { return c.getAttribute("data-content-hash") || ""; }),
              text: row.textContent || "",
              stamped: row.querySelectorAll('code[data-tug-highlighted]').length,
              keywords: Array.from(keywords).map(function (k) { return k.textContent || ""; }),
            };
          });
        })()`);
        // The prompt's row wears the same class, so each Message finds its
        // row by its heading block, which names its pass and is unique.
        for (const row of rows!) {
          expect(row.pageHashes.length, `${row.messageKey}: blocks parsed`).toBeGreaterThanOrEqual(5);
          const drawn = onScreen.find((r) => r.hashes[0] === row.pageHashes[0]);
          expect(drawn, `${row.messageKey}: its row is on screen`).toBeDefined();
          expect(drawn!.hashes, `${row.messageKey}: block hashes`).toEqual(row.pageHashes);
          expect(drawn!.text, `${row.messageKey}: text`).toBe(row.pageText);
          expect(drawn!.stamped, `${row.messageKey}: the fence arrived highlighted`).toBe(1);
          expect(drawn!.keywords, `${row.messageKey}: tugcast's keyword slot`).toContain("const");
        }
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
