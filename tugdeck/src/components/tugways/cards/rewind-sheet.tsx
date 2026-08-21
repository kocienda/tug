/**
 * rewind-sheet.tsx — the `/rewind` cut-line picker + restore-scope sheet
 * ([#step-7-3]).
 *
 * `/rewind` is a turns-within-this-session picker (NOT the `/resume` sessions
 * chooser — [D05]). {@link useRewindSheet} owns the sheet once at the card
 * level (mirroring {@link useAiConfigSheet}): the session card wires `openRewindSheet`
 * to its `rewind` `RUN_SLASH_COMMAND` handler and presents it through the
 * shared `cardPickerSheet` host as a **wide** card-scoped overlay ([D15]).
 *
 * **The gesture is a cut, not a pick.** The list shows every user message in
 * the session as it was typed, oldest first. The user places a line between
 * two of them: everything above the line is **kept**, everything below is
 * **discarded**, and the last kept message is the rewind point. Selecting a
 * row IS placing the line below it — click or walk with the arrows — so the
 * list carries no synthetic "present" row; the line simply rests below the
 * last message when nothing is being discarded, which is how the sheet opens
 * (Rewind disabled until the line moves up). The line can never sit above the
 * first message: claude refuses a session with no retained submission
 * (`no_retained_turns`).
 *
 * Below the list an inline `TugChoiceGroup` picks the restore scope —
 * *Conversation* or *Code + conversation* (the code segment enables only when
 * the cut has a restorable checkpoint, reported by its lazy diff-stat). Cancel
 * / Rewind sit at the bottom, Rewind as the default (Enter), to the right of
 * Cancel.
 *
 * The anchor `session_rewind` takes is the FIRST DISCARDED message — tugcode
 * chops that turn and everything past it ([#step-7-2]) — so a line below row
 * `i` sends `rows[i + 1]`. Diff-stats are fetched per anchor (one batch on
 * open, cached in the store snapshot's `rewindPreviews`) and read via
 * `useSyncExternalStore` ([L02]). A cut whose conversation rewind would cross
 * a `/compact` boundary is unpickable — the row stays visible and says why.
 * The sheet dismisses on a successful `rewind_result` ack and surfaces the
 * error otherwise (the local L26-safe truncation runs in the store on the ack).
 *
 * Compositional — composes `TugSheet`, `TugListView`, `TugChoiceGroup`,
 * `TugPushButton`; composed children keep their own tokens ([L20]). The
 * `TugChoiceGroup` is a control: it emits `selectValue` through the responder
 * chain, captured by a `useResponderForm` binding here ([L11]).
 *
 * Laws: [L02] store reads via the store API, [L06] appearance via CSS,
 *       [L11] controls emit / the form captures, [L19] authoring guide,
 *       [L20] composed children keep tokens, [L26] picker rows reconcile
 *       through a module-constant `cellRenderers` (never inline lambdas).
 * Decisions: [D05] sheet-not-shared, [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/rewind-sheet
 */

import "./rewind-sheet.css";

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { presentAlertSheet } from "@/components/tugways/tug-alert-sheet";
import {
  TugChoiceGroup,
  type TugChoiceItem,
} from "@/components/tugways/tug-choice-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type {
  CodeSessionSnapshot,
  RewindTurnPreview,
} from "@/lib/code-session-store/types";
import {
  projectRewindTurns,
  REWIND_MESSAGE_KIND,
  RewindTurnDataSource,
  type RewindMessageRow,
} from "./rewind-turn-source";

type RewindScope = "conversation" | "both";

// ---------------------------------------------------------------------------
// useRewindSheet — the card-hosted /rewind sheet
// ---------------------------------------------------------------------------

