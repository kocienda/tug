/**
 * resume-sheet.tsx — the `/resume` focused sessions overlay + its card-hosted
 * hook ([#step-8]).
 *
 * `/resume` ≠ `/rewind` ([D05]): it picks among the project's *distinct prior
 * sessions* and rebinds THIS card to the chosen conversation (a genuine resume
 * → replay rebuilds the transcript), where `/rewind` ([#step-7-3]) picks among
 * turns within the current session. They share no component — only the
 * card-scoped overlay shell ([D15]).
 *
 * This is NOT the full-card `SessionProjectPicker` (project-path entry + recents +
 * sessions, shown when no session is bound). It is a focused overlay that
 * reuses the EXISTING sessions data source + `SESSIONS_CELL_RENDERERS` over the
 * card's already-bound project — sessions only, no path/recents chrome. The
 * cold-boot / empty-card picker is untouched.
 *
 * Picking a non-live session resumes it (`fireRestore` — same path the full
 * picker's Open uses, which a live card's rebind goes through); "New session"
 * spawns a fresh one. Cancel / ESC / backdrop dismiss and leave the live
 * session intact. The wire send is deferred past the sheet's exit animation so
 * the binding flip doesn't unmount the sheet mid-animation (mirrors
 * `SessionProjectPicker`'s Open).
 *
 * Compositional — composes `TugSheet`, `TugListView`, `TugPushButton`; the
 * reused session cells keep their own tokens ([L20]).
 *
 * Laws: [L02] store reads via the store API, [L11] cells emit, the form owns
 *       state, [L19] authoring guide, [L20] composed children keep tokens,
 *       [L26] rows reconcile through the module-constant `SESSIONS_CELL_RENDERERS`.
 * Decisions: [D05] sheet-not-shared, [D15] pane sheets are overlays,
 *            [D23] local slash-command dispatch.
 *
 * @module components/tugways/cards/resume-sheet
 */

import "./resume-sheet.css";

