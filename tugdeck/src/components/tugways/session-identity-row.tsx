/**
 * SessionIdentityRow — one session, resolved and rendered. The single component
 * every surface that shows a session mounts.
 *
 *   [dot] <name> : <callsign>        ← what it IS, and whether it is working
 *   <description>                    ← what it is FOR
 *   <activity>                  ~~~  ← what it is doing, with its tape
 *
 * {@link TugSessionRow} is the SHAPE — presentational, every part a node it is
 * handed. This is the shape with the stores behind it: the identity, the
 * description ladder, the activity ladder, the phase dot, and the tape, all
 * resolved once here rather than at each mount site.
 *
 * That distinction is the whole point of the file. The shape was already shared
 * — the masthead, the picker, and the Cards card all mounted `TugSessionRow` — and
 * the surfaces still drifted, because everything that DECIDES what goes into
 * the shape was written three times. Three description ladders (two of which
 * had three rungs and one two), three activity ladders (one with a compaction
 * pin, one without, one with a dwell queue), three spellings of the
 * retired `pulse/enabled` gate, and two copies of the sparkline. A shape can only make
 * three surfaces agree about how a row PACKS; it cannot make them agree about
 * what a row SAYS. This can.
 *
 * ── The three knobs ──────────────────────────────────────────────────────
 * The surfaces genuinely differ in three ways, and only three, so those are
 * declared props and everything else is one answer:
 *
 *  1. **{@link SessionIdentityRowProps.dotSize}** — the indicator's glyph box.
 *     The dense mounts (chrome, the picker's rows) take
 *     {@link TUG_SESSION_ROW_STACK_DOT_SIZE}; the Cards card's monitor rail takes
 *     {@link TUG_SESSION_ROW_INDICATOR_SIZE}. ONE number, used for both the dot
 *     and the ink-slack correction the title is measured by — those were two
 *     props at every mount site, and two numbers that must agree is one number
 *     with a way to be wrong.
 *  2. **`subAlign`** — whether the two sub-lines hang off the title or off the
 *     row's own edge. `TugSessionRow`'s knob, forwarded; see
 *     {@link TugSessionRowSubAlign}.
 *  3. **{@link SessionIdentityRowProps.tape}** — whether the activity
 *     sparkline draws. The picker's rows are a list to pick FROM rather than a
 *     monitor, so they carry none, and a row reserving width for a graph it does
 *     not draw is width taken from the text for nothing. Where it IS asked for
 *     it draws unconditionally: a session with no work behind it gets a
 *     flatline, because an instrument that disappears when it reads zero cannot
 *     be told apart from one that is broken.
 *
 * Everything past those three is either the same on every surface (both
 * ladders, the beat grammar, the retired `pulse/enabled` gate) or is a piece of the
 * mount's own furniture handed straight through (the Cards card's slot picker, the
 * picker's badges and trash, the masthead's popovers and copy handles).
 *
 * ── The description ladder ([D132]) ──────────────────────────────────────
 * The agent's rolling synopsis, else the session's own first prompt, else what
 * the arc it is seated on is here to do, else the date it was created, else
 * {@link UNDESCRIBED}. Every rung below the first is a fact STANDING IN for a
 * line nobody has written yet, so they are marked and painted a step quieter.
 * The whole of it is {@link sessionDescription}, pure and total: it answers
 * with a non-empty string for every input, and the test that says so is what
 * keeps the line from going blank again.
 *
 * All five rungs on every surface. The Cards card carried only two, on the argument
 * that its rows are always bound live cards and so never reach the prompt rung
 * — which, if true, makes the rung free, and if false makes it the one
 * human-meaningful line the row could have shown.
 *
 * The arc rung ({@link arcSessionPurpose}) is the ladder's floor for the one
 * session that can reach it, and it was added because that session was landing
 * on the empty string. The two rungs above it are both facts about the USER
 * typing — a synopsis composed from the session's own asks, else its first
 * prompt — and a wheel-seated stage session has no user typing in it: its only
 * submission is a `/tugplug:arc-…` command, which both the synopsis feed and
 * the ledger's `last_user_prompt` deliberately decline to read as an ask. So
 * for the whole of a stage's first turn — a devise stage IS one long first
 * turn — the upper rungs were empty together, and the `Created …` rung under
 * them is not a floor either: it rests on a ledger row or a replay anchor
 * arriving on a different wire, and a just-spawned session has neither. The
 * binding, by contrast, is the reason the session exists at all, so it is
 * there before the first frame is.
 *
 * It sits BELOW the prompt rung rather than above it: a session a person bound
 * to an arc by hand has its own ask, and what the user said outranks what the
 * stage is named for.
 *
 * Under it, {@link UNDESCRIBED} closes the same hole for the session that has
 * no arc either. `Created …` was the old last rung and was never a floor: it
 * rests on a ledger row or a replay anchor, both of which arrive on wires of
 * their own, so a session between its spawn and its first push had nothing
 * left to fall to. That is a much narrower window than the arc one — seconds
 * rather than a whole stage — but the failure it produces is the same blank,
 * and a blank cannot be told from a bug.
 *
 * ── The activity ladder ──────────────────────────────────────────────────
 * A caller's override, else the compaction pin, else the live beat, else the
 * rest sentence. The overrides exist for facts a row knows that the digest feed
 * cannot report — a session held by a terminal, a row whose one fact is that it
 * failed to resume.
 *
 * The feed is read only when {@link SessionIdentityRowProps.beats} says this row
 * is live, and that gate is load-bearing rather than an optimization:
 * `latestBeatForScope` answers with app-wide ambience for any scope, so a closed
 * session's row would otherwise narrate whatever the app happened to be saying.
 *
 * Laws: [L02] every store enters through `useSyncExternalStore` (inside the
 *       hooks); [L06] appearance is CSS on data attributes, never React state;
 *       [L20] `TugSessionRow` is composed through its published props only.
 * Decisions: [D123] one name, produced in one place; [D132] one row, three
 *       surfaces.
 *
 * @module components/tugways/session-identity-row
 */

