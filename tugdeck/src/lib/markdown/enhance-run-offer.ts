/**
 * `enhance-run-offer` — the frame a `tugrun` fence wears.
 *
 * A `tugrun` fence is a command the model offers for the user to run on
 * their own machine. It is not an illustration, so it does not wear the
 * code-fence chrome: no language label, no header strip, no fold. Its frame
 * is one row — the command, wrapped and never clipped so the whole of what
 * would run is in view, with Play and Copy at its right — behind an accent
 * rail, with the `$` sigil drawn by CSS so it is never part of a selection
 * or a copy.
 *
 * The fence stays a `<pre><code class="language-tugrun">` in the DOM. That
 * is what lets every reader of a fence go on reading this one: the
 * selection serializer finds its text and its language where it always
 * does, and the shell grammar colours it through the same door.
 *
 * Built by {@link enhanceFencedCode} on every pass over a block, so a
 * streaming delta's `innerHTML` rewrite and the windowing engine's rebuild
 * both arrive at the same frame.
 *
 * A frame as built can only be copied: its Play is hidden. A surface that
 * can run the command adopts the frame with {@link syncRunOfferFrame}, which
 * shows Play, poses it as Play or Stop, and draws the run's result under the
 * command. The frame holds none of that state. It is written from a store on
 * every sync, because the next rebuild will throw the frame away.
 *
 * Laws: [L06] appearance via DOM and CSS, not React state.
 *
 * @module lib/markdown/enhance-run-offer
 */

import { buildCopyButton, buildIcon, type IconChild } from "./enhance-block-chrome";
import { ansiToHtml } from "@/lib/ansi/ansi-to-html";
import { runOfferStatus, type RunOfferRun } from "@/lib/run-offer-store";
import { terminalNeed, terminalNeedNote } from "@/lib/run-offer-terminal";

/** The fence language that declares a runnable offer. */
export const RUN_OFFER_LANG = "tugrun";

/** The language an offer's command is written in: what colours it, and what
 *  a copy as Markdown names its fence, so a shared transcript reads normally
 *  to somebody who has never heard of Tug. */
export const RUN_OFFER_SHELL_LANG = "bash";

/** Whether a fence's language declares a runnable offer. */
export function isRunOfferLang(lang: string | null): boolean {
  return lang !== null && lang.toLowerCase() === RUN_OFFER_LANG;
}

/** The language a fence is written out under in Markdown. */
export function markdownFenceLang(lang: string | null): string | null {
  return isRunOfferLang(lang) ? RUN_OFFER_SHELL_LANG : lang;
}

/** The class of an offer's frame; an enhanced offer's `<pre>` sits inside one. */
export const RUN_OFFER_CLASS = "tugx-md-run";

/** The languages of a plain fence that can be run where it stands. */
const SHELL_FENCE_LANGS = new Set(["bash", "sh", "zsh"]);

/**
 * Whether a plain fence's language makes it runnable. Such a fence is code
 * the model showed and did not offer, so it keeps the ordinary fence chrome
 * and gains only a Play in its header: enough to run a command from a
 * transcript written before offers existed, or by a model that forgot them.
 */
export function isShellFenceLang(lang: string | null): boolean {
  return lang !== null && SHELL_FENCE_LANGS.has(lang.toLowerCase());
}

/** The attribute a runnable plain fence's wrapper carries. */
export const RUN_FENCE_ATTR = "data-run-shell";

/** Every frame that holds a command and a Play: an offer's own frame, and
 *  the wrapper of a runnable plain fence. */
export const RUN_FRAME_SELECTOR = `.${RUN_OFFER_CLASS}, .tugx-md-fenced-code[${RUN_FENCE_ATTR}]`;

/** Lucide `Play` icon (24×24 viewBox). */
const PLAY_ICON: ReadonlyArray<IconChild> = [
  { tag: "polygon", attrs: { points: "6 3 20 12 6 21 6 3" } },
];

