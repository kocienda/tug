/**
 * sc-masthead.test.ts — the site's masthead clip: a Session card's title
 * bar through one turn, with its controls shown and the session atom's own
 * menu raised over it.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: two Session cards in a two-up, the first bound to a stub
 * transcript of one working turn — prose that streams with its usage, two
 * shell calls held open for a beat, more prose, a third, and the end. On
 * the masthead that is the pulsing dot breathing in Key while the turn runs,
 * the activity sparkline drawing the stream and the calls as they land, the
 * beat line changing under the name, and the dot settling when the turn
 * ends. The two-up is what gives the title bar its place to name: the slot
 * badge and the column badge stand at the cluster's fixed end beside the
 * close box, and every other verb the pane offers is behind the `⋯` at rest.
 *
 * Four gestures, in order, while the turn streams: the pointer arrives in
 * the title bar and the rollup unfurls — the summary, Reveal in Finder, the
 * bullseye, the card width, every verb the `⋯` was hiding; a real
 * right-click on the session atom — the dot and the name in the title line
 * — raises the identity menu with the session's copies, which stands for a
 * moment and is dismissed with Escape; a press on the slot badge opens the
 * arrangement popup, the deck's places with this card's own lit, dismissed
 * by a press outside it; and the pointer leaves, so the row folds back behind its
 * `⋯`. The rollup's reveal reads `pointerenter`/`pointerleave` on the bar
 * rather than `:hover`, by the bar's own design, so the arrival and the
 * departure are dispatched to it, and they reach the listener a real pointer
 * would.
 *
 * The tape is fed by hand. A live session's sparkline reads the `ACTIVITY`
 * feed, which tugcode flushes once a bin from the turn it is running; a stub
 * transcript replays through the transcript feed alone and flushes nothing,
 * so the tape would sit flat through the whole stream. The driver installs a
 * meter in the card's page that reads the transcript's own growth every
 * tenth of a second — the characters that streamed in, the shell blocks that
 * opened — and records them through `window.__tug.recordActivity`, the test
 * surface's entry to the real store, scaled to a brisk session's rate. So
 * the tape's shape is the stream's, cliff for cliff, and nothing on it is
 * invented.
 *
 * The capture is cropped to the masthead and the room its popups drop into:
 * the card's top down to the lower of the menu's and the popup's bottom
 * edges, each measured by raising and dismissing it once before the burst is
 * armed, so the crop fits them as they stand rather than a guess.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { kindPane } from "../body-grounding/_kinds";
import { stubDirectory } from "../streaming-stub-fixture";
import { rectIn } from "../one-view-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor, standIns } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-masthead";
/** The second place's card: unbound, there so the deck has two places to name. */
const OTHER = "sc-masthead-other";
const IPC_VERSION = 2;
/** The transcript's pace, a word at a time. */
const PACE_MS = 40;
/** Heartbeats a tool call stays open before its result: about half a second. */
const HOLD_BEATS = 14;
/** The burst: the turn from its first frame past its end. */
const BURST_MS = 9_800;
/** The turn runs this long before the pointer arrives in the title bar. */
const REVEAL_AT_MS = 1_200;
/** The row stands unfurled this long before the atom is right-clicked. */
const MENU_AFTER_MS = 1_000;
/** How long the menu stands before Escape takes it down. */
const MENU_HOLD_MS = 2_200;
/** The pause between the menu's dismissal and the press on the slot badge. */
const BADGE_AFTER_MS = 500;
/** How long the arrangement popup stands before Escape takes it down. */
const BADGE_HOLD_MS = 2_000;
/** The pause before the pointer leaves and the row folds. */
const LEAVE_AFTER_MS = 400;
/** The meter's tick, and how long it runs: past the burst's end. */
const METER_TICK_MS = 100;
const METER_FOR_MS = 12_000;
/**
 * The gain on the stream's characters: the stub paces a word every 40 ms,
 * well under a live model's rate, so the tape reads them at twice their
 * count; and each shell block that opens is a burst on the tools channel.
 */