import "./session-identity-row.css";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { useAnnotationPortals } from "@/components/tugways/annotation-portals";
import {
  clearFilterMarks,
  setFilterMarks,
} from "@/components/tugways/filter-mark-painter";
import { ArcLifecycleMark } from "@/components/tugways/arc-lifecycle-mark";
import {
  arcSessionPurpose,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";
import { arcGlanceFraction } from "@/lib/arc-meta-facts";
import { BeatText } from "@/components/tugways/beat-text";
import { SessionActivitySparkline } from "@/components/tugways/session-activity-sparkline";
import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";


import { useSessionIdentityMenu } from "@/components/tugways/session-identity-menu";
import {
  TugSessionRow,
  TUG_SESSION_ROW_STACK_DOT_SIZE,
  type TugSessionRowProps,
} from "@/components/tugways/tug-session-row";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { truncateForDisplay } from "@/components/tugways/cards/session-picker-format";
import {
  COMPACTING_BEAT_TEXT,
  useIsCompactingCard,
} from "@/lib/compaction-progress-store";
import { parseBeatFileTarget } from "@/lib/beat-line/beat-file-target";
import { formatRestingStamp } from "@/lib/session-activity-line";
import { arcJoinReadyLine } from "@/lib/arc-join-register";
import { useSessionJoinBase } from "@/lib/code-session-store/use-session-phase";
import { renderBeatLine } from "@/lib/beat-line/render-beat-line";
import {
  askPromptText,
  latestAskForScope,
  latestBeatForScope,
  turnInFlightForScope,
  useDigest,
} from "@/lib/digest-store";
import { latestPostForSession, useOverview } from "@/lib/overview-store";
import {
  sessionActivityBeat,
  sessionActivityRestLine,
} from "@/lib/session-activity-line";
import { useArcForSession, type ArcSessionFact } from "@/lib/arc-session-index";
import { useSessionCreatedAtMs } from "@/lib/session-created-at";
import {
  useSessionIdentity,
  type SessionIdentityContext,
} from "@/lib/session-identity";
import { useSessionLedgerRow } from "@/lib/session-ledger-store";
import type { SessionRow } from "@/protocol";

/**
 * Every line holds the row at least this long before the next replaces it.
 *
 * The pacing is what makes the voice readable rather than a strobe: the
 * machine's commentary arrives in bursts, and a line that flickered past in
 * 200ms would be a texture rather than a sentence. Opt-in
 * ({@link SessionIdentityRowProps.pace}) — a list of rows the reader is
 * scanning rather than reading wants the newest fact, and the picker's cells
 * may hold no state at all.
 */
export const MIN_DWELL_MS = 1_800;

/**
 * The description line when nothing at all is known — the ladder's last rung.
 *
 * In the house's `Not yet <participle>` grammar, the same one the arc cells
 * are set in, and it is the one sentence here that cannot be false: the rung
 * is reached exactly when no description exists and no fact stands in for one.
 *
 * It says something rather than nothing on purpose. The line used to end on
 * the empty string, which renders as a blank that holds its place — and a
 * blank line is indistinguishable from a line that failed to draw, which is
 * how the hole this rung closes was found in the first place.
 */
export const UNDESCRIBED = "Not yet described";

/**
 * The description ladder ([D132]), as a function: the agent's rolling
 * synopsis, else the session's own first prompt, else what the arc it is
 * seated on is here to do, else the date it was made, else {@link
 * UNDESCRIBED}.
 *
 * Pure and total — it returns a non-empty string for every input, which is
 * the property the rungs above cannot each guarantee on their own. It lives
 * outside the component because that property is worth a test, and a ladder
 * inlined in a hook can only be checked by mounting the row it renders.
 *
 * See the module docblock for why each rung sits where it does.
 */
export function sessionDescription(input: {
  /** The written synopsis, or null when none has been composed. */
  synopsis: string | null;
  /** The session's first prompt, trimmed; empty when it has none. */
  prompt: string;
  /** The arc this session is seated on, as the track reads it, or null. */
  arc: ArcTrackModel | null;
  /** When the session was made, or null while nothing has said. */
  createdAtMs: number | null;
}): string {
  if (input.synopsis !== null) return input.synopsis;
  if (input.prompt.length > 0) return input.prompt;
  if (input.arc !== null) return arcSessionPurpose(input.arc);
  if (input.createdAtMs !== null) return `Created ${formatRestingStamp(input.createdAtMs)}`;
  return UNDESCRIBED;
}

/**
 * How much of the description box a lede may fill and still end on its own
 * period — the two tight lines the tier holds, at roughly seventy characters
 * each.
 *
 * It is the box's visible room rather than a taste about sentence length, and
 * that is what makes it the right cut-off: a first sentence that ends inside
 * it is shown whole, and one that ends past it would have been elided anyway,
 * so taking it buys the reader nothing the post did not already give them.
 */
const LEDE_BUDGET_CHARS = 140;

/**
 * The post's first sentence, when it ends inside {@link LEDE_BUDGET_CHARS};
 * otherwise the post as it stands.
 *
 * The Observer writes a post to "one or two sentences, 200 characters of prose
 * at the outside" (`overview_agent.rs`), and the description box holds about
 * 140 of those on its two lines — so a post at the budget always ended in an
 * ellipsis on the line, whatever the band. The lede is the same text in the
 * same voice, cut where the writer already put a full stop, and the whole post
 * is untouched on the wire and in the Overview: this is a reading rule for one
 * rung, not a second field.
 *
 * The sentence test is the digester's (`session_digest.rs::sentence_ends`),
 * ported to the two cases a post actually produces: a terminator counts when
 * the text ends there or a space follows it, past any closing bracket, quote
 * or emphasis marker that belongs to the sentence; and a run of digits before
 * the dot is an enumerator rather than a full stop. What is deliberately not
 * ported is the math-span guard, which is about transcript bodies — a post is
 * prose about a session, and the digester's own rubric keeps it that way.
 *
 * A path's extension is safe without a rule of its own: nothing follows the
 * dot in `narration-target.md` but a letter, so it is never a terminator.
 */
export function postLede(body: string): string {
  const end = firstSentenceEnd(body);
  if (end === null || end >= LEDE_BUDGET_CHARS) return body;
  return body.slice(0, end + 1);
}

/**
 * The index of the last character of the first sentence, or `null` when the
 * text has no sentence end in it at all.
 */
function firstSentenceEnd(text: string): number | null {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    // An enumerator: the token before the dot is digits only, and what stands
    // before those is the start of the text, a space, or an emphasis marker.
    let back = i - 1;
    while (back >= 0 && text[back]! >= "0" && text[back]! <= "9") back -= 1;
    if (back < i - 1 && (back < 0 || text[back] === " " || text[back] === "*")) {
      continue;
    }
    // A closing bracket or quote, and any emphasis the span closes with,
    // belong to the sentence rather than to what follows it.
    let j = i + 1;
    if (text[j] === ")" || text[j] === '"' || text[j] === "”") j += 1;
    while (text[j] === "*") j += 1;
    if (j >= text.length || text[j] === " ") return j - 1;
  }
  return null;
}