export interface UseRewindSheetArgs {
  /** Store supplying the transcript projection + the rewind round-trips. */
  codeSessionStore: CodeSessionStore;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface RewindSheetController {
  /** Present the sheet over the current transcript. A no-op when there is
   *  nothing to rewind to (the popup gates this, but guard defensively). */
  openRewindSheet: () => void;
}

export function useRewindSheet({
  codeSessionStore,
  showSheet,
}: UseRewindSheetArgs): RewindSheetController {
  const openRewindSheet = useCallback(() => {
    // `/rewind` is never a silent no-op. A cut needs a message to keep and a
    // message to discard, so a 0- or 1-message session has nowhere to put the
    // line: present a "Can't rewind" alert explaining why.
    const rows = projectRewindTurns(codeSessionStore.getSnapshot().transcript);
    if (rows.length < 2) {
      void presentAlertSheet(showSheet, {
        title: "Can't Rewind",
        message:
          "Rewind splits your messages into the ones you keep and the ones " +
          "you discard, so it needs at least two. A fresh session — or one " +
          "the last /compact reset — has nothing earlier to return to.",
      });
      return;
    }
    void showSheet({
      title: "Rewind",
      icon: "History",
      description:
        "Place the line. Messages above it are kept — the last one is where " +
        "you return to. Messages below it are discarded.",
      displayWidth: "lg",
      content: (close) => (
        <RewindSheetBody
          rows={rows}
          codeSessionStore={codeSessionStore}
          onClose={close}
        />
      ),
    });
  }, [showSheet, codeSessionStore]);

  return { openRewindSheet };
}

// ---------------------------------------------------------------------------
// Cell — one user message, kept or discarded, with the cut line under the
// rewind point
// ---------------------------------------------------------------------------

/**
 * Read-only context the message cells consume: where the line sits and what
 * it says. `onSelect` lives on the delegate (in body scope); the context only
 * carries render inputs, keeping cells presentational ([L11]).
 */
interface RewindCellContextValue {
  /** Index of the first DISCARDED row; `rows.length` when nothing is cut. */
  cutIndex: number;
  /** Rows the line may not rest below (their cut crosses a `/compact`). */
  blockedCuts: ReadonlySet<number>;
  /** The label the cut line carries — the discard count + code diff-stat. */
  cutLabel: string;
}
const RewindCellContext = React.createContext<RewindCellContextValue>({
  cutIndex: 0,
  blockedCuts: new Set(),
  cutLabel: "",
});

/** Format a cut's diff-stat for the cut line. */
function diffStatLabel(preview: RewindTurnPreview | undefined): string {
  if (preview === undefined) return "";
  if (preview.loading) return "…";
  if (!preview.canRewind) return "no code changes";
  const ins = preview.insertions ?? 0;
  const del = preview.deletions ?? 0;
  if (ins === 0 && del === 0) return "no code changes";
  return `+${ins} −${del}`;
}

/**
 * Format a message's wall-clock `submitAt` for the row subtitle — a
 * friendly day + time (`Today, 3:45 PM`, `Yesterday, 11:20 AM`, or
 * `Jun 19, 3:45 PM`; the year is added once it differs from now).
 * Returns "" when the timestamp is missing or unparseable, so a message
 * with no recorded time simply shows no subtitle.
 */
function submittedAtLabel(submitAt: number): string {
  if (!Number.isFinite(submitAt) || submitAt <= 0) return "";
  const when = new Date(submitAt);
  if (Number.isNaN(when.getTime())) return "";
  const now = new Date();
  const time = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDelta = Math.round(
    (startOfDay(now) - startOfDay(when)) / 86_400_000,
  );
  let day: string;
  if (dayDelta === 0) day = "Today";
  else if (dayDelta === 1) day = "Yesterday";
  else {
    day = when.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(when.getFullYear() !== now.getFullYear()
        ? { year: "numeric" }
        : {}),
    });
  }
  return `${day}, ${time}`;
}