const TEXT_GAIN = 2;
const TOOL_UNITS = 360;
const PANE = ".body-chrome-frame";
const TITLE_BAR = `${PANE} [data-slot="tug-pane-title-bar"]`;
const MASTHEAD = '[data-slot="session-masthead"]';
/** The session atom in the title line: the dot and the name. */
const ATOM = `${MASTHEAD} .session-masthead-title`;
/** The description line under it: a press there is a press outside the popup, and nothing else. */
const DESCRIPTION = `${MASTHEAD} .tug-session-row-description`;
const MENU = '[data-slot="tug-editor-context-menu"]';
const BADGE = `${PANE} [data-testid="card-slot-badge-trigger"]`;
/** The picker inside the badge's popup: the element the popup's test id reaches the DOM on. */
const BADGE_POPUP = '[data-testid="card-slot-badge-picker"]';
const TRANSCRIPT = '[data-testid="session-card-transcript"]';
const BASH_BLOCK = '[data-slot="bash-tool-block"]';
const PROMPT_PHASE = `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`;
const PROJECT_NAME = "tug-site";
const PROMPT = "Explain what the masthead shows.";
const BOUND_MS = 30_000;
const STREAMING_MS = 15_000;
const POPUP_MS = 8_000;

/** The usage frame the status row's context cell reads: the window at `tokens`. */
function usage(tokens: number): Record<string, number> {
  return { input_tokens: 2_400, output_tokens: 1_800, cache_creation_input_tokens: 6_200, cache_read_input_tokens: tokens - 10_400 };
}

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: CARD, componentId: "session", title: "Session", closable: true },
      { id: OTHER, componentId: "session", title: "Session", closable: true },
    ],
    panes: [kindPane("session", CARD, 0), kindPane("session", OTHER, 1)],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "two-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The one turn recorded: prose, two held shell calls, prose, a third, the end. */
function working(): unknown[] {
  const out: unknown[] = [];
  let seq = 0;
  let calls = 0;
  const msg = (k: string) => `stub-sc-masthead-${k}`;
  const call = (command: string, description: string, result: string): void => {
    const id = `toolu_sc_masthead_${++calls}`;
    out.push({ type: "tool_use", msg_id: msg(`c${calls}`), seq: seq++, tool_name: "Bash", tool_use_id: id, input: { command, description }, ipc_version: IPC_VERSION });
    for (let b = 1; b <= HOLD_BEATS; b++) {
      out.push({ type: "tool_progress", tool_use_id: id, tool_name: "Bash", elapsed_time_seconds: 0, parent_tool_use_id: null, ipc_version: IPC_VERSION });
    }
    out.push({ type: "tool_result", tool_use_id: id, output: result, is_error: false, ipc_version: IPC_VERSION });
  };
  const prose = (k: string, text: string, from: number, to: number): void => {
    const id = msg(k);
    out.push({ type: "content_block_start", msg_id: id, block_index: 0, kind: "text", ipc_version: IPC_VERSION });
    const deltas = text.match(/\S+\s*|\s+/g) ?? [text];
    const every = Math.max(1, Math.floor(deltas.length / 8));
    let rev = 0;
    deltas.forEach((delta, i) => {
      out.push({ type: "assistant_text", msg_id: id, block_index: 0, seq, rev: rev++, text: delta, is_partial: true, status: "partial", ipc_version: IPC_VERSION });
      if (i % every === every - 1) {
        const tokens = Math.round(from + ((to - from) * (i + 1)) / deltas.length);
        out.push({ type: "streaming_usage", msg_id: id, usage: usage(tokens), ipc_version: IPC_VERSION });
      }
    });
    out.push({ type: "assistant_text", msg_id: id, block_index: 0, seq: seq++, rev, text, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  };

  out.push({ type: "streaming_usage", msg_id: msg("a"), usage: usage(42_300), ipc_version: IPC_VERSION });
  prose(
    "a",
    "The masthead reads the session's ledger row, so the name and the callsign are the record's, not the card's. " +
      "The description under them is the synopsis when one has been written and the last prompt until then.",
    42_300,
    55_100,
  );
  call("grep -n 'session-masthead-title' tugdeck/src/components/tugways/session-masthead.tsx", "Find the title's class", "688:          nameProps={{ className: \"session-masthead-title\" }}");
  call("wc -l tugdeck/src/components/tugways/session-identity-row.tsx", "Count the row's lines", "    1180 tugdeck/src/components/tugways/session-identity-row.tsx");
  prose(
    "b",
    "The tape at the right is the sparkline: fifteen seconds of text, tokens, tool calls and subagents in quarter-second bins, " +
      "held flat across each bin and stepping between them. A right-click on the atom offers the session's copies, the same menu every surface that shows a session answers with. " +
      "The slot badge beside the close box names the place the pane stands in, and a press on it moves the card to another.",
    55_100,
    68_400,
  );
  call("grep -c 'copy-session-' tugdeck/src/components/tugways/session-identity-menu.tsx", "Count the menu's copies", "5");
  prose("c", "That is the whole of it: one row, resolved once, worn by the masthead, the picker and the Workspaces rail alike.", 68_400, 71_200);
  out.push({ type: "cost_update", total_cost_usd: 0.27, num_turns: 1, duration_ms: 9_100, duration_api_ms: 8_700, usage: usage(71_200), modelUsage: {}, ipc_version: IPC_VERSION });
  out.push({ type: "turn_complete", msg_id: msg("c"), seq: seq++, result: "success", ipc_version: IPC_VERSION });
  return out;
}

function transcript(): unknown {
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    turns: [{ index: 0, description: "a working turn", outputs: working() }],
  };
}

async function bindStub(app: App, stubDir: string): Promise<{ tugSessionId: string; projectDir: string }> {
  const tugSessionId = randomUUID();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sc-masthead-")));
  onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
  const projectDir = join(scratch, PROJECT_NAME);
  mkdirSync(projectDir);
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));
  await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
  await pollFor(
    () =>
      app
        .body(CARD)
        .evalJS<boolean>(`document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null && document.querySelector('.session-card-picker-form') === null`)
        .catch(() => false),
    (bound) => bound,
    BOUND_MS,
  );
  return { tugSessionId, projectDir };
}

