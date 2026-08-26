/**
 * TugTranscriptEntry — Slot-based transcript-row primitive.
 *
 * Renders one participant's contribution to a transcript: a left-aligned
 * icon column, then a body column with bold identifier + optional small
 * timestamp, the body slot, and an optional controls slot beneath. Slack-
 * style — no per-row container, no chat bubbles, no left-vs-right
 * alignment by speaker.
 *
 * Three participants are supported: `user`, `assistant`, `shell`.
 * Per-variant differences come exclusively from `[data-participant="..."]`
 * cascade onto `--tugx-transcript-*` tokens — adding a participant is a
 * token + a registry entry, never a primitive edit.
 *
 * `body` and `controls` are `React.ReactNode` slots; the primitive imposes
 * no opinion on text rendering. Consumers pass markdown views, atom-flavored
 * text, or structured renderers as the situation calls for.
 *
 * No production wiring lives in this primitive. Live transcript binding
 * (CodeSessionStore, streaming, atom rendering for user submissions) is
 * the consumer's concern.
 *
 * ## Pin-stack contract — `--tugx-pin-stack-top`
 *
 * The `__pin` wrapper — ONE sticky element per entry, carrying both the
 * gutter icon and the attribution header — is `position: sticky; top: 0;
 * z-index: 2` (see the .css pair) so the speaker icon + identifier +
 * timestamp remain visible while a long entry body scrolls past —
 * multi-hunk DiffBlocks, tall TerminalBlocks, deep FileBlocks. One
 * sticky per entry instead of the earlier two (icon and header pinned
 * independently) matters at transcript scale: every sticky element is a
 * compositing-overlap candidate WebKit re-tests each rendering update,
 * and a long session mounts thousands of entries. Block-level pinned
 * chrome inside the entry body (FileBlock / DiffBlock / TerminalBlock /
 * fenced-code headers + their actions rows; BlockChrome's header)
 * consumes the variable `--tugx-pin-stack-top` to telescope BELOW the
 * entry header rather than overlap it.
 *
 * To make that work, every mounted entry joins its scroller's shared
 * {@link PinStackController}, which measures ONE representative pin
 * (all pins under one scroller share the same one-line header
 * geometry) and writes the height to `--tugx-pin-stack-top` on the
 * scroll container via `style.setProperty`. The variable cascades to
 * every entry's descendants so any sticky header in the body can
 * stack underneath without each consumer needing to query the
 * entry's geometry. The same controller stamps `data-stuck` on
 * whichever pins are displaced by their sticky positioning, computed
 * on the scroll event rather than observed per entry — the controller
 * docstring carries the cost argument. Entries with no scroll
 * ancestor fall back to a local per-entry measurement onto the root.
 *
 * Laws:
 *  - [L03] registration runs in `useLayoutEffect` (before paint) so
 *    the first sticky pass in the children sees a correct offset
 *    rather than a one-frame-late value.
 *  - [L06] the variable and the stuck flag are written to DOM via
 *    `style.setProperty` / `dataset`, never to React state.
 *    Appearance flows through CSS, not renders.
 *  - [L19] file pair, module docstring, exported props interface,
 *    `data-slot="tug-transcript-entry"` on the root.
 *  - [L20] component-token sovereignty — only `--tugx-transcript-*`
 *    drives variant differences; `--tugx-pin-stack-top` is the
 *    contract this primitive WRITES (entry-header height), not a
 *    redefinition of any neighbor's slot.
 *  - [L27] joining the controller returns the release that leaves it.
 */

import "./tug-transcript-entry.css";

import React from "react";
import {
  Bot,
  Eye,
  GitCommitHorizontal,
  ListTree,
  Shell,
  ShipWheel,
  User,
} from "lucide-react";

import { Operator } from "@/components/tugways/tug-icons";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Participant model
// ---------------------------------------------------------------------------

