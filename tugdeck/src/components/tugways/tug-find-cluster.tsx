/**
 * `TugFindCluster` — the shared find cluster: Case / Word / Grep option
 * toggles plus a width-stabilized match-count chip, driven by any
 * {@link FindSurface} (the Dev transcript's store-index engine, the Text
 * card's CodeMirror-search engine).
 *
 * Two pieces, count first — the cluster sits at the trailing edge of the find
 * bar's toolbar, so the count reads leftmost, then the toggles that shape it,
 * then the host's ↑ / ↓ pair. Result, then controls, in one group:
 *
 *  - **Count** — a read-only `‹active+1› of ‹total›` {@link TugBadge}
 *    (tinted / action — the same coloration as the Z4B Mode / Model /
 *    Effort chips; `No results` on a hitless query; `N+` when the engine
 *    capped its enumeration), width-stabilized via {@link TugStableOverlay}
 *    so stepping through matches never reflows the cluster. A badge is a
 *    label, never a control — it emits no action, and it hides (never
 *    unmounts) when there is no query, so the cluster's width is steady.
 *
 *  - **Options** — a {@link TugOptionGroup} of three independent toggles
 *    (Case sensitive · Entire word · Grep). Per [L11] the group emits a
 *    `setValue` action carrying the new active `string[]`; this component
 *    owns the responder (a `useResponderForm` `setValueStringArray` slot)
 *    that maps the set back to {@link FindOptions} and hands it to
 *    `surface.setOptions` (the engine re-runs its search and persists as it
 *    sees fit). The option value is *read* from the same surface snapshot
 *    ([L02]) — the engine is the single source, the group is a controlled
 *    face over it.
 *
 * **Refuses focus-steal ([L11]).** The toggle buttons carry
 * `data-tug-focus="refuse"` (from `TugOptionGroup`) so a click never pulls
 * first-responder off the host's editor mid-search; the count chip is inert
 * text with no tab stop of its own.
 *
 * Laws: [L02] surface read via `useSyncExternalStore`, [L06] no appearance in
 * React state, [L11] control emits action / responder owns the mutation.
 *
 * @module components/tugways/tug-find-cluster
 */

import "./tug-find-cluster.css";

import React, { useCallback, useId, useMemo, useSyncExternalStore } from "react";
import { CaseSensitive, Regex, WholeWord } from "lucide-react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugOptionGroup, type TugOptionItem } from "@/components/tugways/tug-option-group";
import { TugStableOverlay } from "@/components/tugways/internal/tug-stable-overlay";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { FindSurface } from "@/lib/find-surface";
import type { FindOptions } from "@/lib/transcript-search";

/** Option-group item values — one per {@link FindOptions} axis. */
const OPTION_CASE = "case";
const OPTION_WORD = "word";
const OPTION_GREP = "grep";

/** Icon size for the toggle glyphs — sized up so the Aa / ab / .* marks read
 *  clearly at chip scale. */
const OPTION_ICON_SIZE = 18;

/** The fixed toggle set, ordered Case · Word · Grep. Each carries a native
 *  tooltip so the icon-only glyphs are legible on hover (esp. the regex mark). */
const OPTION_ITEMS: TugOptionItem[] = [
  {
    value: OPTION_CASE,
    icon: <CaseSensitive size={OPTION_ICON_SIZE} />,
    "aria-label": "Match case",
    title: "Match case",
  },
  {
    value: OPTION_WORD,
    icon: <WholeWord size={OPTION_ICON_SIZE} />,
    "aria-label": "Match whole word",
    title: "Match whole word",
  },
  {
    value: OPTION_GREP,
    icon: <Regex size={OPTION_ICON_SIZE} />,
    "aria-label": "Use regular expression",
    title: "Regular expression (grep)",
  },
];

/** Project the active-value set the option group renders from the options. */
function optionsToValues(options: FindOptions): string[] {
  const out: string[] = [];
  if (options.caseSensitive) out.push(OPTION_CASE);
  if (options.wholeWord) out.push(OPTION_WORD);
  if (options.grep) out.push(OPTION_GREP);
  return out;
}