/** Lucide `Square` icon (24×24 viewBox) — Stop. */
const STOP_ICON: ReadonlyArray<IconChild> = [
  { tag: "rect", attrs: { width: "14", height: "14", x: "5", y: "5", rx: "2" } },
];

/** The class of the Play control; a click on one is a press of Play or Stop. */
export const RUN_OFFER_PLAY_CLASS = "tugx-md-run-play";

/** Lucide `CloudUpload` icon (24×24 viewBox) — Add to context. */
const ADD_ICON: ReadonlyArray<IconChild> = [
  { tag: "path", attrs: { d: "M12 13v8" } },
  { tag: "path", attrs: { d: "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" } },
  { tag: "path", attrs: { d: "m8 17 4-4 4 4" } },
];

/** Lucide `Check` icon (24×24 viewBox) — the run is in the context queue. */
const STAGED_ICON: ReadonlyArray<IconChild> = [
  { tag: "path", attrs: { d: "M20 6 9 17l-5-5" } },
];

/** The class of a result's Add to context control. */
export const RUN_OFFER_ADD_CLASS = "tugx-md-run-add";

/**
 * Build the Play control. It is built disabled, and hidden by CSS until a
 * surface adopts the frame: a control that does nothing must not read as one
 * that will. Both glyphs are painted and the control's `data-pose` selects
 * the one that shows. An offer's frame and a runnable plain fence's header
 * carry the same control.
 */