/**
 * Speakers a Dev transcript can mix. The set is open by design — adding
 * a participant means extending this union, registering an icon in
 * {@link PARTICIPANT_ICONS}, and (optionally) defining new
 * `--tugx-transcript-*-<participant>` flavor tokens. No primitive edit.
 */
export type Participant =
  | "user"
  | "assistant"
  | "shell"
  | "refs"
  | "git"
  | "observer"
  | "operator"
  | "wheel";

/**
 * Icon rendered in the gutter for each participant. Lucide glyphs picked
 * to read at a glance:
 *
 *   - `User` for `user` — the human in the session.
 *   - `Bot` for `assistant` — Claude / the AI.
 *   - `Shell` for `shell` — shell command output.
 *   - `ListTree` for `refs` — a `/match` or `/search` run's file references.
 *   - `GitCommitHorizontal` for `git` — a git operation on the repo (the
 *     `/commit` receipt), attributed to git rather than to the shell that
 *     carried it.
 *
 * The route prefix character (`>` / `$`) lives alongside the typed
 * input itself — in the body for `user`, in the identifier for `shell`
 * — not in the gutter. New participants extend this registry with
 * whatever icon a future design pass calls for.
 */
// Icon pixel size — tracks the identifier font-size in lockstep so
// the header reads as a single proportional unit. Identifier is
// `--tug-font-size-lg` (16px); the icon at 20px sits ~25% above
// that, matching the icon-to-text proportion the rest of the Tug
// component vocabulary uses (see `tug-icon-button.css`'s 2xs scale,
// `tug-cue.css`'s icon-to-text ratios). Previously 16px (matched
// the `sm` identifier and tracked below body text), then 18px (with
// `md`). At 20px the icon is the dominant visual anchor of the
// header strip, which is the contract for "the entry's identity
// lives here." Adjust this constant if `--tugx-transcript-identifier-
// font-size` changes — keeping the two in lockstep is load-bearing.
const ICON_PIXEL_SIZE = 20;
const PARTICIPANT_ICONS: Record<Participant, React.ReactNode> = {
  user: <User size={ICON_PIXEL_SIZE} />,
  assistant: <Bot size={ICON_PIXEL_SIZE} />,
  shell: <Shell size={ICON_PIXEL_SIZE} />,
  refs: <ListTree size={ICON_PIXEL_SIZE} />,
  git: <GitCommitHorizontal size={ICON_PIXEL_SIZE} />,
  // The Overview's two voices: the Observer narrates sessions, the Operator
  // answers questions. Both read at transcript scale, so they live in the
  // shared registry rather than in an Overview-only fork of the row.
  observer: <Eye size={ICON_PIXEL_SIZE} />,
  operator: <Operator size={ICON_PIXEL_SIZE} />,
  // The wheel: a turn tugcast opened on the user's behalf — a dash
  // arc's stage prompt. The row lays out as a user row; the glyph says who
  // actually spoke.
  wheel: <ShipWheel size={ICON_PIXEL_SIZE} />,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TugTranscriptEntryProps {
  /** Which participant this row represents. Drives `data-participant` and the icon. */
  participant: Participant;
  /** Bold leading label in the header row. Plain string or styled node. */
  identifier: React.ReactNode;
  /** Optional small timestamp rendered next to the identifier. */
  timestamp?: React.ReactNode;
  /**
   * Optional turn address for this entry, rendered as `#{speaker}{turn}`
   * (e.g. `#u0017` / `#a0017`) pinned to the right edge of the attribution
   * row. The turn is the canonical session unit (`tuglaws/turn-metric.md`);
   * the speaker prefix distinguishes a turn's user and assistant rows, which
   * share the same number. One address per attribution row — the inline
   * messages of a turn carry none.
   *
   * Four digits is the turn budget: a single session can plausibly
   * accumulate four-digit turn counts (long debugging back-and-forths,
   * long-running agent loops), and a fixed-width address reads cleanly
   * through that range without re-aligning siblings as the count grows.
   */
  address?: TurnAddress;
  /**
   * Optional trailing header slot, pinned to the attribution row's right
   * edge — per-row chrome that belongs with the attribution rather than
   * under the body (an icon-only copy button, a provenance chip). Rendered
   * after the sequence badge when both are present.
   */
  headerTrailing?: React.ReactNode;
  /** Row body content. The primitive imposes no opinion on text rendering. */
  body: React.ReactNode;
  /**
   * Optional in-flight indicator slot, sandwiched between the body and
   * the `controls` slot. Used by transcript hosts to mount per-row
   * in-flight chrome (e.g. the Session card's `SessionZ1C` indicator) on the
   * row that is currently the in-flight tip; every other row passes
   * `undefined` / `null` and the slot consumes no vertical space.
   *
   * Two slots — `inflightFooter` and `controls` — instead of a single
   * multiplexed footer because the two carry disjoint chromes with
   * independent lifecycles: in-flight indicator vs. committed
   * end-state. Keeping them separate means neither has to know about
   * the other's render condition.
   */
  inflightFooter?: React.ReactNode;
  /** Optional trailing affordance row beneath the body (badges, copy button, etc.). */
  controls?: React.ReactNode;
  /** Forwarded class name for consumer overrides. */
  className?: string;
}

/**
 * Who an entry is attributed to. Drives the address prefix: `u` user,
 * `a` assistant (a wake/cron turn is the assistant speaking, so it is `a`
 * too), `x` other (reserved), `s` shell, `r` refs (a `/match` or `/search`
 * run — the number `/ref N` resolves against).
 */
export type TurnSpeaker = "user" | "assistant" | "other" | "shell" | "refs";

const TURN_SPEAKER_PREFIX: Record<TurnSpeaker, string> = {
  user: "u",
  assistant: "a",
  other: "x",
  shell: "s",
  refs: "r",
};

/** Human-readable speaker noun for the sequence badge's accessible name. */
const SPEAKER_ARIA_NOUN: Record<TurnSpeaker, string> = {
  user: "User",
  assistant: "Assistant",
  other: "Entry",
  shell: "Shell",
  refs: "Refs",
};

/**
 * A transcript entry's address ([P09]): the session-true turn it belongs
 * to, who is speaking, and its 0-based ordinal *within* that turn among
 * same-kind rows. One address rides each attribution row. Durable across
 * reopen/paging — both components derive from the session's fixed JSONL,
 * not the loaded window.
 */
export interface TurnAddress {
  speaker: TurnSpeaker;
  turn: number;
  /**
   * 0-based within-turn ordinal among same-kind rows. `0` (or omitted) for
   * the sole/first user message or assistant run of the turn — the badge
   * shows no suffix; `1`/`2`/… (steered messages, extra assistant runs)
   * render as `.2`/`.3`.
   */
  sub?: number;
}

/**
 * Format a 1-based entry sequence number as `#NNNN` — zero-padded
 * to four digits up to 9999, then growing naturally. Pure function
 * exported for tests so the formatting rule is pin-able without
 * rendering. Used for plain row/index stamps (telemetry, atom captions);
 * the transcript badge uses {@link formatTurnAddress}.
 */
export function formatSequenceNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  const asInt = Math.floor(n);
  // toString().padStart only pads when needed; numbers >= 10000 stay
  // their natural width.
  return `#${asInt.toString().padStart(4, "0")}`;
}