/**
 * The handle on a row whose parts came from the stores, as distinct from a bare
 * {@link TugSessionRow} handed its parts by a mount site. The gallery's specimen
 * is the second kind and must stay findable as such.
 */
const IDENTITY_ROW_CLASS = "session-identity-row";

/** What the activity line is showing: a live beat, or a composed sentence. */
interface DisplayEntry {
  key: string;
  text: string;
  /**
   * Not a beat. The rest sentence, the compaction pin, and a caller's override
   * are all facts the row composed rather than news the session sent, so none
   * goes through the markdown pipeline and none is what a line copy carries.
   */
  placeholder: boolean;
  /**
   * Swap this entry in the moment it arrives, skipping the dwell — the user's
   * own clear and the compaction pin both answer a gesture.
   */
  immediate?: boolean;
}

/**
 * A composed line's entry.
 *
 * Keyed BY ITS TEXT, and `immediate`, so the numbers land the moment they move —
 * a constant key would hold the previous sentence on screen after a turn end
 * refreshed the very facts it reports.
 */
function composedEntry(text: string): DisplayEntry {
  return {
    key: `__activity_composed__:${text}`,
    text,
    placeholder: true,
    immediate: true,
  };
}

/**
 * The compaction pin. A `/compact` turn streams nothing for minutes, and the
 * submit that opened it cleared the line — so without this the whole run reads
 * as an idle `Ready.`, which is exactly when the user has pulled the progress
 * sheet down and has only this line to go on. Held for the run's lifetime.
 */
const COMPACTING_ENTRY: DisplayEntry = Object.freeze({
  key: "__digest_compacting__",
  text: COMPACTING_BEAT_TEXT,
  placeholder: false,
  immediate: true,
});

// ---------------------------------------------------------------------------
// The activity run
// ---------------------------------------------------------------------------

interface ActivityTextProps {
  entry: DisplayEntry;
  highlight: string;
  className?: string;
}

/**
 * The activity run, in its ordinary form.
 *
 * Three renderings, and which one applies is the entry's own business rather
 * than the mount's: a composed sentence takes the surface's filter mark (it is
 * the searchable fact on the line); a file-tool beat wears its target as a file
 * reference — glyph plus basename, full path on hover — never a spelled-out
 * path; anything else is a beat set as plain text.
 *
 * No state, no refs, no effects, so a `TugListView` cell bound by the
 * pure-renderer rule can mount it.
 */
function ActivityText({
  entry,
  highlight,
  className,
}: ActivityTextProps): React.ReactElement {
  const fileBeat = React.useMemo(
    () => (entry.placeholder ? null : parseBeatFileTarget(entry.text)),
    [entry],
  );
  if (entry.placeholder) {
    return (
      <span className={className}>
        {renderFilterHighlight(entry.text, highlight)}
      </span>
    );
  }
  if (fileBeat !== null) {
    return <BeatText text={entry.text} className={className} />;
  }
  return <span className={className}>{entry.text}</span>;
}

/**
 * The activity run, through the markdown pipeline.
 *
 * A beat is a tool call, so backticked paths and commands are exactly what the
 * pipeline is for. The beat-line library owns fidelity and safety (math-first
 * split, sanitized markdown, KaTeX, total-function fallback); this only
 * re-renders once a lazy KaTeX load resolves, then every render is synchronous.
 * `html: ""` is the library's render-as-plain-text signal.
 *
 * A separate component from {@link ActivityText}, and mounted only when
 * {@link SessionIdentityRowProps.markdown} asks for it, because the lazy engine
 * needs a reducer and an effect — which a picker cell may not hold.
 */
function ActivityMarkdownText({
  entry,
  highlight,
  className,
}: ActivityTextProps): React.ReactElement {
  const [engineEpoch, bumpEngineReady] = React.useReducer(
    (n: number) => n + 1,
    0,
  );
  const fileBeat = React.useMemo(
    () => (entry.placeholder ? null : parseBeatFileTarget(entry.text)),
    [entry],
  );
  // engineEpoch keys the memo so the resolved KaTeX engine re-renders the SAME
  // entry with real typesetting (the first pass showed the escaped source
  // while the engine loaded).
  const render = React.useMemo(
    () =>
      entry.placeholder || fileBeat !== null ? null : renderBeatLine(entry.text),
    [entry, fileBeat, engineEpoch],
  );
  React.useEffect(() => {
    const pending = render?.pending;
    if (pending == null) return;
    let live = true;
    void pending.then(() => {
      if (live) bumpEngineReady();
    });
    return () => {
      live = false;
    };
  }, [render]);
  if (entry.placeholder) {
    return (
      <span className={className}>
        {renderFilterHighlight(entry.text, highlight)}
      </span>
    );
  }
  if (fileBeat !== null) {
    return <BeatText text={entry.text} className={className} />;
  }
  if (render === null || render.html.length === 0) {
    return <span className={className}>{entry.text}</span>;
  }
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: render.html }}
    />
  );
}