export function buildPlayButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tugx-md-chrome-btn ${RUN_OFFER_PLAY_CLASS}`;
  button.setAttribute("aria-label", "Run command");
  button.dataset.pose = "play";
  button.disabled = true;
  button.appendChild(buildIcon(PLAY_ICON, "tugx-md-run-play-icon", "play"));
  button.appendChild(buildIcon(STOP_ICON, "tugx-md-run-play-icon", "stop"));
  return button;
}

/**
 * Wrap an offer's `<pre>` in its frame and return the frame. The caller
 * has established that the `<pre>` is not already inside one.
 */
export function buildRunOfferFrame(pre: HTMLElement, codeEl: HTMLElement): HTMLDivElement {
  const frame = document.createElement("div");
  frame.className = RUN_OFFER_CLASS;

  const row = document.createElement("div");
  row.className = "tugx-md-run-row";

  const actions = document.createElement("span");
  actions.className = "tugx-md-chrome-actions tugx-md-run-actions";
  actions.appendChild(buildPlayButton());
  actions.appendChild(buildCopyButton(() => commandText(codeEl), "Copy command"));

  pre.classList.add("tugx-md-run-command");

  // The frame takes the `<pre>`'s slot first, then the `<pre>` moves into
  // it, so the document never briefly loses the block.
  pre.replaceWith(frame);
  row.appendChild(pre);
  row.appendChild(actions);
  frame.appendChild(row);
  drawTerminalNeed(frame);
  return frame;
}

/** The command as it would be run: the fence's text without the newline
 *  the fence's closing line leaves behind. */
function commandText(codeEl: HTMLElement): string {
  return (codeEl.textContent ?? "").replace(/\n+$/, "");
}

/** Every runnable frame in a container, in document order: offers and
 *  runnable plain fences alike, since a run is keyed by its place among them. */
export function runOfferFrames(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(RUN_FRAME_SELECTOR));
}

/** The command a runnable frame would run. The command's `<pre>` is the
 *  first in either frame; a result's output holds no `<code>`. */
export function runOfferCommand(frame: HTMLElement): string {
  const codeEl = frame.querySelector<HTMLElement>("pre > code");
  return codeEl === null ? "" : commandText(codeEl);
}

/** The frame attribute an offer that needs a terminal carries. Play is
 *  hidden by CSS on a frame that has it. */
const NEEDS_TERMINAL_ATTR = "data-needs-terminal";

/** Whether a frame's command needs a terminal, as last drawn. */
export function runOfferNeedsTerminal(frame: HTMLElement): boolean {
  return frame.hasAttribute(NEEDS_TERMINAL_ATTR);
}

/**
 * Mark a frame whose command needs a terminal, and put the note saying so
 * under the command; or take both away from one whose command does not.
 * Idempotent. It is read from the command on every pass because a command
 * still streaming changes its answer: `ssh` on its way to `ssh-keygen`. A
 * plain fence is marked and gets no note: it was never an offer, so it
 * simply has no Play.
 */
function drawTerminalNeed(frame: HTMLElement): void {
  const name = terminalNeed(runOfferCommand(frame));
  const note = frame.querySelector<HTMLElement>(":scope > .tugx-md-run-note");
  if (name === null) {
    if (note !== null) note.remove();
    if (frame.hasAttribute(NEEDS_TERMINAL_ATTR)) frame.removeAttribute(NEEDS_TERMINAL_ATTR);
    return;
  }
  if (frame.getAttribute(NEEDS_TERMINAL_ATTR) !== name) {
    frame.setAttribute(NEEDS_TERMINAL_ATTR, name);
  }
  if (!frame.classList.contains(RUN_OFFER_CLASS)) return;
  const text = terminalNeedNote(name);
  if (note !== null) {
    if (note.textContent !== text) note.textContent = text;
    return;
  }
  const built = document.createElement("div");
  built.className = "tugx-md-run-note";
  built.textContent = text;
  const row = frame.querySelector<HTMLElement>(":scope > .tugx-md-run-row");
  if (row !== null) row.after(built);
  else frame.appendChild(built);
}

/** What a frame is drawn from on one sync. */
export interface RunOfferFrameState {
  /** Whether Play may start a run now: the command is final and the shell
   *  is free. */
  canRun: boolean;
  /** The offer's latest run, if it has one. */
  run: RunOfferRun | undefined;
  /** Whether the run is queued to ride the next submission, or `null` on a
   *  surface with no such queue, where the result draws no control for it. */
  staged: boolean | null;
}

/** The run each frame last drew, so a sync that changes nothing writes nothing. */
const drawnRuns = new WeakMap<HTMLElement, RunOfferRun>();

/** How far from its foot a scroller may sit and still count as at it. A
 *  fraction of a line: sub-pixel layout leaves the last pixel unreachable. */
const TAIL_SLACK_PX = 4;

/** What a scroller reports about where it is. */
export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Whether a scroller is showing its tail.
 *
 * A result follows its output as it grows only while this holds. It is read
 * before each write, so the rule needs no memory: a reader who has scrolled
 * up is no longer at the tail and is left where they are, and one who
 * scrolls back down is followed again. A scroller with nothing to scroll is
 * at its tail.
 */
export function isPinnedToTail(m: ScrollMetrics, slackPx: number = TAIL_SLACK_PX): boolean {
  return m.scrollHeight - m.clientHeight - m.scrollTop <= slackPx;
}

/**
 * Adopt a frame and draw it from `state`: show Play, pose it, and put the
 * run's result under the command. Idempotent, and cheap when nothing moved.
 *
 * A run's result is updated in place for as long as it is the same run, so
 * the output can grow under a reader without losing their place. A new run,
 * or a frame the markdown pass has just rebuilt, gets a new result showing
 * its tail.
 */
export function syncRunOfferFrame(frame: HTMLElement, state: RunOfferFrameState): void {
  frame.dataset.runnable = "";
  drawTerminalNeed(frame);
  const needsTerminal = runOfferNeedsTerminal(frame);
  const running = state.run?.status === "running";
  const play = frame.querySelector<HTMLButtonElement>(`.${RUN_OFFER_PLAY_CLASS}`);
  if (play !== null) {
    const pose = running ? "stop" : "play";
    if (play.dataset.pose !== pose) {
      play.dataset.pose = pose;
      play.setAttribute("aria-label", running ? "Stop command" : "Run command");
    }
    // Stop is always live; Play waits for a final command and a free shell,
    // and an offer that needs a terminal has no Play to press.
    const disabled = !running && (!state.canRun || needsTerminal);
    if (play.disabled !== disabled) play.disabled = disabled;
  }

  const existing = frame.querySelector<HTMLElement>(":scope > .tugx-md-run-result");
  if (state.run === undefined) {
    existing?.remove();
    drawnRuns.delete(frame);
    return;
  }
  const drawn = drawnRuns.get(frame);
  const canAdd = state.staged !== null;
  let result = existing;
  if (result === null || drawn === undefined || drawn.exchangeId !== state.run.exchangeId) {
    result = document.createElement("div");
    result.className = "tugx-md-run-result";
    if (existing !== null) existing.replaceWith(result);
    else frame.appendChild(result);
    drawRunOfferResult(result, state.run, canAdd);
  } else if (drawn !== state.run) {
    drawRunOfferResult(result, state.run, canAdd);
  }
  drawnRuns.set(frame, state.run);

  const add = result.querySelector<HTMLButtonElement>(`.${RUN_OFFER_ADD_CLASS}`);
  if (add !== null) {
    const pressed = state.staged === true ? "true" : "false";
    if (add.getAttribute("aria-pressed") !== pressed) {
      add.setAttribute("aria-pressed", pressed);
      add.setAttribute(
        "aria-label",
        state.staged === true
          ? "Remove this result from the next submission's context"
          : "Add this result to the next submission's context",
      );
      add.title = state.staged === true ? "Staged for the next submission" : "Add to context";
    }
  }
}

/**
 * Draw a run into its result element, which is attached: the output, then a
 * footer saying how the run ended, how long it took and where it ran. A run
 * that finished also offers itself to the model: the footer's last control
 * adds the result to the next submission's context, which is the only way it
 * gets there.
 *
 * The output keeps its element across draws. It is capped in height by CSS
 * and scrolls inside itself, and it is brought to its tail after a write
 * only if it was showing its tail before it; a result drawn for the first
 * time shows its tail.
 */
function drawRunOfferResult(result: HTMLElement, run: RunOfferRun, canAdd: boolean): void {
  const status = runOfferStatus(run);
  result.dataset.tone = status.tone;

  let output = result.querySelector<HTMLElement>(":scope > .tugx-md-run-output");
  const text = run.output.replace(/\n+$/, "");
  if (text.length === 0) {
    output?.remove();
  } else {
    const pinned = output === null || isPinnedToTail(output);
    if (output === null) {
      output = document.createElement("pre");
      output.className = "tugx-md-run-output";
      result.insertBefore(output, result.firstChild);
    }
    // `ansiToHtml` escapes the text and sanitizes what it emits.
    output.innerHTML = ansiToHtml(text);
    if (pinned) output.scrollTop = output.scrollHeight;
  }

  const footer = document.createElement("div");
  footer.className = "tugx-md-run-footer";
  const label = document.createElement("span");
  label.className = "tugx-md-run-status";
  label.textContent = status.label;
  footer.appendChild(label);
  if (status.duration !== null) {
    const duration = document.createElement("span");
    duration.className = "tugx-md-run-duration";
    duration.textContent = status.duration;
    footer.appendChild(duration);
  }
  const cwd = document.createElement("span");
  cwd.className = "tugx-md-run-cwd";
  cwd.textContent = run.cwd;
  cwd.title = run.cwd;
  footer.appendChild(cwd);
  if (canAdd && run.status === "settled" && !run.refused) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = `tugx-md-chrome-btn ${RUN_OFFER_ADD_CLASS}`;
    add.appendChild(buildIcon(ADD_ICON, "tugx-md-run-add-icon", "add"));
    add.appendChild(buildIcon(STAGED_ICON, "tugx-md-run-add-icon", "staged"));
    footer.appendChild(add);
  }
  const prior = result.querySelector<HTMLElement>(":scope > .tugx-md-run-footer");
  if (prior !== null) prior.replaceWith(footer);
  else result.appendChild(footer);
}