/**
 * Format a transcript address ([P09]) as `#{speaker}{turn}` with a
 * within-turn suffix when needed: `#u17` / `#a17` for the sole user/
 * assistant row of turn 17; `#u17.2`, `#a17.3` for steered messages or
 * extra assistant runs merged into the turn (`sub` 1, 2, … → `.2`, `.3`).
 * Significant digits only — no zero-padding. A normal turn's user and
 * assistant rows share the turn number (the prefix tells them apart) and
 * carry no suffix, so unmerged sessions read exactly as before. Pure,
 * exported for tests.
 */
export function formatTurnAddress(address: TurnAddress): string {
  const { speaker, turn, sub } = address;
  if (!Number.isFinite(turn) || turn < 0) return "";
  const base = `#${TURN_SPEAKER_PREFIX[speaker]}${Math.floor(turn)}`;
  return sub !== undefined && sub > 0 ? `${base}.${sub + 1}` : base;
}

// ---------------------------------------------------------------------------
// Pin-stack controller — shared per scroll container
// ---------------------------------------------------------------------------

/**
 * One entry's stake in its scroller's shared pin-stack controller: the
 * entry root (the pin's natural resting position) and the sticky `__pin`
 * wrapper (measured for the height variable, stamped `data-stuck`).
 */
interface PinStackRegistration {
  root: HTMLElement;
  pin: HTMLElement;
}