/**
 * The `session_updated` frame the supervisor pushes after a ledger write,
 * with the facts the rest line reads — the turns, the size, the stamp — so
 * the masthead's third line reads as a session's that has worked, not a
 * fresh one's, once the recorded turn ends. The callsign is the one the
 * spawn minted, read back off the masthead, so the name does not change.
 */
function sessionFrame(tugSessionId: string, projectDir: string, tag: string): string {
  return JSON.stringify({
    session_id: tugSessionId,
    fields: {
      session_id: tugSessionId,
      project_dir: projectDir,
      tag,
      name: null,
      name_user_set: false,
      turn_count: 6,
      file_size: 184_320,
      last_user_prompt: PROMPT,
      last_used_at: Date.now(),
    },
  });
}

function publishSession(frame: string): string {
  return `window.__tug.publishSessionUpdated(${JSON.stringify(frame)})`;
}

/** The masthead's text, for a wait on what its lines say. */
const MASTHEAD_TEXT = `(document.querySelector(${JSON.stringify(MASTHEAD)}) || { textContent: "" }).textContent || ""`;

/** The pointer arriving in, or leaving, the title bar — the events its reveal listens for. */
function pointer(kind: "pointerenter" | "pointerleave"): string {
  return `(function(){
    var bar = document.querySelector(${JSON.stringify(TITLE_BAR)});
    if (bar === null) return false;
    bar.dispatchEvent(new PointerEvent(${JSON.stringify(kind)}, { bubbles: false, pointerType: "mouse" }));
    return true;
  })()`;
}

/**
 * The meter: every tick, the characters the transcript grew by and the
 * shell blocks that opened since the last tick, recorded on the session's
 * text, tokens and tools channels through the test surface. Once the turn
 * has run and ended it also pushes the ledger frame again on every tick: the
 * supervisor's own `session_updated` lands at the turn's end with the stub's
 * empty row, and the rest line would read `No turns` until the next push.
 * Installed in the card's own page, where the masthead's stores are; it
 * stops itself.
 */
function installMeter(tugSessionId: string, frame: string): string {
  return `(function(){
    var sid = ${JSON.stringify(tugSessionId)};
    var frame = ${JSON.stringify(frame)};
    var phase = function () { var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); };
    var streamed = false;
    var transcript = function () { return document.querySelector(${JSON.stringify(TRANSCRIPT)}); };
    var chars = function () { var t = transcript(); return t === null ? 0 : (t.textContent || "").length; };
    var blocks = function () { return document.querySelectorAll(${JSON.stringify(BASH_BLOCK)}).length; };
    var lastChars = chars();
    var lastBlocks = blocks();
    var started = Date.now();
    var timer = setInterval(function () {
      if (Date.now() - started > ${METER_FOR_MS}) { clearInterval(timer); return; }
      var c = chars();
      var b = blocks();
      var grew = Math.max(0, c - lastChars);
      var opened = Math.max(0, b - lastBlocks);
      lastChars = c;
      lastBlocks = b;
      if (grew > 0) {
        window.__tug.recordActivity(sid, "text", grew * ${TEXT_GAIN});
        window.__tug.recordActivity(sid, "tokens", Math.round(grew * ${TEXT_GAIN} / 4));
      }
      if (opened > 0) window.__tug.recordActivity(sid, "tools", opened * ${TOOL_UNITS});
      var p = phase();
      if (p === "streaming") streamed = true;
      else if (streamed) window.__tug.publishSessionUpdated(frame);
    }, ${METER_TICK_MS});
    return true;
  })()`;
}