const RewindMessageCell: TugListViewCellRenderer<RewindTurnDataSource> =
  function RewindMessageCell({
    index,
    dataSource,
  }: TugListViewCellProps<RewindTurnDataSource>): React.ReactElement {
    const { cutIndex, blockedCuts, cutLabel } =
      React.useContext(RewindCellContext);
    const row = dataSource.rowAt(index);
    const isRewindPoint = index === cutIndex - 1;
    const discarded = index >= cutIndex;
    const blocked = blockedCuts.has(index);
    const state = discarded ? "discarded" : isRewindPoint ? "point" : "kept";
    const title = row.text.trim().length > 0 ? row.text : "(empty prompt)";
    const when = submittedAtLabel(row.submitAt);
    // A reserved non-breaking space keeps timestamp-less rows the same height
    // as rows that carry a subtitle, so the list reads as an even stack.
    const subtitle = blocked
      ? "Can't rewind past a /compact"
      : when.length > 0
        ? when
        : " ";
    return (
      <>
        <TugListRow
          title={title}
          titleMaxLines={3}
          subtitle={subtitle}
          selected={isRewindPoint}
          disabled={blocked}
          data-testid="rewind-message-row"
          data-rewind-state={state}
          data-prompt-uuid={row.promptUuid}
        />
        {isRewindPoint ? (
          <div
            className="rewind-cut"
            data-armed={cutIndex < dataSource.numberOfItems() ? "true" : "false"}
            data-testid="rewind-cut"
          >
            <span className="rewind-cut-label">{cutLabel}</span>
          </div>
        ) : null}
      </>
    );
  };

/** Module-constant renderer map ([L26]): one stable reference shared by every
 *  row so picker rows reconcile as the same element across re-renders — never
 *  inline lambdas. */
const REWIND_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<RewindTurnDataSource>
> = {
  [REWIND_MESSAGE_KIND]: RewindMessageCell,
};

// ---------------------------------------------------------------------------
// Sheet body — message list with the cut line + restore-scope choice + actions
// ---------------------------------------------------------------------------

interface RewindSheetBodyProps {
  rows: RewindMessageRow[];
  codeSessionStore: CodeSessionStore;
  onClose: (value?: string) => void;
}