/**
 * Gap between the entry header's bottom edge and the pinned chrome
 * below it. Descendant sticky chrome pins at
 * `top: var(--tugx-pin-stack-top, 0)`; with sub-pixel header heights
 * (font line-height + padding rarely lands on an integer pixel
 * boundary, especially under WKWebView pageZoom), `offsetHeight`
 * rounds down, so a strict `top = height` leaves the chrome
 * overlapping the entry by < 1px. `Math.ceil` plus this gap keeps the
 * chrome a few px below the entry header rather than slipping under it.
 */
const PIN_TIER_GAP_PX = 4;

/**
 * Displacement below which a pin counts as resting. A stuck pin sits
 * at the scroller's top edge, pushed below its natural first-child
 * position in the entry root; sub-pixel layout jitter never reaches
 * a full pixel.
 */
const PIN_STUCK_EPSILON_PX = 1;

/**
 * ONE ResizeObserver observation and ONE scroll listener per scroll
 * container, however many entries it hosts.
 *
 * Both jobs were previously per-entry — a ResizeObserver on every pin
 * for the `--tugx-pin-stack-top` measurement, an IntersectionObserver
 * on every pin for stuck detection. WebKit charges observation
 * bookkeeping on every rendering update, observed element by observed
 * element (`gatherObservations` reads each box, IO geometry-maps each
 * target), so a deck of restored transcripts paid hundreds of
 * per-update reads while sitting perfectly still. Hoisted here, the
 * idle cost is zero:
 *
 *  - **Height** is one observation. Every pin in a scroller is the
 *    same one-line header under the same tokens, so one representative
 *    pin's height is the stack offset for all of them, written once
 *    on the scroller and inherited by every entry. (The scroller's
 *    own selector-based default — see `session-card.css` — stays the
 *    static fallback; the inline write wins on the same element.)
 *  - **Stuck state** only changes when the scroller scrolls, so it is
 *    computed on the scroll event, coalesced to one pass per frame. A
 *    pin displaced below its natural position IS the stuck state
 *    (`pin.top > root.top + ε`) — no sentinel geometry, no per-update
 *    observer walk. Pins inside skipped `content-visibility: auto`
 *    cells are excluded via `checkVisibility` BEFORE any rect read:
 *    geometry queries force layout of skipped subtrees, and a pass
 *    that un-skipped the whole transcript every scroll frame would
 *    cost more than the observers it replaces.
 *
 * `data-stuck="true"` is stamped only while stuck and removed
 * otherwise — the CSS keys on the `"true"` value alone, and absent
 * attributes cost no mutation delivery at mount.
 */
class PinStackController {
  private readonly registrations = new Set<PinStackRegistration>();
  private readonly observer: ResizeObserver;
  private observed: PinStackRegistration | null = null;
  private measureRaf = 0;
  private stuckRaf = 0;
  private readonly onScroll = (): void => {
    this.scheduleStuckPass();
  };