describe.skipIf(!RUNS)("site clip: masthead", () => {
  test(
    "records the masthead through a turn: the rollup, the atom's menu and the slot badge",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchForMode("sc-masthead", deck(), stubDir);
      try {
        const { tugSessionId, projectDir } = await bindStub(app, stubDir);
        await Bun.sleep(800);
        const body = app.body(CARD);
        const phase = () => body.evalJS<string | null>(PROMPT_PHASE).catch(() => null);
        const standing = (selector: string) => () => body.evalJS<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`).catch(() => false);
        const menuOpen = standing(MENU);
        const popupOpen = standing(BADGE_POPUP);

        // The ledger's facts for the rest line, pushed to the shell and to
        // the card's page, which is where the masthead reads them.
        const title = await body.evalJS<string>(`(document.querySelector(${JSON.stringify(ATOM)}) || { textContent: "" }).textContent || ""`);
        const tag = title.split("/").pop()?.trim() ?? "";
        expect(tag, "the masthead names the session's callsign").not.toBe("");
        const frame = sessionFrame(tugSessionId, projectDir, tag);
        expect(await app.evalJS<boolean>(publishSession(frame))).toBe(true);
        expect(await body.evalJS<boolean>(publishSession(frame))).toBe(true);
        await pollFor(() => body.evalJS<string>(MASTHEAD_TEXT).catch(() => ""), (t) => t.includes("6 turns"), 5_000);

        // The menu and the popup, each raised once and measured, so the crop
        // below fits them as they stand; each dismissed before a frame is
        // taken, and the row folded again, since the real pointer is now in
        // the bar and would otherwise hold it open from the first frame.
        await body.nativeRightClickAtElement(ATOM);
        await pollFor(menuOpen, (open) => open, POPUP_MS);
        const menu = await rectIn(body, MENU);
        expect(menu, "the identity menu is mounted").not.toBeNull();
        await app.nativeKey("Escape");
        await pollFor(menuOpen, (open) => !open, POPUP_MS);
        await body.nativeClickAtElement(BADGE);
        await pollFor(popupOpen, (open) => open, POPUP_MS);
        const popup = await rectIn(body, BADGE_POPUP);
        expect(popup, "the slot badge's popup is mounted").not.toBeNull();
        await body.nativeClickAtElement(DESCRIPTION);
        await pollFor(popupOpen, (open) => !open, POPUP_MS);
        expect(await body.evalJS<boolean>(pointer("pointerleave"))).toBe(true);
        await Bun.sleep(600);

        const rest = await standIns(app);
        const card = rest[CARD];
        expect(card, "the card stands in its slot").toBeDefined();
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        // The card's top through the lower of the two bottom edges, a little past it.
        const bottom = view.y + Math.max(menu!.y + menu!.height, popup!.y + popup!.height + 12) + 16;
        const crop = cropAround([{ x: card!.x, y: card!.y, width: card!.width, height: bottom - card!.y }], 12, await contentSize(app));

        expect(await body.evalJS<boolean>(installMeter(tugSessionId, frame)), "the meter is installed").toBe(true);
        const reading = await burstTo(app, crop, BURST_MS, outDirFor("masthead"), async () => {
          await body.driveSession({ op: "send", text: PROMPT });
          await pollFor(phase, (p) => p === "streaming", STREAMING_MS);
          await Bun.sleep(REVEAL_AT_MS);
          await body.evalJS<boolean>(pointer("pointerenter"));
          await Bun.sleep(MENU_AFTER_MS);
          await body.nativeRightClickAtElement(ATOM);
          await pollFor(menuOpen, (open) => open, POPUP_MS);
          await Bun.sleep(MENU_HOLD_MS);
          await app.nativeKey("Escape");
          await pollFor(menuOpen, (open) => !open, POPUP_MS);
          await Bun.sleep(BADGE_AFTER_MS);
          await body.nativeClickAtElement(BADGE);
          await pollFor(popupOpen, (open) => open, POPUP_MS);
          await Bun.sleep(BADGE_HOLD_MS);
          await body.nativeClickAtElement(DESCRIPTION);
          await pollFor(popupOpen, (open) => !open, POPUP_MS);
          await Bun.sleep(LEAVE_AFTER_MS);
          await body.evalJS<boolean>(pointer("pointerleave"));
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
