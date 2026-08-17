/**
 * at0433-shell-autoroute-continuation.test.ts — a bare command written across
 * backslash continuations auto-routes to the shell.
 *
 * ## Why this exists
 *
 * The auto-router had no end-to-end coverage at all, and the gap hid a real
 * failure: the submit path disqualified any draft containing a newline before
 * it ever consulted the grader, so a command written the way people actually
 * write a long one — trailing backslashes, one argument per line, straight out
 * of shell history — went to Claude no matter how definitively it graded. The
 * fix splices continuations on both sides (`spliceContinuations` in the deck,
 * the lexer in `tuggram`) and grades the spliced line. This pins that the two
 * splices agree, on the real grader, through the real shell backend.
 *
 * **No tokens are spent, and that is structural rather than lucky.** A `yes`
 * band is the one routing decision that costs no model call: the grammar
 * accounted for every token, so `modelCallForBand` answers `run` and the line
 * executes with no agent consulted and no veto applied. `git --version` grades
 * `yes` from any directory — a resolving head, a known global flag, nothing
 * left in a free position. That is what makes this drivable in an app-test at
 * all, where the shared-agent pool refuses to spawn a worker ([P08], at0280).
 *
 * ## Test matrix
 *
 *   1. A two-line draft (`git \` / `--version`) submitted with no `/shell`
 *      sigil settles a real shell exchange row whose command is the *spliced*
 *      single line and whose output is git's own — the routed payload is what
 *      was graded, not the bytes that were typed.
 *
 * **Only the routing case is here, and the omission is deliberate.** The other
 * half of the claim — that a newline which is *not* a continuation still means
 * Claude — cannot be driven from an app-test, because proving it requires
 * submitting a turn that reaches the agent, and no app-test may spend
 * subscription tokens or send a real turn into a harness session. That half is
 * pinned as pure logic instead: `spliceContinuations` answers `null` for it in
 * `shell-line-classifier.test.ts`, which is the same gate this submit path
 * reads. What could only be covered here is the part with a real grader and a
 * real shell child on the other end of it.
 *
 * The composer's shipped `returnKeyAction` is `newline`, so a plain Return
 * writes the continuation's line break and ⌘Return is the submit.
 *
 * @covers tugdeck/src/lib/shell-line-classifier.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugrust/crates/tuggram/
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** Command text and output of every settled shell row, in document order. */
async function shellRowFacts(
  app: App,
): Promise<Array<{ command: string; output: string; footer: string }>> {
  return app.evalJS<Array<{ command: string; output: string; footer: string }>>(
    `Array.from(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)})).map(function(row){
       var cmd = row.querySelector(".shell-exchange-command-text");
       var out = row.querySelector(".tugx-term-content");
       var foot = row.querySelector('[data-slot="session-z1b-end-state"]');
       return {
         command: cmd ? cmd.textContent.trim() : "",
         output: out ? out.textContent : "",
         footer: foot ? foot.textContent : "",
       };
     })`,
  );
}

/** Type `lines` into the composer as a multi-line draft — a plain Return
 *  between them, which this composer writes as a line break rather than a
 *  submit — and submit the whole thing with ⌘Return. */
async function typeAndSubmit(app: App, lines: readonly string[]): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) await app.nativeKey("Enter");
    await app.nativeType(lines[i]!);
  }
  // The grade is requested on a typing debounce; let it land so the submit
  // reads a warm answer rather than racing its own bounded wait.
  await new Promise((r) => setTimeout(r, 400));
  await app.nativeKey("Enter", ["cmd"]);
}

describe.skipIf(!SHOULD_RUN)(
  "AT0433: continuations splice, and a spliced command auto-routes",
  () => {
    test(
      "a backslash-continued command auto-routes and runs",
      async () => {
        const app = await launchTugApp({
          testName: "at0433-shell-autoroute-continuation",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A");
          await app.awaitEngineReady("A");

          // --- 1. The continuation routes. No `/shell` sigil, no model call:
          // the spliced line grades `yes` and runs on that alone. ---
          await typeAndSubmit(app, ["git \\", "--version"]);
          await app.waitForCondition<boolean>(
            `(function(){
              var rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
              if (rows.length !== 1) return false;
              var foot = rows[0].querySelector('[data-slot="session-z1b-end-state"]');
              return foot !== null && foot.textContent.indexOf("exit") !== -1;
            })()`,
            { timeoutMs: 30_000 },
          );

          const routed = await shellRowFacts(app);
          expect(routed.length).toBe(1);
          // The spliced line, not the typed bytes: the continuation
          // contributes no character of its own.
          expect(
            routed[0].command,
            "the row carries the line that was graded",
          ).toBe("git --version");
          expect(routed[0].output).toContain("git version");
          expect(routed[0].footer).toContain("exit 0");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