  constructor(private readonly scroller: HTMLElement) {
    // rAF-coalesced like the per-entry observer before it: the write
    // sets a CSS var consumed by sticky descendant chrome, whose
    // relayout can queue further observer notifications within the
    // same delivery pass ("ResizeObserver loop completed with
    // undelivered notifications").
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      const boxes = entry.borderBoxSize;
      const height =
        boxes !== undefined && boxes.length > 0
          ? boxes[0].blockSize
          : entry.contentRect.height;
      cancelAnimationFrame(this.measureRaf);
      this.measureRaf = requestAnimationFrame(() => {
        // A pin can measure 0 without being wrong — its card hidden in
        // a background pane. Never publish that; the last real value
        // (or the static CSS fallback) stands, and the observer fires
        // again when the box comes back.
        if (height > 0) {
          this.scroller.style.setProperty(
            "--tugx-pin-stack-top",
            `${Math.ceil(height) + PIN_TIER_GAP_PX}px`,
          );
        }
        this.scheduleStuckPass();
      });
    });
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
  }

  register(reg: PinStackRegistration): void {
    this.registrations.add(reg);
    if (this.observed === null) {
      this.observed = reg;
      this.observer.observe(reg.pin);
    }
    this.scheduleStuckPass();
  }

  /** Returns true when the controller emptied and disposed itself. */
  unregister(reg: PinStackRegistration): boolean {
    this.registrations.delete(reg);
    if (this.observed === reg) {
      this.observer.unobserve(reg.pin);
      this.observed = null;
      const next = this.registrations.values().next();
      if (!next.done) {
        this.observed = next.value;
        this.observer.observe(next.value.pin);
      }
    }
    if (this.registrations.size > 0) return false;
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.observer.disconnect();
    cancelAnimationFrame(this.measureRaf);
    cancelAnimationFrame(this.stuckRaf);
    this.scroller.style.removeProperty("--tugx-pin-stack-top");
    return true;
  }

  private scheduleStuckPass(): void {
    if (this.stuckRaf !== 0) return;
    this.stuckRaf = requestAnimationFrame(() => {
      this.stuckRaf = 0;
      for (const reg of this.registrations) {
        let stuck = false;
        if (
          reg.pin.checkVisibility({
            contentVisibilityAuto: true,
            visibilityProperty: true,
          })
        ) {
          stuck =
            reg.pin.getBoundingClientRect().top >
            reg.root.getBoundingClientRect().top + PIN_STUCK_EPSILON_PX;
        }
        if (stuck) {
          if (reg.pin.dataset.stuck !== "true") reg.pin.dataset.stuck = "true";
        } else if (reg.pin.dataset.stuck !== undefined) {
          delete reg.pin.dataset.stuck;
        }
      }
    });
  }
}

const pinStackControllers = new Map<HTMLElement, PinStackController>();