/**
 * The dwell queue: `target` is what the store wants shown; the return is what
 * the row shows. A swap happens immediately when the current line has dwelt
 * long enough (or the target is marked `immediate`); otherwise the newest
 * target waits out the remainder. A swap replaces the text INSTANTLY — one
 * node, no animation, because two different strings cross-fading in one box
 * interleave their glyphs into a smash.
 *
 * `enabled: false` is a pass-through: the target is returned verbatim, the
 * effect returns before it reads anything, and no timer is ever scheduled. A
 * knob rather than a second component for two reasons. Hooks cannot be called
 * conditionally — and, the load-bearing one, the swap has to re-render the ROW
 * rather than a leaf inside it. `TugActivityLine` measures its own middle truncation in
 * an effect that runs when `TugActivityLine` renders; a dwell living below it swaps the
 * text where that effect cannot see it, and the run silently stops truncating
 * (at0375's tape-gap assertion is what says so).
 *
 * **Disabled is inert, not absent.** The `useState` and the three refs are still
 * declared when `enabled` is false — a `TugListView` cell bound by the
 * pure-renderer rule ([D17]) mounts this and gets state it never uses. That
 * holds only because the disabled return ignores `current` entirely; a future
 * edit that read `current` outside the `enabled` guard would hand a recycled
 * cell the previous row's line. Read the guard as the contract, not the
 * ceremony.
 *
 * Local presentation data: refs and timers, changing WHAT text exists rather
 * than how it looks, so no appearance passes through React state ([L06]/[L22]).
 */
function useDwellDisplay(target: DisplayEntry, enabled: boolean): DisplayEntry {
  const [current, setCurrent] = useState<DisplayEntry>(target);
  const currentKeyRef = useRef(target.key);
  const lastSwapAtRef = useRef(0);
  const pendingRef = useRef<DisplayEntry | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    currentKeyRef.current = current.key;
  }, [current.key]);

  const swap = useCallback((next: DisplayEntry): void => {
    setCurrent((prev) => (prev.key === next.key ? prev : next));
    lastSwapAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (target.key === currentKeyRef.current) {
      pendingRef.current = null;
      return;
    }
    // The user's own clear (submit → placeholder) and the compaction pin feel
    // immediate; dwell only paces the machine's stream.
    if (target.immediate === true) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      swap(target);
      return;
    }
    const remaining = lastSwapAtRef.current + MIN_DWELL_MS - Date.now();
    if (remaining <= 0 && timerRef.current === null) {
      swap(target);
      return;
    }
    // Within the dwell: the newest target wins when the window opens.
    pendingRef.current = target;
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending !== null) swap(pending);
      }, Math.max(remaining, 0));
    }
  }, [target, swap, enabled]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return enabled ? current : target;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export interface SessionIdentityRowProps
  extends Omit<
    TugSessionRowProps,
    | "name"
    | "indicator"
    | "indicatorSize"
    | "description"
    | "descriptionStandIn"
    | "activity"
    | "sparkline"
  > {
  /** Whose session. The only key most surfaces hold, and the only one needed. */
  sessionId: string;
  /**
   * The card showing this session, when there is one. Supplies the compaction
   * pin's scope and the replay-derived creation anchor; a row for a session no
   * card holds simply passes none.
   */
  cardId?: string;
  /** The workspace the session belongs to — the ledger read's key. */
  projectDir?: string;

  // ── Knob 1: the indicator's size ───────────────────────────────────────
  /**
   * The phase dot's glyph box, in px — a RING box, not a line height: the dot
   * paints at a fraction of it and the ring travels to its edge.
   *
   * ONE number, and the row is built from it twice: the dot is drawn at this
   * size, and the title's leading is corrected by the room this size of ink
   * leaves inside the line's fixed advance. Those were two props every mount
   * site passed side by side, which is one number with a way to be wrong.
   * @default TUG_SESSION_ROW_STACK_DOT_SIZE
   */
  dotSize?: number;
  /**
   * What the row's leading packs against — the mark's INK, or the fixed COLUMN
   * the mark stands in.
   *
   * `"ink"` is a rail's answer and the default: the title closes up against
   * the pixels the dot actually paints, so a row reads as one reading rather
   * than as a glyph beside a paragraph. Every mount in a list wants it.
   *
   * `"column"` is a masthead's. A chrome tier is not a list of one kind of row:
   * the same tier is worn by a session (an 8px disc inside a breathing ring)
   * and by a document (a glyph that fills its box), and a slot badge stands
   * under both of them. Packed against ink those three land on three different
   * verticals, each correct and none matching. Packed against the column they
   * share one, and the marks centre in it whatever size their ink is.
   *
   * It is also what makes a tier hold still: a session that joins a counted
   * arc swaps its dot for a step ring, which packs at the column already — so
   * under `"ink"` the title moves several pixels sideways when an arc starts.
   * @default "ink"
   */
  indicatorPacking?: "ink" | "column";
  /**
   * Whether the dot's period is jittered — on in a LIST of separate sessions,
   * each doing its own work, and off where the dots belong to one thing.
   * @default false
   */
  drift?: boolean;

  // ── Knob 3: the tape (knob 2, `subAlign`, is TugSessionRow's) ──────────
  /**
   * Whether the activity sparkline draws — and where it is asked for, it draws
   * ALWAYS. A session with no work behind it shows a flatline; that is the
   * instrument reading zero, not a reason to take the instrument away.
   * @default false
   */
  tape?: boolean;
  /**
   * Wrap the tape before it is mounted — for a surface that hangs an
   * affordance on it. The masthead's tape is the trigger for the expanded
   * Activity card; the Cards card's is a reading and nothing more.
   */
  renderTape?: (tape: React.ReactNode) => React.ReactNode;

  // ── What the caller already knows ──────────────────────────────────────
  /** Further identity facts the caller holds — a ledger row's state, lineage. */
  identityContext?: SessionIdentityContext;
  /**
   * The ledger row the caller is ALREADY holding — the picker browses a whole
   * workspace and has every row in hand. Given, it is the source for the
   * description's prompt rung and the activity's rest facts; omitted, they are
   * read from the ledger by id.
   */
  row?: SessionRow | null;
  /**
   * The arc binding the caller is ALREADY holding, the same way {@link row}
   * is the ledger row it holds. Given, it is the source for the step ring and
   * for the track riding the title run; omitted, the binding is read from the
   * changeset aggregate by session id.
   *
   * `null` states that this session is on no arc, which is different from
   * omitting the prop and letting the store answer.
   */
  arc?: ArcSessionFact | null;
  /** A list surface's filter query, painted over the runs that can carry it. */
  highlight?: string;
  /**
   * Cap the description at this many characters. The line elides in CSS
   * whatever this says, so it is a bound on the TEXT rather than the layout —
   * a dense list of rows keeps a runaway prompt from riding in the DOM.
   * Whitespace is flattened either way.
   */
  descriptionMaxChars?: number;
  /**
   * What the activity line says INSTEAD of anything the feed could report — a
   * session held by a terminal, a row whose one fact is that it failed to
   * resume. Takes the filter mark, like every other composed line.
   */
  activityOverride?: string | null;
  /**
   * Whether this row reads the live digest feed.
   *
   * Load-bearing rather than an optimization: `latestBeatForScope` answers with
   * app-wide ambience for any scope, so a row for a session this app is not
   * running would otherwise narrate whatever the app happened to be saying.
   * @default true
   */
  beats?: boolean;
  /**
   * Pace the beat — hold each line {@link MIN_DWELL_MS} before the next
   * replaces it. For a line being READ; a list being scanned wants the newest
   * fact. Off, the dwell is a pass-through that schedules and writes nothing,
   * which is what lets a cell bound by the pure-renderer rule mount this.
   * @default false
   */
  pace?: boolean;
  /**
   * Run the beat through the markdown pipeline — backticks, math, the lot.
   * Costs a lazily-loaded engine and an effect.
   * @default false
   */
  markdown?: boolean;
  /** Class on the activity run itself, for a surface styling its ink. */
  activityClassName?: string;
  /**
   * Which REGISTER the row's LOWER LINES read in ([D185], [B01]).
   *
   * `"line"` — the default, and every surface but one: every run is one line
   * tall, so a beat is the beat and a resting session says when it last
   * finished. The Cards card's rows and the picker's rows read here.
   *
   * `"wall"` — the Session card's masthead, folded or open, whose tier
   * stands one line taller than the rows' ([B04]). That line goes to the
   * DESCRIPTION, which during a turn carries the Observer's post: the
   * longest run on the tier, written to a budget no single line holds, and
   * refreshed once a minute. The beat keeps the one line it reads in
   * everywhere else — it is short, and it changes about once a second, so a
   * box it could wrap into would flicker at that rate ([B01]).
   *
   * The name is still the activity's because the register is the ROW's, and
   * the row has read it as one fact since [D185]: a wall of watched sessions
   * is read by asking "what is that one doing" and "what is that one for",
   * and this is the register that answers both without the card being opened.
   * @default "line"
   */
  activityRegister?: "line" | "wall";
  /**
   * Props for the element wrapping the TITLE. The identity runs are rendered
   * inside whatever this describes.
   */
  nameProps?: React.ComponentProps<"span">;
  /**
   * Whether the WHOLE row answers a right-click with the session's copies —
   * the atom, the citation, the id, the description, the newest beat. See
   * {@link useSessionIdentityMenu}.
   *
   * On, the identity's hover card is off, and that pairing is the point rather
   * than a side effect: the tooltip and the menu were showing the same facts
   * over the same pixels, and only one of them can be acted on.
   *
   * Off for the picker's cells, which are pure render functions and are a list
   * to pick FROM — a right-click there is a gesture aimed at the picking, not
   * at the session.
   * @default false
   */
  identityMenu?: boolean;
  /**
   * The card this row is MOUNTED IN, for the menu's go-to item. Only a surface
   * that is a card's own chrome needs to say — the masthead renders in the
   * pane title bar, above the card host whose context every other mount reads.
   * See {@link SessionIdentityMenuOptions.hostCardId}.
   */
  hostCardId?: string;
}

