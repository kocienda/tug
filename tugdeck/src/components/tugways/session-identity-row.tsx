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
 * `pulse/enabled` gate, and two copies of the sparkline. A shape can only make
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
 * ladders, the beat grammar, the `pulse/enabled` gate) or is a piece of the
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
 * rest sentence. The overrides exist for facts a row knows that the pulse feed
 * cannot report — a session held by a terminal, a row whose one fact is that it
 * failed to resume.
 *
 * The feed is read only when {@link SessionIdentityRowProps.beats} says this row
 * is live, and that gate is load-bearing rather than an optimization:
 * `latestLineForScope` answers with app-wide ambience for any scope, so a closed
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
import { ArcLifecycleMark } from "@/components/tugways/arc-lifecycle-mark";
import {
  arcSessionPurpose,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";
import { arcGlanceFraction } from "@/lib/arc-meta-facts";
import { PulseBeatText } from "@/components/tugways/pulse-beat-text";
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
  COMPACTING_PULSE_TEXT,
  useIsCompactingCard,
} from "@/lib/compaction-progress-store";
import { parseBeatFileTarget } from "@/lib/pulse-line/beat-file-target";
import { formatRestingStamp } from "@/lib/pulse-line/resting-line";
import { renderPulseLine } from "@/lib/pulse-line/render-pulse-line";
import { latestLineForScope, usePulse } from "@/lib/pulse-store";
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
  key: "__pulse_compacting__",
  text: COMPACTING_PULSE_TEXT,
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
    return <PulseBeatText text={entry.text} className={className} />;
  }
  return <span className={className}>{entry.text}</span>;
}

/**
 * The activity run, through the markdown pipeline.
 *
 * A beat is a tool call, so backticked paths and commands are exactly what the
 * pipeline is for. The pulse-line library owns fidelity and safety (math-first
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
      entry.placeholder || fileBeat !== null ? null : renderPulseLine(entry.text),
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
    return <PulseBeatText text={entry.text} className={className} />;
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
 * rather than a leaf inside it. `TugPulse` measures its own middle truncation in
 * an effect that runs when `TugPulse` renders; a dwell living below it swaps the
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
   * Whether this row reads the live pulse feed.
   *
   * Load-bearing rather than an optimization: `latestLineForScope` answers with
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
  nameProps,
  identityMenu = false,
  hostCardId,
  className,
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

  const pulse = usePulse();
  // Scoped to THIS card, not the whole runs map: a map snapshot changes
  // identity on every write to any card, so one `/compact` re-rendered every
  // session row in the app. A row with no card subscribes to nothing at all.
  const compacting = useIsCompactingCard(cardId);

  // ── The description ladder ([D132]) ───────────────────────────────────
  const prompt = facts?.last_user_prompt?.trim() ?? "";
  const descriptionSource = sessionDescription({
    synopsis: identity.description,
    prompt,
    arc: arcModel,
    createdAtMs,
  });
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
  const descriptionStandIn = identity.description === null;

  // ── The activity ladder ───────────────────────────────────────────────
  // The bare `Done` marker is filtered on the way in: it is the ABSENCE of a
  // beat, and the rest sentence says the same thing with facts in it.
  const beat =
    beats && pulse.enabled
      ? sessionActivityBeat(
          latestLineForScope(pulse.lines, sessionId, pulse.cleared.get(sessionId)),
        )
      : null;
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
        : beat !== null
          ? { key: beat.key, text: beat.text, placeholder: false }
          : composedEntry(restLine);
  // Paced HERE rather than in a leaf, so a swap re-renders the row and
  // `TugPulse` measures the new text — see {@link useDwellDisplay}.
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
      identity.description === null && prompt.length === 0 ? null : descriptionFull,
    activity: beat?.text ?? null,
    hostCardId,
    enabled: identityMenu,
  });
  const ActivityRun = markdown ? ActivityMarkdownText : ActivityText;
  const activity = (
    <ActivityRun
      entry={entry}
      highlight={highlight}
      className={activityClassName}
    />
  );

  // ── The tape ──────────────────────────────────────────────────────────
  // Unconditional wherever the mount asks for one — a session that has done no
  // work yet shows a FLATLINE, which is the instrument reading zero rather than
  // the instrument being absent. An accessory that comes and goes with the
  // data it reports is one the reader cannot trust: nothing on screen
  // distinguishes "this session is quiet" from "the tape is not here", and the
  // line beneath it moves out to the row's edge and back every time the
  // distinction flips. `pulse/enabled` does not gate it either, for the same
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
      description={renderFilterHighlight(description, highlight)}
      descriptionFull={descriptionFull}
      descriptionElided={description !== descriptionFull}
      descriptionStandIn={descriptionStandIn}
      activity={activity}
      sparkline={sparkline}
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