/** Fold the option group's active-value set back into {@link FindOptions}. */
function valuesToOptions(values: string[]): FindOptions {
  return {
    caseSensitive: values.includes(OPTION_CASE),
    wholeWord: values.includes(OPTION_WORD),
    grep: values.includes(OPTION_GREP),
  };
}

export interface TugFindClusterProps {
  /** The find engine — read for options + count, written on toggle. */
  surface: FindSurface;
  /** Author the option group into the host's focus cycle. */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
}

/**
 * The shared find cluster: Case/Word/Grep toggles + a width-stabilized
 * match-count chip. See the module docstring for the surface/responder wiring.
 */
export function TugFindCluster({
  surface,
  focusGroup,
  focusOrder,
}: TugFindClusterProps): React.ReactElement {
  const snapshot = useSyncExternalStore(
    useCallback((cb: () => void) => surface.subscribe(cb), [surface]),
    surface.getSnapshot,
  );

  const senderId = useId();
  const handleSetOptions = useCallback(
    (values: string[]) => {
      surface.setOptions(valuesToOptions(values));
    },
    [surface],
  );

  const { ResponderScope } = useResponderForm({
    setValueStringArray: { [senderId]: handleSetOptions },
  });

  const activeValues = useMemo(
    () => optionsToValues(snapshot.options),
    [snapshot.options],
  );

  // Count face: no query → nothing; a query with no hits → "No results";
  // otherwise the engine's authoritative "N of M" (`M+` when capped), with
  // "· not in view" appended when the host could not put the active match
  // on screen ([P09]) — a counted match nobody can see is a fact the chip
  // owes the reader rather than one it hides behind a confident ordinal.
  const total = snapshot.count;
  const revealFailed = snapshot.revealFailed && total > 0;
  const countText =
    total > 0
      ? `${(snapshot.activeOrdinal ?? 0) + 1} of ${total}${snapshot.capped ? "+" : ""}` +
        (revealFailed ? " · not in view" : "")
      : snapshot.hasQuery
        ? "No results"
        : "";

  return (
    <ResponderScope>
      <div className="tugx-find-cluster" data-slot="find-cluster">
        <TugBadge
          emphasis="tinted"
          role="action"
          size="sm"
          // Two-line chip, matching the Z4B legend discipline (the PROJECT /
          // MODE / MODEL chips): letter-spaced caption above the value.
          layout="label-top"
          label="RESULTS"
          className="tugx-find-count"
          data-slot="find-count"
          // Queryless → no badge. Rendered as a data attribute from the
          // snapshot (not a CSS `:has(:empty)` probe — WebKit's `:has`
          // invalidation is unreliable when the value span's text mutates
          // in place, leaving the badge stuck hidden with a live count).
          data-empty={countText === "" ? "" : undefined}
          data-reveal-failed={revealFailed ? "" : undefined}
          aria-live="polite"
          copyText={`Results: ${countText}`}
        >
          <TugStableOverlay
            active={<span data-slot="find-count-value">{countText}</span>}
            // The wide sizer is pushed ONLY while the failed face is live.
            // `TugStableOverlay` sizes its cell to the widest declared
            // variant and pins a monotonic `min-width` high-water mark, so
            // declaring the long face unconditionally would widen the chip
            // by ~14 characters in every session that ever opens find. The
            // consequence of the conditional: once a reveal has failed, the
            // high-water mark holds the wider size for the rest of THIS
            // bar's life. The bar unmounts on close, so the reservation
            // resets with it, and within one open bar a chip that has said
            // "not in view" once keeps the room to say it again.
            alternates={
              revealFailed
                ? ["No results", "888 of 888 · not in view"]
                : ["No results", "888 of 888"]
            }
          />
        </TugBadge>
        <TugOptionGroup
          size="sm"
          emphasis="default"
          role="action"
          items={OPTION_ITEMS}
          value={activeValues}
          senderId={senderId}
          aria-label="Find options"
          focusGroup={focusGroup}
          focusOrder={focusOrder}
        />
      </div>
    </ResponderScope>
  );
}