export function SessionIdentityRow({
  sessionId,
  cardId,
  projectDir = "",
  dotSize = TUG_SESSION_ROW_STACK_DOT_SIZE,
  indicatorPacking = "ink",
  drift = false,
  tape = false,
  renderTape,
  identityContext,
  row: rowOverride,
  arc: arcOverride,
  highlight = "",
  descriptionMaxChars,
  activityOverride = null,
  beats = true,
  pace = false,
  markdown = false,
  activityClassName,
  activityRegister = "line",
  nameProps,
  identityMenu = false,
  hostCardId,
  className,
  style,
  ...rest
}: SessionIdentityRowProps): React.ReactElement {
  // Identity, through the one resolver — so a `/rename` or a callsign reroll
  // repaints every surface with no reload ([D123]). A mount that also needs the
  // record for its own furniture calls the same hook with the same context and
  // gets the same record; there is no second copy to keep in step.
  const identity = useSessionIdentity(
    sessionId,
    identityContext ?? {
      projectDir: projectDir.length > 0 ? projectDir : undefined,
    },
  );

  // The session's own ledger row: the turn count, the on-disk size, when it
  // last moved, and the first prompt — the description's middle rung and the
  // activity's rest form. The caller's row wins when it has one, and it wins
  // INSIDE the hook rather than after it: a picker that already holds every row
  // in the workspace should not also be listening to the ledger for each of
  // them, and `??` on the way out would have left it doing exactly that.
  const facts = useSessionLedgerRow(sessionId, projectDir, rowOverride);

  // The arc this session is on, for the step ring and the title's progress
  // cluster. The same aggregate read the identity's own arc marker makes —
  // the fact is reference-stable across beats that do not move this session's
  // binding, so the row repaints only when its own arc does.
  // A caller holding the binding hands it over — the same argument `row`
  // makes — and the store read is skipped by asking it about no session at all
  // rather than by branching on a hook.
  //
  // This read is the ONLY read of the binding under a row: whatever it finds,
  // including nothing, is handed down to the identity so the marker beneath
  // never asks the store the same question a beat later and answers it
  // differently.
  const storeArc = useArcForSession(arcOverride === undefined ? sessionId : null);
  const arcFact = arcOverride ?? storeArc;
  // The track's reading of that fact — the title's lifecycle mark and the
  // description's floor rung read the one model, so a row cannot say one
  // thing about its arc on one line and another on the next. It arrives on
  // the fact already built, by the builder that list's shape calls for, and
  // is reference-stable across beats that do not move this arc.
  const arcModel = arcFact?.track ?? null;
  // The numerals count the declared RUN — the selection somebody asked for,
  // which is what the task list mirrors and the invocation named. The plan's
  // own pair is the track's, drawn as one tick per plan step, so nothing here
  // derives it a second time.
  const arcGlance =
    arcFact !== null
      ? arcGlanceFraction(
          arcFact.runPosition,
          arcFact.runLength,
          arcFact.stepCurrent,
          arcFact.stepTotal,
        )
      : null;

  // When the session was made. Two sources, resolved once and shared, so a
  // masthead and a Cards card row cannot date the same session differently. The row
  // is handed over rather than read again — `facts` is already whichever row
  // this mount trusts, and the resolver's own second read of the same row was
  // a duplicate subscription on every session row in the app.
  const cardCreatedAtMs = useSessionCreatedAtMs(cardId, facts);
  const createdAtMs =
    cardCreatedAtMs !== null && cardCreatedAtMs > 0 ? cardCreatedAtMs : null;

  const digest = useDigest();
  // The Observer's channel, for the description's live-turn rungs ([D187]).
  // The whole snapshot rather than a per-session slice: the store publishes one
  // list and every selector here filters it, the same shape the beat store has.
  const overview = useOverview();
  // Scoped to THIS card, not the whole runs map: a map snapshot changes
  // identity on every write to any card, so one `/compact` re-rendered every
  // session row in the app. A row with no card subscribes to nothing at all.
  const compacting = useIsCompactingCard(cardId);

  // ── The description ladder ([D132]) ───────────────────────────────────
  const prompt = facts?.last_user_prompt?.trim() ?? "";
  const restDescription = sessionDescription({
    synopsis: identity.description,
    prompt,
    arc: arcModel,
    createdAtMs,
  });
  // The newest BEAT the feed has about this session: the newest line that
  // narrates, with a tool's result and a finished wait walked past
  // ({@link latestBeatForScope}). One reader wants it, the activity ladder
  // below — the turn-in-flight test cannot be read off it, because the newest
  // line is often a shell command or a background job's notice, neither of
  // which is part of a turn. {@link turnInFlightForScope} walks past those;
  // see its docblock.
  const latestLine = beats
    ? latestBeatForScope(digest.lines, sessionId, digest.cleared.get(sessionId))
    : null;
  const turnInFlight =
    beats &&
    turnInFlightForScope(
      digest.lines,
      sessionId,
      digest.cleared.get(sessionId),
    );
  // [D187]'s ladder, over the top of [D132]'s. During a turn the line says what
  // is happening: the Observer's newest post about this session, else the ask
  // the turn is answering. At rest it is the standing sentence and the rungs
  // under it, unchanged.
  //
  // The post rung shows the post's LEDE ({@link postLede}) rather than the
  // whole post. A post is written to 200 characters and this box holds about
  // 140, so the whole of one always ended in an ellipsis here; the first
  // sentence is the same text in the same voice, ending where its writer put a
  // full stop. The Overview keeps the post entire — this is which of the
  // post's words one rung shows, not a second thing for the Observer to write.
  //
  // The ask rung is not a nicety. With a 60 s sitrep the first post of a turn
  // lands no sooner than a minute in, and for that minute the ask is both the
  // thing the reader most wants and the one line that cannot be wrong.
  //
  // All three are derived in render from stores already attached — no state,
  // no effect, nothing to keep in step ([L02]).
  const livePost = turnInFlight
    ? latestPostForSession(overview.posts, sessionId)
    : null;
  const liveAsk = turnInFlight
    ? latestAskForScope(digest.lines, sessionId)
    : null;
  const descriptionSource =
    livePost !== null
      ? postLede(livePost.body)
      : liveAsk !== null
        ? askPromptText(liveAsk)
        : restDescription;
  // Flattened always, capped only where the caller asks. A prompt is the one
  // rung that can carry newlines, and a multi-line run inside a `nowrap` box
  // is a line whose break the reader cannot see.
  const description = React.useMemo(
    () =>
      truncateForDisplay(
        descriptionSource,
        descriptionMaxChars ?? Number.MAX_SAFE_INTEGER,
      ),
    [descriptionSource, descriptionMaxChars],
  );
  // The same text under no budget at all — what the hover shows when the line
  // cannot fit the description. Flattened by the same call, so the tooltip and
  // the line differ in LENGTH only and the reader is reading the continuation
  // of the run they hovered rather than a differently-shaped one.
  const descriptionFull = React.useMemo(
    () => truncateForDisplay(descriptionSource, Number.MAX_SAFE_INTEGER),
    [descriptionSource],
  );
  // A written line is not a stand-in; a fact wearing one's clothes is. The
  // Observer's post and the standing sentence are both written ABOUT the
  // session, so neither is marked. The ask is the user's own words standing in
  // for a line nobody has written yet, which is exactly what the prompt rung
  // under it already is.
  const descriptionStandIn =
    livePost === null && (liveAsk !== null || identity.description === null);

  // ── The activity ladder ───────────────────────────────────────────────
  // The bare `Done` marker is filtered on the way in: it is the ABSENCE of a
  // beat, and the rest sentence says the same thing with facts in it.
  const beat = sessionActivityBeat(latestLine);
  // **Join readiness outranks the digester ([B10]).** A session whose arc has
  // finished with an offer standing is at rest for one reason, and that reason
  // is the reader — which is a higher-order fact about the session than
  // whatever the narration last said it was doing. So while the offer stands
  // the line is the register's own sentence, composed from the same function
  // the Arcs card and the shade read, and the digester's sentence returns the
  // moment a land, a discard or a reopen spends the offer.
  //
  // At rest only: a turn in flight is the session doing something now, and now
  // outranks a wait. That is the same condition the dot's `ready` key carries,
  // so the folded card's two lines and its dot agree.
  const joinBase = useSessionJoinBase(sessionId);
  const joinReadyLine =
    joinBase !== null && !turnInFlight ? arcJoinReadyLine(joinBase) : null;
  const restLine = sessionActivityRestLine({
    turnCount: facts?.turn_count ?? 0,
    fileSize: facts?.file_size ?? null,
    lastUsedAtMs: facts?.last_used_at ?? null,
  });
  const target: DisplayEntry =
    activityOverride !== null && activityOverride.length > 0
      ? composedEntry(activityOverride)
      : compacting
        ? COMPACTING_ENTRY
        : joinReadyLine !== null
          ? composedEntry(joinReadyLine)
          : beat !== null
            ? {
                key: beat.key,
                text: beat.text,
                placeholder: false,
              }
            : composedEntry(restLine);
  // Paced HERE rather than in a leaf, so a swap re-renders the row and
  // `TugActivityLine` measures the new text — see {@link useDwellDisplay}.
  const entry = useDwellDisplay(target, pace);

  // ── The row's own menu ────────────────────────────────────────────────
  // Fed the NEWEST beat rather than the one on screen: within a dwell window
  // the two differ by a line, and the newest is the honest thing to hand a
  // paste. The description item is offered for a written synopsis and for a
  // prompt standing in for one, but not for the created-on stamp, which is a
  // fact the row composed rather than anything the session said.
  const menu = useSessionIdentityMenu({
    identity,
    description:
      livePost === null && identity.description === null && prompt.length === 0
        ? null
        : descriptionFull,
    activity: beat?.text ?? null,
    hostCardId,
    enabled: identityMenu,
  });
  const ActivityRun = markdown ? ActivityMarkdownText : ActivityText;
  // The beat reads in ONE register everywhere, the wall included ([B01]): it
  // is short, and it is broadcast about once a second, so a box that let it
  // wrap would flicker between one and two lines of ink at that rate. The
  // second line the fold buys goes to the description instead, below.
  const activity = (
    <ActivityRun
      entry={entry}
      highlight={highlight}
      className={activityClassName}
    />
  );

  // The wall register gives the DESCRIPTION two lines to wrap into ([B01]): a
  // folded card is the masthead and nothing else, so the line that is a
  // caption on an open card becomes the reading — and during a turn that line
  // is the Observer's post, a sentence budgeted well past what one line of the
  // tier holds.
  //
  // `data-register` is what the CSS keys the stacking on. It rides a wrapper
  // rather than the line itself because the line is also the hover's
  // measuring subject and the row primitive's own element, whose attributes
  // are that primitive's to write.
  //
  // The ink is PROSE, not a string: a description is written about the
  // session and names the files the work touched, so it renders through the
  // Overview's own call and no second one ([B01]) — `TugMarkdownBlock` in
  // static `initialText` mode, keyed on the text so a new post remounts,
  // `onAnnotated` from `useAnnotationPortals`, portals rendered beside it.
  // That is one component and one code path for the same sentence on both
  // surfaces: backticks consumed rather than spelled, `<code>` at the
  // transcript's own inline size, and the block wrappers flattened onto the
  // row by the shared rule in `tug-session-row.css` ([B02]).
  //
  // Inside an {@link AnnotationScope} a confirmed path in it earns the file
  // bubble and a confirmed sha the commit bubble, both opening on a click;
  // outside one — the picker and gallery cells — the annotator marks the
  // state-free kinds only and the line is toned prose.
  //
  // A sha here is a MENTION rather than the pill every reading surface draws:
  // the run keeps its characters and takes the resting underline a confirmed
  // path takes beside it. The pill is 22px and this band is 15.6, so a pill in
  // this line would be clipped at both ends — and buying it room is what cost
  // the masthead's tier 14px. The atom's height, form and behaviour are
  // untouched everywhere else it is drawn; this is one surface saying which
  // form a written reference takes on it.
  //
  // A session citation takes the same cut, for the same arithmetic and one
  // more reading. The chip is the same 22px box, so on the masthead — where
  // this line is the one run that WRAPS — it stood proud of its own line and
  // into the one above, straight through the resting underline of the path in
  // the sentence before it; two marks of two different things, touching, on
  // chrome nobody can scroll. It is drawn at the presence register here
  // instead: the same live citation, the same raise on a click, the session's
  // name set in the line's own ink with no enclosure around it.
  const { onAnnotated: onDescriptionAnnotated, portals: descriptionPortals } =
    useAnnotationPortals(undefined, {
      commitMark: "mention",
      sessionMark: "mention",
    });
  // The filter's mark, painted over what the pipeline built rather than
  // composed while it renders ([B08]). `renderFilterHighlight` cannot reach
  // this run — its DOM is written by the parse and the annotator, with no
  // render-time seam to nest a `<mark>` into — so the run is marked
  // `findable` and the query paints Ranges over its live text, the way
  // transcript Find paints its own. The row's other highlighted runs, the
  // title and the activity entries, keep the composed mark.
  //
  // `findable` here opts the run into the PAINTER's walk and nothing else:
  // the transcript's own painter reaches rows through its list's index, and a
  // masthead or rail row is not one, so the index's count-to-paint alignment
  // has nothing to say about this mark.
  const descriptionContainer = React.useRef<HTMLElement | null>(null);
  // Live-ref'd so the annotation callback can be identity-stable: a fresh
  // closure per render would re-run the block's own annotation effect ([L07]).
  const highlightRef = React.useRef(highlight);
  highlightRef.current = highlight;
  const onDescriptionMarked = React.useCallback(
    (container: HTMLElement) => {
      onDescriptionAnnotated(container);
      descriptionContainer.current = container;
      setFilterMarks(container, highlightRef.current);
    },
    [onDescriptionAnnotated],
  );
  // Both sides move on their own: the DOM through the callback above, the
  // query here. [L03] a layout effect, so the mark is painted before the
  // frame the reader sees.
  React.useLayoutEffect(() => {
    const container = descriptionContainer.current;
    if (container === null) return;
    setFilterMarks(container, highlight);
  }, [highlight, description]);
  React.useLayoutEffect(
    () => () => {
      const container = descriptionContainer.current;
      if (container !== null) clearFilterMarks(container);
    },
    [],
  );
  const descriptionInk = (
    <>
      <TugMarkdownBlock
        key={description}
        initialText={description}
        findable
        onAnnotated={onDescriptionMarked}
      />
      {descriptionPortals}
    </>
  );
  const descriptionRun =
    activityRegister === "wall" ? (
      <span className="session-identity-description-post" data-register="wall">
        {descriptionInk}
      </span>
    ) : (
      descriptionInk
    );

  // ── The tape ──────────────────────────────────────────────────────────
  // Unconditional wherever the mount asks for one — a session that has done no
  // work yet shows a FLATLINE, which is the instrument reading zero rather than
  // the instrument being absent. An accessory that comes and goes with the
  // data it reports is one the reader cannot trust: nothing on screen
  // distinguishes "this session is quiet" from "the tape is not here", and the
  // line beneath it moves out to the row's edge and back every time the
  // distinction flips. The retired `pulse/enabled` did not gate it either, for the same
  // reason the activity line survives that toggle: chrome that got shorter
  // when a preference changed would move every card in the pane.
  const tapeNode = tape ? (
    <SessionActivitySparkline sessionId={sessionId} />
  ) : undefined;
  const sparkline =
    tapeNode !== undefined && renderTape !== undefined
      ? renderTape(tapeNode)
      : tapeNode;

  // The row's own dot leads the name line, so the identity renders its runs
  // only — one mark per row, never two.
  const runs = (
    <TugSessionIdentity
      identity={identity}
      tier="line"
      dot={false}
      highlight={highlight}
      // The row already holds the binding, so the identity's own marker is
      // handed the answer rather than subscribing for it. `false` when the row
      // read no arc — that is the prop's "on no arc, and do not ask" arm,
      // and it is the case a second subscription most often disagreed about.
      arc={arcFact ?? false}
      // Where the row answers a right-click, the hover says nothing. Both were
      // showing the session's name and description over a row already showing
      // both, and only one of them can be acted on.
      tooltip={!identityMenu}
    />
  );

  // The arc's whole life, riding the title line after the identity's own
  // `^<arc>` run — in the COMPACT register: the phase glyph, one pill, and
  // the count of the declared run.
  //
  // The whole track stood here once, and this line is one of the two places it
  // could not fit: a session row leads with a name that elides, and a graphic
  // that grew with the plan drove the name and the strip into each other. The
  // mark says the same three things in a box that cannot grow — where the arc
  // is, that it is alive, and how far along. The track itself belongs to the
  // surfaces whose subject IS the arc: the Cards card's Arcs section, the Changes
  // shade's arc lane, and the ARC placard.
  //
  // The glyph is keyed on the lifecycle PHASE, not the git stage — a card
  // devising or reviewing a plan has no stage at all, and that is the half of
  // an arc's life the surface most likely to be watching it most needs a word
  // for. The guard is the binding itself for the same reason.
  //
  // The fraction is handed over rather than derived: the numerals count the
  // RUN somebody asked for, which is a different pair from the plan's own
  // whenever a run is a slice of a plan.
  //
  // The step's TITLE stays off this line — it lives in the Arcs section.
  const progress =
    arcFact !== null && arcModel !== null ? (
      <span
        className="session-identity-row-progress"
        data-slot="session-identity-row-progress"
      >
        <ArcLifecycleMark
          model={arcModel}
          size="read"
          name={arcFact.name}
          fraction={arcGlance}
        />
      </span>
    ) : null;
  const titleRun =
    progress !== null ? (
      <span className="session-identity-row-title-run">
        {runs}
        {progress}
      </span>
    ) : (
      runs
    );

  return (
    <>
    <TugSessionRow
      // The row's own class, always, ahead of whatever the mount adds. A bare
      // `TugSessionRow` and one of these are the same element otherwise — same
      // `data-slot`, same classes — and `data-slot` cannot carry the difference
      // because the shape owns that name and this composes it rather than
      // replacing it. So: the one mark that says a row's parts came from the
      // stores rather than from a mount site's own hand.
      className={
        className !== undefined
          ? `${IDENTITY_ROW_CLASS} ${className}`
          : IDENTITY_ROW_CLASS
      }
      // ONE mark, whatever the session is doing: the phase dot, saying whether
      // this session is working. It never becomes a step ring.
      //
      // It used to. A session on a counted arc wore the segmented ring, and
      // once the track arrived on the title line beside it that was two marks
      // drawing the same step count in two geometries, disagreeing whenever
      // one of them lagged. The track is the arc's whole life and the better
      // reading of it, so the ring yields the subject entirely: an arc says
      // its progress in the track and nowhere else on this row.
      //
      // The segmented ring is not retired — it is what a task list that is NOT
      // an arc still wears, which is the case it now uniquely means.
      indicator={<SessionPhaseDot sessionId={sessionId} size={dotSize} drift={drift} />}
      // No size, no ink correction under column packing: the row falls back to
      // packing at the stylesheet's own advance, which a masthead asks for
      // outright.
      indicatorSize={indicatorPacking === "column" ? undefined : dotSize}
      name={
        nameProps !== undefined ? (
          <span {...nameProps}>{titleRun}</span>
        ) : (
          titleRun
        )
      }
      description={descriptionRun}
      descriptionFull={descriptionFull}
      descriptionElided={description !== descriptionFull}
      descriptionStandIn={descriptionStandIn}
      activity={activity}
      sparkline={sparkline}
      style={style}
      {...rest}
      // After the mount's own props, deliberately: the row-wide menu is the
      // last word on the right-click, and the element the responder registers
      // on has to be this one. No mount site passes either today.
      ref={menu.ref as React.Ref<HTMLDivElement>}
      // CAPTURE, so the row is asked before anything inside it. The runs are
      // copyables in their own right — the title sits inside a `TugLabel`, and
      // a label is intrinsically copyable — so on the bubble the title's press
      // was claimed by the label and answered with Cut/Copy/Paste/Select All
      // over the label's text, which is the row's title spelled out rather
      // than the session. One menu for the row means the row is asked first.
      onContextMenuCapture={menu.onContextMenu}
    />
    {menu.contextMenu}
    </>
  );
}