import React, { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import {
  TugFilterField,
  type TugFilterFieldDelegate,
} from "@/components/tugways/tug-filter-field";
import { useAttachedFilter } from "@/components/tugways/attached-filter";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  useFocusManager,
  useSeedKeyView,
} from "@/components/tugways/use-focusable";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import {
  TugListView,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import {
  useSessionsDataSource,
  type SessionsDataSource,
} from "@/lib/session-picker-data-source";
import { useSessionLedger } from "@/lib/session-ledger-store";
import { SESSIONS_CELL_RENDERERS, PickerCellProvider } from "./session-picker-cells";
import { getConnection } from "@/lib/connection-singleton";
import {
  provisionSpawnLine,
  provisionSpawnTag,
  sendSpawnSession,
} from "@/lib/session-lifecycle";
import { fireRestore } from "@/lib/session-restore";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { sessionTagStore } from "@/lib/session-tag-store";
import { sessionLineStore } from "@/lib/session-line-store";
import { MODAL_REST_LINE } from "./modal-rest-line";

// Mirrors `session-card.tsx`'s sheet exit duration: defer the wire send so the
// binding flip (which rebinds + re-renders the card) doesn't unmount the sheet
// mid-exit-animation.
const SHEET_EXIT_ANIMATION_MS = 220;

export interface UseResumeSheetArgs {
  cardId: string;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface ResumeSheetController {
  /** Present the sessions overlay. A no-op when the card has no bound project
   *  (the popup gates `/resume` on a bound session). */
  openResumeSheet: () => void;
  /**
   * Resume the session wearing `tag`, with no overlay in between ([P12]) —
   * `/resume stocky-pixie` typed straight into the composer.
   *
   * Returns why it could not, or `null` on success, so the caller can say so in
   * the card rather than failing silently. It reaches the same `fireRestore`
   * the overlay's pick reaches; the overlay is a way to CHOOSE a session, and
   * naming one is another.
   */
  resumeByTag: (tag: string) => ResumeByTagFailure | null;
}

/** Why a `/resume <tag>` could not proceed. */
export type ResumeByTagFailure =
  /** No session in this run's ledger cache wears that callsign. */
  | { kind: "unknown-tag"; tag: string }
  /** It resolved to the session this card is already showing. */
  | { kind: "already-bound"; tag: string }
  /** Another process holds it — the same rule the overlay's rows enforce. */
  | { kind: "live-elsewhere"; tag: string }
  /** No transport. */
  | { kind: "disconnected"; tag: string };

export function useResumeSheet({
  cardId,
  showSheet,
}: UseResumeSheetArgs): ResumeSheetController {
  // The bound session's project dir, read straight from the binding store
  // ([L02]) — `/resume` lists sessions for the SAME project (a live-session
  // rebind, not a project switch). Stable under a live card.
  const projectDir = useSyncExternalStore(
    (cb) => cardSessionBindingStore.subscribe(cb),
    () => cardSessionBindingStore.getBinding(cardId)?.projectDir ?? "",
  );

  const openResumeSheet = useCallback(() => {
    if (projectDir.length === 0) return;
    void showSheet({
      title: "Resume Session",
      icon: "RotateCcw",
      iconRole: "agent",
      description: "Pick a session to resume in this card.",
      // The same row shape as the Choose Session picker, so the same width.
      displayWidth: "lg",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <ResumeSheetBody cardId={cardId} projectDir={projectDir} onClose={close} />
      ),
    });
  }, [showSheet, cardId, projectDir]);

  // The ledger rows for this card's project — the same source the overlay
  // lists, so a tag and a pick answer to one truth about a session's state.
  const sessionLedger = useSessionLedger(projectDir);

  const resumeByTag = useCallback(
    (tag: string): ResumeByTagFailure | null => {
      // The callsign names a **line**; the session id to resume is the segment
      // that line is seated on ([P06]).
      const lineId = sessionTagStore.lineWearing(tag);
      const sessionId = lineId === null ? null : sessionLineStore.seatOf(lineId);
      if (sessionId === null) return { kind: "unknown-tag", tag };
      if (cardSessionBindingStore.getBinding(cardId)?.tugSessionId === sessionId) {
        return { kind: "already-bound", tag };
      }
      // A session another process holds is unresumable, exactly as the overlay's
      // rows are. Not finding a row at all is NOT that: a callsign this store
      // knows but this project's listing has not returned yet is resumable, and
      // refusing it would make the command depend on scan timing.
      const row = sessionLedger.rows.find((r) => r.session_id === sessionId);
      if (row !== undefined && row.state === "live") {
        return { kind: "live-elsewhere", tag };
      }
      const connection = getConnection();
      if (!connection) return { kind: "disconnected", tag };
      fireRestore(cardId, sessionId, projectDir, connection);
      return null;
    },
    [cardId, projectDir, sessionLedger],
  );

  return { openResumeSheet, resumeByTag };
}

interface ResumeSheetBodyProps {
  cardId: string;
  projectDir: string;
  onClose: (value?: string) => void;
}

function ResumeSheetBody({
  cardId,
  projectDir,
  onClose,
}: ResumeSheetBodyProps): React.ReactElement {
  // The filter narrows the list fuzzily by name / tag / prompt / id. Held as
  // transient local UI state — never persisted.
  const [filterQuery, setFilterQuery] = useState("");
  // The sessions data source for the bound project, fed by the tugcast-side
  // ledger ([L02]) and narrowed by the filter query. `dropNewRowWhenFiltering`
  // is the overlay's safety property: a query that matches nothing yields a
  // truly empty list, so there is no "New session" row to spawn by accident.
  const sessionLedger = useSessionLedger(projectDir);
  const dataSource = useSessionsDataSource(
    projectDir,
    sessionLedger,
    filterQuery,
    true,
  );
  // Seed the sheet's trapped focus onto the filter field so the caret lands
  // there on open (text-first, mirroring the `/rename` sheet).
  const focusGroup = React.useId();
  useSeedKeyView(`${focusGroup}:0`);
  const focusManager = useFocusManager();
  const listRef = React.useRef<TugListViewHandle>(null);
  const filter = useAttachedFilter(() => listRef.current);
  // The filter field's contract: report each keystroke into local state, hand
  // the key view to the list on ArrowDown, and close the sheet on an Escape
  // the field itself declined (an already-empty query).
  const filterDelegate = useMemo<TugFilterFieldDelegate>(
    () => ({
      filterFieldDidChangeQuery: setFilterQuery,
      filterFieldDidRequestDismiss: () => {
        onClose();
      },
      // The sheet opens with the caret in this field ([P12] seed rule), so
      // ↑/↓ must reach the sessions list from there ([P08]).
      ...filter.delegate,
    }),
    [cardId, focusGroup, focusManager, onClose, filter],
  );

  // Pick-to-resume: a row rebinds + resumes (or spawns a new session), then
  // dismisses. Live-elsewhere and loading rows are inert.
  const resumeAt = useCallback(
    (index: number): void => {
      const row = dataSource.rowAt(index);
      const connection = getConnection();
      if (!connection) {
        console.warn("ResumeSheet: connection unavailable");
        return;
      }
      if (row.kind === "session-resume") {
        if (row.row.state === "live") return; // can't resume live-elsewhere
        const sessionId = row.row.session_id;
        onClose("resume");
        window.setTimeout(() => {
          fireRestore(cardId, sessionId, projectDir, connection);
        }, SHEET_EXIT_ANIMATION_MS);
      } else if (row.kind === "session-new") {
        const sessionId = crypto.randomUUID();
        const lineId = provisionSpawnLine(sessionId);
        const tag = provisionSpawnTag(lineId);
        onClose("new");
        window.setTimeout(() => {
          sendSpawnSession(
            connection,
            cardId,
            sessionId,
            projectDir,
            "new",
            tag,
            lineId,
          );
        }, SHEET_EXIT_ANIMATION_MS);
      }
      // "loading" — inert.
    },
    [dataSource, cardId, projectDir, onClose],
  );

  // A click picks, and so does Enter on the keyboard cursor — the overlay's
  // one gesture, reachable both ways now that the list is a focus stop.
  const delegate = useMemo<TugListViewDelegate>(
    () => ({ onSelect: resumeAt, onActivate: resumeAt }),
    [resumeAt],
  );

  return (
    <div className="resume-sheet">
      {/* The house filter affordance — one component, one delegate, the same
          fuzzy matcher every filtered list uses. It composes `TugInput`, so the
          editing surface keeps the substrate CUT/COPY/PASTE/SELECT_ALL/UNDO/
          REDO responders that a hand-rolled input would lose. */}
      <TugFilterField
        delegate={filterDelegate}
        attachment={filter}
        placeholder="Filter sessions"
        fill
        data-testid="resume-filter-input"
        focusGroup={focusGroup}
        focusOrder={0}
      />
      {/* The reused session cells read selection / pending-trash from this
          context; a focused pick-to-resume overlay tracks none, so the values
          are inert (no row pre-highlighted, no trash popover pending). The
          query rides along so a surviving row can paint what matched. */}
      <PickerCellProvider
        value={{
          selection: null,
          pendingTrashSessionId: null,
          filterQuery,
        }}
      >
        <div className="resume-sheet-list">
          <TugListView<SessionsDataSource>
            ref={listRef}
            dataSource={dataSource}
            delegate={delegate}
            cellRenderers={SESSIONS_CELL_RENDERERS}
            scrollKey="resume-sheet-sessions"
            rowLayout="flush"
            focusGroup={focusGroup}
            focusOrder={1}
            attachedFilter={filter}
            commitOnEnter="act"
            className="session-card-picker-sessions-list session-card-picker-list-view"
          />
        </div>
      </PickerCellProvider>
      <div className="tug-sheet-actions">
        <TugPushButton size="sm" onClick={() => onClose()} data-testid="resume-cancel">
          Cancel
        </TugPushButton>
      </div>
    </div>
  );
}