function RewindSheetBody({
  rows,
  codeSessionStore,
  onClose,
}: RewindSheetBodyProps): React.ReactElement {
  // Live store reads ([L02]): preview cache, applied-ack, and idle phase.
  const snapshot = useSyncExternalStore<CodeSessionSnapshot>(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );
  const previews = snapshot.rewindPreviews;
  const isIdle = snapshot.phase === "idle";

  // The line rests below the LAST message on open — everything kept, nothing
  // discarded — so the sheet opens doing nothing until the user walks it back
  // in time. `rewindPointIndex` is the last KEPT row; the cut (the first
  // discarded row) is the index after it.
  const [rewindPointIndex, setRewindPointIndex] = useState(rows.length - 1);
  const [scope, setScope] = useState<RewindScope>("conversation");
  const [applyingUuid, setApplyingUuid] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const cutIndex = rewindPointIndex + 1;
  const discardCount = rows.length - cutIndex;
  // The `session_rewind` anchor: the FIRST discarded message. `null` while the
  // line rests at the end (nothing to discard — Rewind stays disabled).
  const anchor = discardCount > 0 ? rows[cutIndex] : null;
  const anchorPreview =
    anchor !== null ? previews.get(anchor.promptUuid) : undefined;

  // The scope choice group is a control: it emits `selectValue` through the
  // chain; this form binding captures it into local state ([L11]).
  const scopeGroupId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [scopeGroupId]: (v: string) =>
        setScope(v === "both" ? "both" : "conversation"),
    },
  });

  const dataSource = useMemo(() => new RewindTurnDataSource(rows), [rows]);

  // The line cannot rest below a row whose cut would cross a `/compact`
  // boundary (tugcode reports `conversationRewindable:false` for that anchor —
  // both sheet scopes truncate the conversation). Such rows stay visible and
  // say why, but the list refuses to land on them. A preview still loading
  // (`undefined`) is treated as permitted, so an uncompacted session is fully
  // walkable immediately with no flicker.
  const blockedCuts = useMemo(() => {
    const blocked = new Set<number>();
    for (let i = 0; i < rows.length - 1; i++) {
      if (previews.get(rows[i + 1].promptUuid)?.conversationRewindable === false) {
        blocked.add(i);
      }
    }
    return blocked;
  }, [rows, previews]);
  // Enablement reaches the list through the data source's own tick — never a
  // rebuild, which would re-seed the selection out from under the user.
  useEffect(() => {
    dataSource.setBlockedCuts(blockedCuts);
  }, [dataSource, blockedCuts]);

  // The line opens at the very end of the list, and it hangs below its row —
  // so the seeded scroll, which only has to reveal the ROW, leaves the line
  // itself a few pixels past the bottom edge. Land the list on its true
  // content bottom once the rows have laid out, so the resting line is whole.
  const listRef = useRef<TugListViewHandle | null>(null);
  useLayoutEffect(() => {
    listRef.current?.scrollToBottom({ animated: false });
  }, [rows.length]);

  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      // Selecting a row IS placing the line below it.
      onSelect: (index) => {
        if (index < 0 || index >= rows.length) return;
        setRewindPointIndex(index);
      },
    }),
    [rows.length],
  );

  // Fetch every cut's diff-stat once, when the sheet opens, so moving the line
  // shows its `+N −M` / "no code changes" immediately rather than popping in.
  // Every message except the first is a possible anchor (the first can never
  // be discarded — the retained prefix must hold one submission). Cached in
  // the store, so re-opening the sheet re-fetches nothing.
  useEffect(() => {
    const cached = codeSessionStore.getSnapshot().rewindPreviews;
    for (let i = 1; i < rows.length; i++) {
      if (!cached.has(rows[i].promptUuid)) {
        codeSessionStore.requestRewindPreview(rows[i].promptUuid);
      }
    }
  }, [rows, codeSessionStore]);

  // Code restore is offered only when the cut has a restorable checkpoint with
  // actual changes (its lazy diff-stat says so).
  const codeRestorable =
    anchorPreview !== undefined &&
    !anchorPreview.loading &&
    anchorPreview.canRewind &&
    (anchorPreview.insertions ?? 0) + (anchorPreview.deletions ?? 0) > 0;
  // If "both" is picked but the current cut can't restore code, the effective
  // (and displayed) scope falls back to conversation.
  const effectiveScope: RewindScope =
    scope === "both" && codeRestorable ? "both" : "conversation";

  const scopeItems: TugChoiceItem[] = [
    { value: "conversation", label: "Conversation" },
    { value: "both", label: "Code + conversation", disabled: !codeRestorable },
  ];

  // What the line itself says: how much it discards, and what the code side of
  // that cut would restore.
  const cutBlocked = blockedCuts.has(rewindPointIndex);
  const cutLabel = cutBlocked
    ? "Can't rewind past a /compact"
    : discardCount === 0
      ? "Nothing discarded — move the line up"
      : [
          `${discardCount} message${discardCount === 1 ? "" : "s"} discarded`,
          diffStatLabel(anchorPreview),
        ]
          .filter((seg) => seg.length > 0)
          .join(" · ");

  // React to OUR applied rewind's ack: dismiss on success, surface the error
  // (and re-enable) on failure ([L02]).
  const ack = snapshot.lastRewindResult;
  useEffect(() => {
    if (
      applyingUuid === null ||
      ack === null ||
      ack.promptUuid !== applyingUuid
    ) {
      return;
    }
    if (ack.canRewind) {
      onClose(applyingUuid);
    } else {
      setApplyingUuid(null);
      setErrorMsg(ack.error ?? "Rewind failed.");
    }
  }, [applyingUuid, ack, onClose]);

  // Block Rewind if the cut's conversation rewind would error (e.g. a preview
  // that resolved to not-rewindable after the line was placed).
  const canApply =
    anchor !== null &&
    isIdle &&
    applyingUuid === null &&
    !cutBlocked &&
    anchorPreview?.conversationRewindable !== false;
  const apply = useCallback(() => {
    if (anchor === null || !isIdle) return;
    setErrorMsg(null);
    setApplyingUuid(anchor.promptUuid);
    // Fork is the default for conversation/both ([#step-7-2]). The first
    // discarded message rides along as the draft: on a successful ack the
    // store offers it back in the composer for re-edit (both sheet scopes
    // truncate the conversation, so the draft applies to either).
    codeSessionStore.sessionRewind(anchor.promptUuid, effectiveScope, true, {
      text: anchor.text,
      atoms: anchor.atoms,
    });
  }, [anchor, isIdle, effectiveScope, codeSessionStore]);

  // Author the controls into the sheet's trapped focus mode: Tab walks the
  // message list → Cancel → Rewind. Single-select picker: the list is seeded as
  // the key view with the last message selected (the line at the end, nothing
  // discarded), so the sheet opens doing nothing, Rewind disabled, until
  // ArrowUp walks the line back in time. Rewind keeps its
  // `persistentDefaultRing` as the surface default; Return falls through the
  // list to it. The no-target case never reaches here — it's the "Can't
  // rewind" alert.
  const focusGroup = useId();
  const LIST_ORDER = 0;
  const CANCEL_ORDER = 1;
  const REWIND_ORDER = 2;
  useSeedKeyView(`${focusGroup}:${LIST_ORDER}`);

  return (
    <ResponderScope>
      <div
        className="rewind-sheet"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <RewindCellContext.Provider
          value={{ cutIndex, blockedCuts, cutLabel }}
        >
          {/* Reuse the session picker's section + bordered host so the two
              pickers read the same ([L20] cascade-scoped). */}
          <div className="session-card-picker-section">
            <span className="session-card-picker-label">Messages</span>
            <div className="session-card-picker-sessions-host">
              <TugListView<RewindTurnDataSource>
                ref={listRef}
                dataSource={dataSource}
                delegate={delegate}
                cellRenderers={REWIND_CELL_RENDERERS}
                scrollKey="rewind-turns"
                rowLayout="flush"
                className="session-card-picker-sessions-list session-card-picker-list-view"
                focusGroup={focusGroup}
                focusOrder={LIST_ORDER}
                singleSelect
                seedSelection
                initialSelectedIndex={rows.length - 1}
              />
            </div>
          </div>
        </RewindCellContext.Provider>

        <div className="rewind-scope-row">
          <TugLabel emphasis="proposal">Restore</TugLabel>
          <TugChoiceGroup
            items={scopeItems}
            value={effectiveScope}
            senderId={scopeGroupId}
            size="sm"
            disabled={anchor === null}
            aria-label="Restore scope"
            data-testid="rewind-scope"
          />
        </div>

        {!isIdle ? (
          <p className="rewind-busy" role="status">
            Claude is busy — wait for the current turn to finish.
          </p>
        ) : null}
        {errorMsg !== null ? (
          <p className="rewind-error" role="alert">
            {errorMsg}
          </p>
        ) : null}

        <div className="tug-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            onClick={() => onClose()}
            data-testid="rewind-cancel"
            focusGroup={focusGroup}
            focusOrder={CANCEL_ORDER}
          >
            Cancel
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="primary"
            disabled={!canApply}
            onClick={apply}
            data-testid="rewind-apply"
            focusGroup={focusGroup}
            focusOrder={REWIND_ORDER}
            persistentDefaultRing
          >
            Rewind
          </TugPushButton>
        </div>
      </div>
    </ResponderScope>
  );
}