/** Nearest overflow-scrolling ancestor — the pin's sticky containing scrollport. */
function findScrollAncestor(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p !== null && p !== document.body) {
    const overflowY = getComputedStyle(p).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * Join the scroller's shared controller. Returns the release, [L27]-style,
 * or null when the entry has no scroll ancestor (gallery hosts, bare test
 * mounts) and the caller should fall back to a local measurement.
 */
function registerPinStackEntry(
  root: HTMLElement,
  pin: HTMLElement,
): (() => void) | null {
  const scroller = findScrollAncestor(pin);
  if (scroller === null) return null;
  let controller = pinStackControllers.get(scroller);
  if (controller === undefined) {
    controller = new PinStackController(scroller);
    pinStackControllers.set(scroller, controller);
  }
  const registration: PinStackRegistration = { root, pin };
  controller.register(registration);
  return () => {
    if (controller.unregister(registration)) {
      pinStackControllers.delete(scroller);
    }
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TugTranscriptEntry: React.FC<TugTranscriptEntryProps> = ({
  participant,
  identifier,
  timestamp,
  address,
  headerTrailing,
  body,
  inflightFooter,
  controls,
  className,
}) => {
  // The article's accessible name is its bold identifier. We don't try to
  // serialize a `ReactNode` identifier into a string `aria-label` — using
  // `aria-labelledby` lets the rendered identifier (string or rich node)
  // serve as the name verbatim.
  const labelledById = React.useId();

  // Refs for the pin-stack-top measurement. Root holds the CSS variable
  // (so descendants inherit it via cascade); the sticky `__pin` wrapper
  // is the observed element whose height is the value.
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const pinRef = React.useRef<HTMLDivElement | null>(null);

  // Join the scroller's shared pin-stack controller: one observer
  // measurement (`--tugx-pin-stack-top` on the scroller) and one
  // scroll-driven stuck pass (`data-stuck` on the pin) for every entry
  // the scroller hosts. See PinStackController for the full contract.
  // [L03] useLayoutEffect runs before paint so registration precedes
  // the first sticky pass in the children. [L06] the height variable
  // and the stuck flag are DOM writes, never React state. [L27] the
  // registration returns its release.
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const header = pinRef.current;
    if (root === null || header === null) return;
    const release = registerPinStackEntry(root, header);
    if (release !== null) return release;

    // No scroll ancestor (gallery hosts, bare test mounts): nothing can
    // stick, so stuck detection is moot, but descendant chrome still
    // reads the height variable — measure this entry's own pin onto its
    // root. NOTE: no synchronous `getBoundingClientRect` seed. That
    // forced layout read, interleaved per-entry with the write below,
    // makes an all-rich transcript mount O(n²); the ResizeObserver's
    // initial delivery provides the real height rAF-coalesced, and the
    // static CSS fallback covers the frame before it lands.
    let rafId = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const boxes = entry.borderBoxSize;
      const next =
        boxes !== undefined && boxes.length > 0
          ? boxes[0].blockSize
          : entry.contentRect.height;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        root.style.setProperty(
          "--tugx-pin-stack-top",
          `${Math.ceil(next) + PIN_TIER_GAP_PX}px`,
        );
      });
    });
    observer.observe(header);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      data-slot="tug-transcript-entry"
      data-participant={participant}
      role="article"
      aria-labelledby={labelledById}
      className={cn("tug-transcript-entry", className)}
    >
      {/* ONE sticky element per entry: icon + attribution header pin as
          a single block. The child class names (and their geometry) are
          unchanged — only the sticky role moved up to this wrapper. */}
      <div ref={pinRef} className="tug-transcript-entry__pin">
        <div className="tug-transcript-entry__icon" aria-hidden="true">
          {PARTICIPANT_ICONS[participant]}
        </div>
        <div className="tug-transcript-entry__header">
          <strong
            id={labelledById}
            className="tug-transcript-entry__identifier"
          >
            {identifier}
          </strong>
          {timestamp !== undefined && (
            <span className="tug-transcript-entry__timestamp">{timestamp}</span>
          )}
          {address !== undefined && (
            <span
              className="tug-transcript-entry__sequence"
              data-slot="tug-transcript-entry-sequence"
              aria-label={`${SPEAKER_ARIA_NOUN[address.speaker]} message ${formatTurnAddress(address).slice(1)}`}
            >
              {formatTurnAddress(address)}
            </span>
          )}
          {headerTrailing !== undefined && headerTrailing !== null && (
            <span className="tug-transcript-entry__header-trailing">
              {headerTrailing}
            </span>
          )}
        </div>
      </div>
      <div className="tug-transcript-entry__content">
        <div className="tug-transcript-entry__gutter" aria-hidden="true" />
        <div className="tug-transcript-entry__body-column">
          <div className="tug-transcript-entry__body">{body}</div>
          {inflightFooter !== undefined && inflightFooter !== null && (
            <div className="tug-transcript-entry__inflight-footer">
              {inflightFooter}
            </div>
          )}
          {controls !== undefined && (
            <div className="tug-transcript-entry__controls">{controls}</div>
          )}
        </div>
      </div>
    </div>
  );
};
