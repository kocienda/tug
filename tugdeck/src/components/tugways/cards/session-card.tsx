/**
 * session-card.tsx — Session card (Unified Command Surface).
 *
 * The card body is a plain **flex column** ([L06]/[L13] — no JS sizing).
 * The transcript region (`SessionTranscriptHost` + Z2 status bar) flexes into
 * all remaining height (never below `--session-transcript-min`); the prompt-entry
 * region below is **content-sized** and pinned to the card bottom. Its text
 * area opens at `--tug-text-editor-min-height` and grows with content up to
 * `--session-entry-max-height` (a fraction of the card height), then scrolls — so
 * the Z4/Z5 toolbar is never pushed off the card. A stray submit collapses
 * the entry back toward the opening height because the cleared editor
 * shrinks. There is no split pane, no sash, and no content-sizing JS — this
 * replaced an earlier `TugSplitPane` + `useContentDrivenPanelSize` machine.
 * The card wires:
 *
 *   • A live `CodeSessionStore` bound to the supervisor-issued
 *     `tugSessionId` via the card-session binding store.
 *   • Live `@` file completion via `FileTreeStore` against the real
 *     connection-singleton. When no live connection is available (tests,
 *     first paint before `getConnection()` resolves), the `@` provider
 *     falls back to an empty stable closure so the engine's typeahead
 *     trigger stays wired regardless of timing.
 *   • Live `/` slash-command completion via a per-card `SessionMetadataStore`,
 *     wrapped in a position-0 gate so `/` mid-text produces an empty popup.
 *   • A shared `PromptHistoryStore` singleton for arrow-up/down recall.
 *   • A per-card `EditorSettingsStore` whose CSS variables cascade from
 *     the entry-pane TugBox down to the input editor. The store reads
 *     the global tugbank domain edited by the Settings card's Session Card
 *     tab and tracks it live via `onDomainChanged`.
 *
 * The entry is mounted inside a `TugBox` with `inset={false}` so it
 * fills the entry region edge-to-edge.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

import {
  LANDING_WORDS,
  TugPromptEntry,
  type TugPromptEntryDelegate,
} from "../tug-prompt-entry";
import { ShadeViewController } from "@/lib/shade-view-controller";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import { shouldRevealJoinOffer } from "@/lib/join-offer-reveal";
import { getChangesetVerbStore } from "@/lib/changeset-verb-store";
import { getChangesetJoinStore } from "@/lib/changeset-join-store";
import { getChangesetDraftStore } from "@/lib/changeset-draft-store";
import { CommitModeController } from "@/lib/commit-mode-controller";
import {
  JoinModeController,
  joinTargetFromEntry,
} from "@/lib/join-mode-controller";
import {
  SessionTranscriptHost,
  type SessionTranscriptHandle,
} from "./session-card-transcript";
import { SessionLandingProgressRow } from "./session-landing-progress-row";
import { AppTestAskDialog } from "../chrome/session-app-test-ask-dialog";
import { pendingAskStore } from "@/lib/pending-ask-store";
import {
  SessionChangesView,
  type ArcJoinSource,
} from "./session-changes/session-changes-view";
import type { ArcJoinActions } from "./session-changes/session-changes-arc-join";
import { SessionHistoryView } from "./session-history/session-history-view";
import { SessionTelemetryStatusRow } from "./session-card-telemetry-renderers";
import type { SessionTelemetryStatusRowHandle } from "./session-card-telemetry-renderers";
import { formatPathChipText } from "../chrome/path-chip-format";
import {
  SessionRouteIndicatorBadge,
  CC_VERSION_DOMAIN,
  CC_VERSION_KEY,
  CLAUDE_CODE_CHANGELOG_URL,
  parseLastKnownVersion,
} from "../chrome/session-route-indicator-badge";
import { AiChip } from "./ai-chip";
import { useAiConfigSheet } from "./ai-config-sheet";
import { ArcPickerSheet } from "./arc-picker-sheet";
import { useModel } from "@/lib/use-model";
import {
  REVIEW_PLAN_COMMAND,
  readLastReviewedPlan,
  resolvePlanReviewTarget,
  writeLastReviewedPlan,
} from "@/lib/arc-review-target";
import { useUnavailableModelBulletin } from "@/lib/use-unavailable-model-bulletin";
import { persistModelCatalog } from "@/lib/model-catalog";
import { useRewindSheet } from "./rewind-sheet";
import { useSkillsSheet } from "./skills-sheet";
import { useAgentsSheet } from "./agents-sheet";
import { useMemorySheet } from "./memory-sheet";
import { useHooksSheet } from "./hooks-sheet";
import { useUsageSheet } from "./usage-sheet";
import { useHelpSheet } from "./help-sheet";
import { useRenameSessionSheet } from "./rename-session-sheet";
import { useResumeSheet } from "./resume-sheet";
import { SessionPendingContextStrip } from "./session-pending-context-strip";
import { SessionFoldControl } from "./session-fold-control";
import { readSettleMs } from "@/lib/layout-imposer";
import { getTugTiming } from "../scale-timing";
import { useEffort } from "@/lib/use-effort";
import { usePermissionRulesSheet } from "./permission-rules-editor";
import { useSessionCardServices } from "./use-session-card-services";
import {
  buildCommandSubmission,
  type LocalCommandName,
  type SlashCommandDraft,
} from "@/lib/slash-commands";
import { useUsageStore } from "@/lib/usage-context";
import type { ArgumentHintResolver } from "@/components/tugways/tug-text-editor/argument-hint-extension";
import type { InlineCommandMatcher } from "@/lib/inline-command-ghost";
import type { PastedCommandResolver } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { usePermissionMode } from "@/lib/use-permission-mode";
import { isPermissionMode } from "@/lib/permission-mode";
import { openPathInOS, openUrlInOS } from "@/lib/os-open";
import { TugPaneBanner } from "../tug-pane-banner";
import { TugCopyBadge } from "../tug-copy-badge";
import { group } from "../tug-animator";
import { TugBox } from "../tug-box";
import { TugFileChooser } from "../tug-file-chooser";
import type { TugComboBoxItem } from "../tug-combo-box";
import { TugIconButton } from "../tug-icon-button";
import { TugPushButton } from "../tug-push-button";
import { TugActionTooltip } from "../tug-action-tooltip";
import { TugTooltip } from "../tug-tooltip";
import { TugInlineAlert, type TugInlineAlertTone } from "../tug-inline-alert";
import { AlertTriangle, Trash2 } from "lucide-react";

import { TugLabel } from "../tug-label";
import {
  TugConfirmPopover,
  type TugConfirmPopoverHandle,
} from "../tug-confirm-popover";
import {
  TugListView,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "../tug-list-view";
import {
  TugSheet,
  TugSheetContent,
  useTugSheet,
  type TugSheetHandle,
} from "../tug-sheet";
import { presentAlertSheet } from "../tug-alert-sheet";
import { useResponderChain } from "../responder-chain-provider";
import { useResponderForm } from "../use-responder-form";
import { useResponder } from "../use-responder";
import { useCopyableButton } from "../use-copyable-text";
import { useFocusManager } from "../use-focusable";
import { useCycleMode } from "../use-cycle-mode";
import { rowGridOrder, type SpatialOrder } from "../spatial-order";
import { useSpatialOrder } from "../use-spatial-order";
import type { ActionEvent } from "../responder-chain";
import { useCardDelegate, useCardLifecycle } from "@/lib/card-lifecycle";
import { deckTrace } from "@/deck-trace";
import { useSheetDelegate } from "@/lib/sheet-lifecycle";
import { useBannerDelegate } from "@/lib/banner-lifecycle";
import { TUG_ACTIONS } from "../action-vocabulary";
import { HighlightSelectionAdapter } from "../text-selection-adapter";
import { dispatchCommand } from "@/command-dispatch";
import type {
  CodeSessionSnapshot,
  CodeSessionStore,
} from "@/lib/code-session-store";
import { FindSession } from "@/lib/find-session";
import {
  TugFindBar,
  type TugFindBarHandle,
} from "@/components/tugways/tug-find-bar";
import type { SkillsInventoryStore } from "@/lib/skills-inventory-store";
import type { HooksInventoryStore } from "@/lib/hooks-inventory-store";
import type { SideQuestionStore } from "@/lib/side-question-store";
import type { ShellSessionStore } from "@/lib/shell-session-store";
import type { RefsSessionStore, RefsOpKind } from "@/lib/refs-session-store";
import { parseRefsArgs } from "@/lib/refs-flags";
import { REF_OPEN_CAP, resolveRefSpec } from "@/lib/ref-spec";
import { joinRefPath } from "./refs-result-view";
import type { PathCommandsStore } from "@/lib/path-commands-store";
import type { ShellGrammarStore } from "@/lib/shell-grammar-store";
import type { ShellClassifyStore } from "@/lib/shell-classify-store";
import type { PendingContextStore } from "@/lib/pending-context-store";
import {
  deriveSessionCardBannerSpec,
  humanizeErrorSummary,
} from "./session-card-banner-spec";
import { TransientNoticeController } from "./transient-notice-controller";
import { ClaimErrorNoticeController } from "./claim-error-notice-controller";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

import { createStagedLanding, type StagedLanding } from "./staged-landing";
import { SessionLandingNoticeStrip } from "./session-landing-notice-strip";
import { DiscardErrorNoticeController } from "./discard-error-notice-controller";
import { DraftErrorNoticeController } from "./draft-error-notice-controller";
import { ArcBindErrorNoticeController } from "./arc-bind-error-notice-controller";
import { ArcReplayNoticeController } from "./arc-replay-notice-controller";
import { ArcPressNoticeController } from "./arc-press-notice-controller";
import { deriveColdRestoreActive } from "./session-card-restore-gate";
import { REPLAY_SOFT_BUDGET_MS } from "@/lib/code-session-store";
import { PromptHistoryStore } from "@/lib/prompt-history-store";
import type { EditorSettingsStore } from "@/lib/editor-settings-store";
import type { TranscriptSettingsStore } from "@/lib/transcript-settings-store";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import { getConnection } from "@/lib/connection-singleton";
import { ARC_NAME_CAUTION, isShellSafeArcName } from "@/lib/arc-name";
import type { CompletionProvider } from "@/lib/tug-text-types";
import {
  cardSessionBindingStore,
  type CardSessionMode,
} from "@/lib/card-session-binding-store";
import { clipboardOriginProps } from "@/lib/clipboard-origin";
import {
  provisionSpawnTag,
  provisionSpawnLine,
  sendCloseSessionKeepingBinding,
  sendSpawnSession,
} from "@/lib/session-lifecycle";
import { exportSession, isExportAvailable } from "@/lib/os-export";
import {
  exportBaseName,
  transcriptToJsonl,
  transcriptToMarkdown,
} from "@/lib/transcript-export";
import { isPathPickerAvailable, pickPath } from "@/lib/native-path-picker";
import { TugProgressIndicator } from "../tug-progress-indicator";
import {
  sessionRestoreRegistry,
  cancelSessionRestore,
  fireRestore,
  getRestoreStartedAt,
  clearRestoreStartedAt,
  restorePassGate,
  type ResumeDisplayMetadata,
} from "@/lib/session-restore";
import { logSessionLifecycle } from "@/lib/session-lifecycle-log";
import {
  pickerNoticeStore,
  shouldShowStandingNotice,
  type PickerNotice,
} from "@/lib/picker-notice-store";
import {
  useSpawnError,
  spawnErrorMessage,
  isSpawnBudgetReason,
  sessionSpawnErrorStore,
} from "@/lib/session-spawn-error-store";
import {
  cardServicesStore,
  type CardServices,
} from "@/lib/card-services-store";
import { cardTitleStore } from "@/lib/card-title-store";
import { getDeckStore } from "@/lib/deck-store-registry";
import { cardFoldedOf } from "@/deck-store-selectors";
import { registerCardCloseAdvice } from "@/lib/card-close-advice";
import { readSessionCardCloseAdvice } from "@/lib/session-card-close-advice";
import {
  sessionIdentityLine,
  useSessionIdentity,
} from "@/lib/session-identity";
import { useSessionCardObserver } from "./use-session-card-observer";
import { useLandingReceipts } from "./use-landing-receipts";
import { useMenuStatePublication } from "./use-menu-state-publication";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { useHostFacts } from "@/lib/host-facts-store";
import { probeDirExistence } from "@/lib/dir-existence";
import { requestLogout } from "@/lib/logout-store";
import {
  putSessionRecentProjects,
  putFindOptions,
  readFindOptions,
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
} from "@/settings-api";
import {
  useSessionLedger,
  getSessionLedgerStore,
} from "@/lib/session-ledger-store";
import type { SessionRow } from "@/protocol";
import { encodeSetSessionPrivate } from "@/protocol";
import {
  privateRefusalDetail,
  sessionPrivateStore,
} from "@/lib/session-private-store";
import type { TaggedValue } from "@/lib/tugbank-client";
import {
  TugPaneBulletinProvider,
  useTugPaneBulletin,
  type TugPaneBulletinApi,
} from "../tug-pane-bulletin";
import { lastAssistantCopyText } from "./turn-entry-markdown";
import { compactionProgressStore } from "@/lib/compaction-progress-store";
import { useCompactionRun } from "./session-compaction-run";
import { MODAL_REST_LINE } from "./modal-rest-line";
import { useSessionsDataSource } from "@/lib/session-picker-data-source";
import {
  PickerCellProvider,
  SESSIONS_CELL_RENDERERS,
  type PickerSelection,
} from "./session-picker-cells";
import { TugFilterField } from "@/components/tugways/tug-filter-field";
import { useAttachedFilter } from "@/components/tugways/attached-filter";
import { caseInsensitiveSubstring } from "@/lib/text-match";
import "./session-card.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The picker sheet's exit animation duration, in milliseconds. Used
 * by the Open / Retry paths in `SessionProjectPicker` to defer the
 * binding-mutating wire frame until after the sheet has finished
 * animating out, so the resulting card-body flip doesn't unmount the
 * picker mid-animation.
 *
 * Mirrors `--tug-motion-duration-moderate` (~200ms) plus a small
 * buffer so we wait for the animation to fully settle before the
 * binding update lands.
 */
const SHEET_EXIT_ANIMATION_MS = 220;

/**
 * Placeholder copy for the prompt entry. Code is the only resting mode, so
 * one line — forwarded as `placeholder`. Dev-specific; the gallery
 * prompt-entry passes nothing.
 */
const SESSION_PROMPT_PLACEHOLDER = "Ask Tug to build, fix, or explain";

/**
 * The same line while the card's arc has finished and its join offer stands
 * ([B05]).
 *
 * The composer is where the eye goes when the model stops talking, and the
 * placeholder is the one line the open form can change without adding a
 * surface. It says both halves — that the work is done, and the one act that
 * lands it — because a state that calls for the user and does not say what
 * they are called for is a dot with no sentence under it.
 *
 * Ready is not a block, so the line keeps the composer's own invitation in it:
 * a session you can go on working under says so.
 */
const SESSION_READY_PROMPT_PLACEHOLDER =
  "Arc finished. /arc-join to land it, or keep working";

/**
 * Focus group the session card authors its keyboard-focus-cycling stops
 * into ([P02]/[P10]). One group per card mode — the per-card
 * `CycleScope` keys each card's stops into its own focus mode, so a
 * constant group string is safe across mounts. The lowest order (the
 * route) is what `focusFirstInMode` seeds on entry.
 */
const SESSION_CYCLE_GROUP = "session-prompt-cycle";
// Cycle order ([P10], revised): the cycle reads the card bottom toolbar
// left→right, then up to the find bar (while it is open), the status cells and
// the beat strip, then into the editor and its compose-phase attachment tiles,
// and **seeds at the Fold button** (order −1). Forward Tab: Fold →
// route → Claude Code → Session → Project → Cwd/Changes → AI settings →
// submit → find query → find options → find previous → find next → STATE →
// TIME → TOKENS → CONTEXT → WORK → BEAT → editor → attachment-1 …
// attachment-N → wrap; Shift+Tab reverses.
// Every Z4B chip (the route indicator, Session / Project badges, and the
// Mode / Model / Effort pickers), the five Z2 status cells, and the BEAT
// label are independent leaf stops (no arrow-roving); the editor is a text
// stop (Return resumes typing); each Z4C attachment tile is a leaf stop
// (Return / Space opens its preview). BEAT exists only while the line is
// shown (status bar present AND the `pulse/enabled` default on); attachment
// stops exist only while the editor holds image atoms — when neither is
// present the walk runs … WORK → editor → wrap. A disabled stop (the empty
// submit) drops out of the walk via the engine's interactivity filter, so the
// seed lands on the next live stop; a chip a route doesn't show simply
// unmounts (Table T01), so it is not in the walk at all.
const SESSION_CYCLE_ORDER_ROUTE = 0;
const SESSION_CYCLE_ORDER_CLAUDE_CODE = 1;
// 2 was the Session chip's. The Z4B diet unmounted that chip from the code
// route, its only mount, so nothing claims the order now — but the constant and
// its place in `cycleSpatialOrder` stay, because that grid describes the SHAPE
// of the toolbar row and the engine skips whichever stops are not currently
// mounted. Renumbering would churn every constant below it for nothing.
const SESSION_CYCLE_ORDER_SESSION = 2;
const SESSION_CYCLE_ORDER_PROJECT = 3;
// Slot 4 is the off-code-route chip slot: the shell route's Cwd chip and commit
// mode's Changes chip. Neither is ever co-mounted with the other (Table T01),
// so the Tab walk never sees two of them.
const SESSION_CYCLE_ORDER_CWD = 4;
const SESSION_CYCLE_ORDER_CHANGES = 4;
// The one AI settings chip stands where the Model chip did. Mode (slot 4's
// code-route reading) and Effort (slot 6) merged into it, so those orders now
// go unclaimed on the code route. Left as gaps rather than renumbered, for the
// reason stated above for slot 2: the grid describes the SHAPE of the toolbar
// row and the engine skips unmounted stops, so closing the gaps would churn
// every constant beneath them to no effect.
const SESSION_CYCLE_ORDER_AI = 5;
const SESSION_CYCLE_ORDER_SUBMIT = 7;
// Commit mode replaces the single Z5 submit with a three-button rail — Cancel
// ✕, Auto-Message ✎, Commit ↑ — so it takes 5…7, landing Commit on the submit's
// own slot because Commit IS the submit there. Slot 5 is the AI chip's, which
// only the code route mounts (Table T01): the rail and that chip are never
// co-mounted, the same non-overlap that lets Cwd and Changes share slot 4.
const SESSION_CYCLE_ORDER_COMMIT_BASE = 5;
// The find bar's four controls ([D122]) — query field, option group, Find
// previous, Find next — occupy 8…11 while the bar is open, and nothing at all
// while it is closed (the stops unmount with it, and the walk skips what is
// not rendered). They sit between the toolbar and the Z2 cells because that is
// where the bar sits: the cycle reads the card upward from its bottom edge.
const SESSION_CYCLE_ORDER_FIND_BASE = 8;
const SESSION_CYCLE_FIND_STOP_COUNT = 4;
// The fold control, seated at the TRAILING edge of Z2 in BOTH forms
// ([B03]–[B06]). It takes 18 — one past the Z2 cells at 13…17 — because that
// is where it stands on screen: the walk reads the row left to right, and the
// control is the last thing in it. 18 was free: it was the beat label's stop
// before the beat moved to the masthead. This control is present in both
// forms, so it needs an order of its own.
//
// Folded it is the card's Return-home and the one live stop that is not a
// cell; open it is simply the stop after them ([P08]).
const SESSION_CYCLE_ORDER_FOLD = 18;
// The control's stable focus key — the `group:order` form every `focus-key`
// placement addresses a stop by.
const FOLD_FOCUS_KEY = `${SESSION_CYCLE_GROUP}:${SESSION_CYCLE_ORDER_FOLD}`;
// How long past the settle's own window the fold's backstop waits before it
// writes the terminal state without a `transitionend` ([B06], (#motion-build)).
// Generous against the window it guards for the reason the settle's session
// hold is: it is a wedge guard rather than a second clock, and firing it early
// would take the composer's box away mid-fold.
const FOLD_END_SLACK_MS = 150;
// The Z2 status cells are five independent leaf stops ([P10] revised —
// no arrow-roving): STATE / TIME / TOKENS / CONTEXT / WORK take
// orders 13…17 (base + 0…4). The editor (the text body) follows at 19; and
// the Z4C compose-phase attachment tiles — one leaf stop each — take the
// orders from 20 upward (base + tile index), so they Tab right after the
// editor. 18 is the fold control at Z2's trailing edge (above).
const SESSION_CYCLE_ORDER_STATUS_BASE = 13;
const SESSION_CYCLE_ORDER_EDITOR = 19;
const SESSION_CYCLE_ORDER_ATTACHMENT_BASE = 20;

// What committing a Z4B settings picker (effort / model / permission mode) opened
// from a cycle stop does to the cycle ([P15]). Both behaviors are first-class
// framework features (see `TugSheet`'s `onCommitDisposition` and the engine's
// `relinquishFocusMode`); this is the session card's chosen value — flip it to feel
// each:
//   "relinquish" — commit exits focus-cycling; the caret returns to the prompt.
//   "retain"     — commit keeps cycling; the ring returns to the originating chip.
const SESSION_CYCLE_PICKER_COMMIT_DISPOSITION: "retain" | "relinquish" =
  "retain";

/**
 * Human-readable labels for the `lastError` causes the card surfaces as
 * an inline banner above the entry. `resume_failed` is intentionally
 * absent — that cause is intercepted by `useSessionCardObserver`, which
 * clears the binding and routes the notice through the picker-sheet
 * instead.
 */
type BannerErrorCause = Exclude<
  NonNullable<CodeSessionSnapshot["lastError"]>["cause"],
  "resume_failed"
>;
const CAUSE_LABELS: Record<BannerErrorCause, string> = {
  session_state_errored: "Session errored",
  transport_closed: "Connection lost",
  wire_error: "Protocol error",
  session_unknown: "Session unknown",
  session_not_owned: "Session not owned",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionCardContentProps {
  /**
   * Card instance id. Forwarded from the card registry's `contentFactory`
   * callback and used for per-card workspace binding (via
   * `useCardWorkspaceKey`) plus the responder scope id of the embedded
   * `TugPromptEntry`.
   */
  cardId: string;
  /**
   * Z0 — top-of-card content slot. A content-sized row at the very top
   * of the top split-panel, above the transcript. When `undefined`
   * (the default) the row collapses to zero height — the slot exists
   * in the contract but costs nothing visually until content arrives.
   * Reserved for future card-level metadata (session name, model
   * badge, pinned status, etc.).
   */
  headerContent?: React.ReactNode;
  /**
   * Z2 — status-bar content slot. A content-sized row at the BOTTOM of
   * the top split-panel, OUTSIDE the scrolling transcript list view.
   * Collapses to zero height when `undefined`. Layout shift on
   * telemetry update is contained (the row grows into space the
   * transcript ceded; no scroll repositioning). Per [D100] this slot
   * houses `SessionTelemetryStatusRow`, which carries a `TASKS` cell
   * (TugProgressIndicator ring + `N/M`) and an associated popover —
   * superseding the prior Z2A/Z2B split.
   */
  statusBarContent?: React.ReactNode;
  /**
   * Z1 — per-turn trailing slot. Invoked once per row half, keyed by
   * `half`. The user half wires next to the user-row trailing copy
   * button (currently empty by default); the assistant half wires
   * next to the assistant-row's copy button.
   */
  renderTurnTrailing?: SessionTurnTrailingRenderer;
  /**
   * Z4 — prompt-entry footer slot. Renders inside the prompt-entry
   * toolbar between the route choice group and the submit button.
   * When `undefined` the toolbar collapses to its pre-Z4 layout.
   */
  footerContent?: React.ReactNode;
}

/**
 * Signature of the Z1 per-turn trailing slot renderer. Receives a
 * minimal projection (turn key, half, optional `TurnEntry` for
 * committed rows) so renderers can subscribe to the right per-turn
 * data without leaking the transcript's data-source contract.
 */
export type SessionTurnTrailingRenderer = (
  context: SessionTurnTrailingContext,
) => React.ReactNode;

/**
 * Context passed to the Z1 per-turn trailing slot renderer. The same
 * renderer is invoked for both halves of each turn; consumers branch
 * on `half` to vary content. `turn` is `undefined` for in-flight rows
 * (no `TurnEntry` exists yet) and for the live user row.
 */
export interface SessionTurnTrailingContext {
  /** Stable per-turn key — matches `row.turnKey` in the data source. */
  turnKey: string;
  /** Which half of the turn is asking for trailing content. */
  half: "user" | "assistant";
  /** Committed turn entry, when present (assistant half post-commit). */
  turn?: import("@/lib/code-session-store").TurnEntry;
}

// ---------------------------------------------------------------------------
// SessionCardServices
// ---------------------------------------------------------------------------

/**
 * Per-card services consumed by `SessionCardContent`. Constructed once a
 * binding for this card appears in `cardSessionBindingStore`, torn
 * down when the binding clears or the card unmounts. The consuming hook
 * `useSessionCardServices` lives in `./use-session-card-services`; it returns
 * `null` while the card is unbound — the caller renders the
 * project-picker in that state.
 */
export interface SessionCardServices {
  codeSessionStore: CodeSessionStore;
  sessionMetadataStore: SessionMetadataStore;
  historyStore: PromptHistoryStore;
  completionProviders: Record<string, CompletionProvider>;
  /**
   * Resolves an accepted command atom's value to its argument placeholder
   * (`/devise ┆ type arguments…`), reading the live command catalog + local
   * registry. Forwarded to `TugPromptEntry`.
   */
  argumentHintResolver: ArgumentHintResolver;
  /**
   * Maps a mid-text `/query` to the full command name it completes to (the
   * inline ghost suffix), or `null`. Forwarded to `TugPromptEntry`.
   */
  inlineCommandMatcher: InlineCommandMatcher;
  /**
   * Recognizes a slash command at the start of pasted text and returns the atom
   * to chip it as (full name or unqualified leaf), or `null`. Forwarded to
   * `TugPromptEntry`.
   */
  pastedCommandResolver: PastedCommandResolver;
  editorStore: EditorSettingsStore;
  transcriptStore: TranscriptSettingsStore;
  /** Single-shot `/skills` request/response store ([#step-12d]). */
  skillsInventoryStore: SkillsInventoryStore;
  /** Single-shot `/hooks` request/response store ([#step-12c]). */
  hooksInventoryStore: HooksInventoryStore;
  /** Ephemeral `/btw` side-question history store (Spec S02). */
  sideQuestionStore: SideQuestionStore;
  /** Card shell session store — session state + exchange ingest ([P12]). */
  shellSessionStore: ShellSessionStore;
  /** Card refs session store — the `/match` / `/search` run in flight and the
   *  ref list `/ref N` resolves against ([P03]). */
  refsSessionStore: RefsSessionStore;
  /** Login-PATH command set for the shell-line classifier ([P08]). */
  pathCommandsStore: PathCommandsStore;
  shellGrammarStore: ShellGrammarStore;
  shellClassifyStore: ShellClassifyStore;
  /** `±`-route Changes controller — selection + commit/draft triggers ([P07]). */
  changesController: ChangesRouteController;
  /** Staged shell / `/btw` context queue — consumed at send, surfaced to the
   *  composer + rows (Add-to-context, VISIBILITY toggle). */
  pendingContextStore: PendingContextStore;
  /**
   * Delegate handle for the embedded `TugPromptEntry`. Owned by the
   * hook because the `/` completion provider's position-0 gate reads
   * `entryDelegateRef.current`; the component passes this same ref to
   * `<TugPromptEntry ref={...}>` and to the atom-regenerate callback.
   */
  entryDelegateRef: RefObject<TugPromptEntryDelegate | null>;
}

// ---------------------------------------------------------------------------
// SessionCardContent
// ---------------------------------------------------------------------------

export function SessionCardContent({
  cardId,
  headerContent,
  statusBarContent,
  renderTurnTrailing,
  footerContent,
}: SessionCardContentProps) {
  const services = useSessionCardServices(cardId);
  // Subscribe to the restore registry so `SessionRestoring` mounts as
  // soon as `restoreSessions` fires a `spawn_session(resume)` for
  // this card, and unmounts the moment the binding lands (registry
  // entry cleared via the cardSessionBindingStore subscriber inside
  // `session-restore`).
  const restoreMap = useSyncExternalStore(
    sessionRestoreRegistry.subscribe,
    sessionRestoreRegistry.getSnapshot,
  );
  // Has the startup restore pass settled? Until it has, an unbound
  // card cannot tell "fresh card" from "restore not yet registered"
  // — see `restorePassGate`. Holding the picker behind this keeps
  // the project-picker sheet from flashing during the
  // `list_card_bindings` round-trip.
  const restorePassSettled = useSyncExternalStore(
    restorePassGate.subscribe,
    restorePassGate.getSnapshot,
  );
  // Answer the pane's close question in this card's own terms — waive the
  // type's confirm while the card holds nothing, keep it (and word it) over
  // an unsent draft ([L27] release on unmount). Registered in a layout
  // effect for the reason the File card's guard is ([L03]): a close gesture
  // can land before a passive effect commits. The composer's delegate is
  // read through a ref rather than closed over — the services bag is
  // rebuilt on every rebind, and the advisor must answer for whatever is
  // mounted at the moment it is asked.
  const servicesRef = useRef(services);
  useLayoutEffect(() => {
    servicesRef.current = services;
  });
  useLayoutEffect(
    () =>
      registerCardCloseAdvice(cardId, () =>
        readSessionCardCloseAdvice(
          cardId,
          servicesRef.current?.entryDelegateRef.current ?? null,
        ),
      ),
    [cardId],
  );
  if (services !== null) {
    return (
      <SessionCardServicesGate
        cardId={cardId}
        services={services}
        headerContent={headerContent}
        statusBarContent={statusBarContent}
        renderTurnTrailing={renderTurnTrailing}
        footerContent={footerContent}
      />
    );
  }
  const expectation = restoreMap.get(cardId);
  if (expectation !== undefined) {
    return (
      <SessionRestoring
        variant="binding"
        cardId={cardId}
        projectDir={expectation.projectDir}
      />
    );
  }
  if (!restorePassSettled) {
    // Restore pass still in flight — this unbound card may yet have a
    // ledger binding. Hold the quiet `pass-pending` placeholder
    // rather than flashing the picker; once the pass settles this
    // re-renders to either `SessionRestoring` (a registry entry landed)
    // or the picker (genuinely a fresh card).
    return (
      <SessionRestoring variant="pass-pending" cardId={cardId} projectDir="" />
    );
  }
  return <SessionProjectPicker cardId={cardId} />;
}

// ---------------------------------------------------------------------------
// SessionCardServicesGate — transportState routing
// ---------------------------------------------------------------------------

/**
 * Routes between `SessionCardBody` and `SessionRestoring`. Only ONE window
 * routes to the placeholder now:
 *
 *   - **transport-restoring** — `transportState === "restoring"`
 *     ([D01]), between `transport_open` and `transport_settled`. A
 *     hard-stop with Cancel; the wire is being re-asserted.
 *
 * The cold-restore replay window — preflight → `phase === "replaying"`
 * → `replay_complete` — mounts the BODY instead (progressive reveal,
 * [P03] of the resume-performance plan): under windowed mounting the
 * transcript paints progressively as fold flushes commit, anchored at
 * the live edge by follow-bottom, with the `Z0` `TugControlBar`
 * carrying restore progress. The previous all-or-nothing reveal
 * (body held unmounted until `replay_complete`, then one giant mount
 * commit) was the measured blank-window mechanism on every corpus
 * class — see the plan's baseline waterfalls.
 *
 * `deriveColdRestoreActive` is still read here, but only to settle the
 * restore bookkeeping (drop the restore-start stamp + resume display
 * metadata once the window closes).
 *
 * Why a wrapper rather than an early return inside `SessionCardBody`:
 * `SessionCardBody` calls many hooks after the snapshot read; an early
 * return there would change hook order between renders. Localizing
 * the routing read in this thin gate keeps `SessionCardBody`'s hook list
 * stable.
 *
 * The gate also reads `projectDir` reactively from the binding store
 * so the placeholder's project label keeps up with any rebind that
 * happens while transportState is in flight (rare; this is defensive
 * against the single notify per `setBinding`).
 */
function SessionCardServicesGate({
  cardId,
  services,
  headerContent,
  statusBarContent,
  renderTurnTrailing,
  footerContent,
}: SessionCardBodyProps) {
  // Two narrow selectors, not the whole snapshot: each returns a
  // primitive, so the gate re-renders only when the routing decision
  // could actually change — not on every `turn_complete` that ticks
  // the snapshot during the replay window ([L02]).
  const transportState = useSyncExternalStore(
    services.codeSessionStore.subscribe,
    () => services.codeSessionStore.getSnapshot().transportState,
  );
  const coldRestoreActive = useSyncExternalStore(
    services.codeSessionStore.subscribe,
    () => deriveColdRestoreActive(services.codeSessionStore.getSnapshot()),
  );
  const projectDir = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(
      () => cardSessionBindingStore.getBinding(cardId)?.projectDir ?? "",
      [cardId],
    ),
  );

  // Restore-settled bookkeeping. The body now mounts THROUGH the cold
  // restore (deferred-content reveal: the transcript host holds its
  // list unmounted while the replay progress strip carries the
  // window), so there is no reveal latch holding it back anymore.
  // What remains is pure cleanup: on the active → settled transition,
  // drop the restore-start stamp and the resume display metadata so a
  // much-later reconnect can't read stale values. A ref records the
  // transition edge — nothing renders from it, so this is local
  // bookkeeping ([L24] local data), not external state mirrored into
  // React ([L02] would forbid that).
  const sawColdRestoreRef = useRef(false);
  useEffect(() => {
    if (coldRestoreActive) {
      sawColdRestoreRef.current = true;
    } else if (sawColdRestoreRef.current) {
      sawColdRestoreRef.current = false;
      clearRestoreStartedAt(cardId);
    }
  }, [coldRestoreActive, cardId]);

  // Transport-restoring is a hard-stop backdrop with Cancel; it
  // applies whether or not the body has revealed before (a reconnect
  // re-asserts the wire). The cold-restore replay window deliberately
  // does NOT route here — the body owns it (progressive reveal).
  if (transportState === "restoring") {
    return (
      <SessionRestoring
        variant="binding"
        cardId={cardId}
        projectDir={projectDir}
      />
    );
  }

  return (
    <SessionCardBody
      cardId={cardId}
      services={services}
      headerContent={headerContent}
      statusBarContent={statusBarContent}
      renderTurnTrailing={renderTurnTrailing}
      footerContent={footerContent}
    />
  );
}

// ---------------------------------------------------------------------------
// SessionRestoring — in-flight restore placeholder
// ---------------------------------------------------------------------------

/**
 * The single loading affordance for a session-card restore — shown while
 * a persisted session is being re-asserted: the registry has a pending
 * restore expectation, `transportState === "restoring"`, or the
 * cold-restore replay window is still in progress.
 *
 * **Delay-gated.** The backdrop fills the card for the whole window,
 * but the centered panel (title, project, spinner, Cancel) appears
 * only once the restore has run longer than `RESTORE_PLACEHOLDER_DELAY_MS`.
 * A fast restore therefore shows only a quiet empty backdrop, sub-
 * perceptibly, before the body reveals; a slow one explains itself.
 * The delay is measured from the restore-start stamp
 * (`getRestoreStartedAt`) so it spans the whole window — pre-services
 * spawn, preflight, and replay alike — and survives this component's
 * remount at the `services`-null boundary, which a component-local
 * timer could not.
 *
 * Restore is a hard-stop beat: the `binding` variant's panel carries
 * Cancel so a genuinely stuck restore can drop to the picker via
 * `cancelSessionRestore`.
 *
 * Two variants:
 *   - `binding` — a specific session is being restored (a registry
 *     expectation, transport-restoring, or the cold-restore replay
 *     window). Backdrop + the delay-gated centered panel.
 *   - `pass-pending` — the startup restore pass has not settled yet,
 *     so it is not yet known whether this unbound card has a session
 *     to restore. Backdrop only — no panel: there is no project to
 *     name and nothing to Cancel.
 *
 * The discriminator drives `data-variant` so CSS and tests can target
 * each surface unambiguously.
 */
type SessionRestoringVariant = "binding" | "pass-pending";

interface SessionRestoringProps {
  variant: SessionRestoringVariant;
  /** The Cancel button calls `cancelSessionRestore(cardId)`. */
  cardId: string;
  /** Path label rendered under the title. */
  projectDir: string;
}

/**
 * Delay before `SessionRestoring` reveals its centered panel — mirrors
 * `REPLAY_SOFT_BUDGET_MS` so "the restore is taking long enough to
 * explain itself" is one threshold across the codebase. Under it, the
 * restore shows only the quiet backdrop.
 */
const RESTORE_PLACEHOLDER_DELAY_MS = REPLAY_SOFT_BUDGET_MS;

function SessionRestoring({
  variant,
  cardId,
  projectDir,
}: SessionRestoringProps) {
  const handleCancel = useCallback(() => {
    cancelSessionRestore(cardId);
  }, [cardId]);

  // Delay gate. The restore-start stamp persists across this
  // component's remount at the `services`-null boundary, so each
  // mount recomputes the elapsed time against the same reference and
  // the panel reveal lands at a stable wall-clock moment. A missing
  // stamp means "treat as just started" — arm the full delay.
  const [panelVisible, setPanelVisible] = useState<boolean>(() => {
    const startedAt = getRestoreStartedAt(cardId);
    return (
      startedAt !== undefined &&
      Date.now() - startedAt >= RESTORE_PLACEHOLDER_DELAY_MS
    );
  });
  useEffect(() => {
    // The `pass-pending` variant never renders the panel — no timer.
    if (variant !== "binding" || panelVisible) return;
    const startedAt = getRestoreStartedAt(cardId);
    const elapsed = startedAt === undefined ? 0 : Date.now() - startedAt;
    const remaining = RESTORE_PLACEHOLDER_DELAY_MS - elapsed;
    if (remaining <= 0) {
      setPanelVisible(true);
      return;
    }
    const handle = setTimeout(() => setPanelVisible(true), remaining);
    return () => clearTimeout(handle);
  }, [variant, panelVisible, cardId]);

  const title = "Restoring session";
  const spinnerLabel = `Restoring session from ${projectDir}`;

  return (
    <div
      className="session-card-restoring-backdrop"
      data-slot="session-card-restoring"
      data-testid="session-card-restoring"
      data-variant={variant}
    >
      {/*
        Backdrop always; the centered panel only on the `binding`
        variant and only past the delay. The panel is conditionally
        rendered (not opacity-hidden) so a fast restore — and the
        `pass-pending` variant, which never has a panel — neither
        animates an unseen spinner nor announces "Restoring session"
        through `aria-live`. When it does mount, a CSS keyframe fades
        it in ([L06] — appearance via CSS).
      */}
      {variant === "binding" && panelVisible ? (
        <div
          className="session-card-restoring-panel"
          data-testid="session-card-restoring-panel"
          role="status"
          aria-live="polite"
        >
          <h2
            className="session-card-restoring-title"
            data-testid="session-card-restoring-title"
          >
            {title}
          </h2>
          <p
            className="session-card-restoring-project"
            title={projectDir}
            data-testid="session-card-restoring-project"
          >
            {projectDir}
          </p>
          <div className="session-card-restoring-footer">
            <span className="session-card-restoring-spinner">
              <TugProgressIndicator
                variant="spinner"
                size={14}
                state="running"
                aria-label={spinnerLabel}
              />
            </span>
            <TugPushButton
              emphasis="outlined"
              onClick={handleCancel}
              data-testid="session-card-restoring-cancel"
            >
              Cancel
            </TugPushButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionProjectPicker
// ---------------------------------------------------------------------------

interface SessionProjectPickerProps {
  cardId: string;
}

/**
 * The picker's notice rendered directly on the card, for the window before
 * the sheet has ever presented. Same `noticeContent` mapping and the same
 * `TugInlineAlert` the sheet uses, so a rejection reads identically whether
 * the card was active when it arrived or not.
 *
 * No Retry action here: the retry paths (`fireRestore`, the sheet's own
 * re-open) need the connection and the sheet's dismissal choreography, and
 * this surface exists to be seen rather than to act. Activating the card
 * presents the sheet, which carries the same notice with its actions.
 */
function StandingPickerNotice({ notice }: { notice: PickerNotice }) {
  const content = noticeContent(notice);
  return (
    <div
      className="session-card-picker-standing-notice"
      data-testid="session-card-picker-standing-notice"
      data-notice-category={notice.category}
    >
      <TugInlineAlert
        title={content.title}
        message={content.message}
        tone={content.tone}
        icon={content.icon}
        live="alert"
      />
    </div>
  );
}

/**
 * Picker shown while the card is unbound. The project-path form lives
 * inside a `TugSheet` that drops from the title bar on mount and
 * disappears when the user picks a path or cancels.
 *
 * Sheet outcomes:
 *   - Open  → `spawn_session` frame is sent; the sheet closes. When
 *             `spawn_session_ok` arrives, `cardSessionBindingStore`
 *             populates the binding for `cardId` and
 *             `useSessionCardServices` transitions from `null` to a ready
 *             services bag, flipping the card into its split-pane body.
 *   - Cancel → sheet closes; the card closes too (dispatch `close`
 *             through the responder chain to the first card responder).
 *   - Escape → same as Cancel.
 *
 * No "waiting" affordance in 4c. If `spawn_session_ok` never arrives,
 * the card is simply empty (sheet already dismissed). The `lastError`
 * banner arrives in Step 6.
 */
function SessionProjectPicker({ cardId }: SessionProjectPickerProps) {
  const { showSheet, renderSheet } = useTugSheet();
  const manager = useResponderChain();
  const senderId = useId();
  const shownRef = useRef(false);

  // One-shot notice from a prior session attempt. The card observer
  // stashes a notice when it clears the binding after a failure so
  // the re-presented picker can surface the reason. `consume` reads-
  // and-clears, so a remount that's not preceded by a failure shows
  // nothing. Captured once at picker construction; subsequent renders
  // inside this picker session keep showing the same notice until the
  // form is submitted.
  const noticeRef = useRef<PickerNotice | null>(null);
  if (noticeRef.current === null) {
    noticeRef.current = pickerNoticeStore.consume(cardId);
  }

  // Spawn rejection (tugcast refused `spawn_session` — e.g. the project
  // directory was deleted). Formerly a separate red `TugPaneBanner` that
  // collided with the picker sheet layered on top of it; now folded into the
  // picker's own inline-alert channel so there is one surface, not two. Live
  // (subscribable) rather than one-shot: the rejection can arrive after the
  // sheet was dismissed on Open, and the effect below re-presents the picker
  // to show it.
  const spawnError = useSpawnError(cardId);
  // A budget refusal is a different failure from a bad directory and gets a
  // different category: the request was valid, so re-picking the directory is
  // not the recovery and the copy must not say it is.
  //
  // Neither category carries retry context, and `spawn_budget` must not grow
  // any: the picker's Retry button routes through `fireRestore`, which spawns
  // with `sessionMode: "resume"`. A refused *fresh* spawn has a client-minted
  // session id that no session was ever created for, so retrying it as a
  // resume would ask the host to restore something that never existed. The
  // sheet's own Open button is the correct retry for a fresh spawn, and the
  // restore path has its own retry ladder for a resume.
  const spawnNotice: PickerNotice | null =
    spawnError !== null
      ? {
          category: isSpawnBudgetReason(spawnError.reason)
            ? "spawn_budget"
            : "spawn_failed",
          message: spawnErrorMessage(spawnError.reason),
        }
      : null;

  // The notice the picker actually shows: the one-shot restore notice when
  // present, else the live spawn rejection. Mirrored into a ref so the
  // sheet's render-prop content (captured at `showSheet` time) reads the
  // current value without re-plumbing.
  const activeNotice = noticeRef.current ?? spawnNotice;
  const activeNoticeRef = useRef<PickerNotice | null>(activeNotice);
  activeNoticeRef.current = activeNotice;

  // Whether the picker sheet is currently on screen. Gates the spawn-error
  // re-present so a rejection that arrives while the sheet is already open
  // (the startup-restore path) doesn't double-present.
  const sheetOpenRef = useRef(false);

  // Whether the sheet has ever been presented for this picker. State, not a
  // ref, because the standing notice below is rendered from it — and unlike
  // `shownRef` it is never reset, so once the sheet has appeared the notice
  // stays retired and the re-present path owns every later rejection. That
  // is what keeps the two surfaces from both being up at once.
  const [sheetEverShown, setSheetEverShown] = useState(false);

  // Present the sheet only when this card becomes first responder.
  // An unbound session card that lives in an inactive tab must wait —
  // otherwise its sheet drops on top of the sibling card the user is
  // actually looking at (reload symptom: restart with hello-world
  // front and a sibling dev tab → dev's picker covers hello).
  //
  // `observeCardDidActivate` fires an initial-sync synchronously at
  // subscribe time when the card is already the focused card — so a
  // fresh `addCard("dev")` (dev IS the new FR) presents the sheet
  // on mount without waiting for a macrotask drain.
  const cardLifecycle = useCardLifecycle();
  const presentSheet = useCallback(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    sheetOpenRef.current = true;
    setSheetEverShown(true);
    // The notice carries retry context (`stale{TugSessionId,ProjectDir}`)
    // only for the three retryable categories. When present, the
    // picker renders a Retry button that re-fires the restore and
    // closes the sheet; "retry" is treated like "open" in `onClosed`
    // below (no CLOSE dispatch — the card stays mounted so
    // `SessionCardContent` can flip to `SessionRestoring`).
    const noticeForRetry = activeNoticeRef.current;
    const retryTugSessionId = noticeForRetry?.staleTugSessionId;
    const retryProjectDir = noticeForRetry?.staleProjectDir;
    const canRetry =
      retryTugSessionId !== undefined && retryProjectDir !== undefined;

    void showSheet({
      title: "Choose Session",
      icon: "FolderOpen",
      // A path combo box, a filter field, and session rows that carry a
      // three-line summary plus two trailing controls — the decision width
      // truncates all three.
      displayWidth: "lg",
      // The picker seeds its own focus via the engine (`SessionProjectPickerForm`'s
      // smart-latch places the key view on the Sessions list, or the path field
      // when Open is disabled). Suppress Radix's mount-autofocus so it can't ALSO
      // grab the first tabbable (the path combo box) — a second focus authority
      // that splits the ring across two elements ("both lists focused"). The
      // engine is the sole owner, matching TugConfirmPopover / TugAlert.
      onOpenAutoFocus: (e) => e.preventDefault(),
      // Capture the cascade target at sheet-open time per
      // `tugplan-dev-overlay-framework.md` [D02]. `cardId` is the
      // card-host's responder id; the chain walk from `cardId`
      // traverses `parentId` → the host pane's `stackId`, where
      // `TUG_ACTIONS.CLOSE` is registered (`tug-pane.tsx`). We use
      // `cardId` rather than the pane's `stackId` because:
      //   1. `cardId` is in scope here without extra plumbing.
      //   2. `cardId` is stable across cross-pane moves; pane
      //      `stackId` changes on move (see `card-host.tsx:1412`).
      // The cascade walk is dynamic (re-reads `parentId` at dispatch
      // time), so a moved card still reaches its current pane's
      // CLOSE handler. The hook itself doesn't consume this option;
      // the consumer reads `cardId` from its own closure inside
      // `onClosed` below — that's what makes the dispatch robust.
      cascadeTargetId: cardId,
      content: (close) => (
        <SessionProjectPickerForm
          notice={activeNoticeRef.current}
          onOpen={(projectDir, sessionMode, sessionId, display) => {
            const connection = getConnection();
            if (!connection) {
              console.warn("SessionProjectPicker: connection unavailable");
              return;
            }
            // Start the sheet's exit animation FIRST. Defer the wire
            // send until after the animation has played:
            // `spawn_session_ok` arrives in single-digit milliseconds
            // in-process, and the resulting binding update flips this
            // card from picker → body, unmounting the picker (and its
            // sheet host) mid-animation. The user-visible symptom is
            // the sheet "just disappearing" on Open while Cancel
            // animates correctly. Deferring the wire send by the
            // sheet's exit duration lets the sheet play its exit
            // cleanly before the binding flip cascades through the
            // card.
            close("open");
            window.setTimeout(() => {
              if (sessionMode === "resume") {
                // A `resume` can be rejected by the server (e.g.
                // `session_live_elsewhere` when the session's ledger
                // entry is still bound to another card). Route it
                // through `fireRestore` so it registers a restore
                // expectation: the card shows `SessionRestoring` while
                // in flight, and a rejection (the `SESSION_STATE`
                // errored frame) clears the registry and sets a
                // picker notice — which re-presents the picker with
                // the failure reason. Calling `sendSpawnSession`
                // directly here would leave an empty card when
                // `spawn_session_ok` never arrives: the sheet has
                // already dismissed with `result: "open"` and the
                // picker's `shownRef` guard blocks a re-present.
                fireRestore(cardId, sessionId, projectDir, connection, display);
              } else {
                // The `new` arm: a fresh spawn mints its line from the drop
                // ([P03]). A resume never reaches here — it goes through
                // `fireRestore`, which offers only a line the deck knows.
                const lineId = provisionSpawnLine(sessionId);
                sendSpawnSession(
                  connection,
                  cardId,
                  sessionId,
                  projectDir,
                  sessionMode,
                  provisionSpawnTag(lineId),
                  lineId,
                );
              }
            }, SHEET_EXIT_ANIMATION_MS);
          }}
          onCancel={() => close("cancel")}
          onRetryRestore={
            canRetry
              ? () => {
                  const connection = getConnection();
                  if (!connection) {
                    console.warn(
                      "SessionProjectPicker: connection unavailable for retry",
                    );
                    return;
                  }
                  // Same exit-animation deferral as Open above —
                  // `fireRestore` triggers a binding restore that can
                  // unmount this picker.
                  close("retry");
                  window.setTimeout(() => {
                    fireRestore(
                      cardId,
                      retryTugSessionId as string,
                      retryProjectDir as string,
                      connection,
                    );
                  }, SHEET_EXIT_ANIMATION_MS);
                }
              : null
          }
        />
      ),
      // Fire after the sheet's exit animation finishes so the card
    });
  }, [showSheet, cardId]);

  useLayoutEffect(() => {
    if (cardLifecycle === null) return;
    return cardLifecycle.observeCardDidActivate(cardId, () => presentSheet());
  }, [cardLifecycle, cardId, presentSheet]);

  // Cancel-cascade dispatch when the picker closes with no
  // success result (Escape / Cmd+. / Cancel button →
  // `result === undefined`). Cancellation should dismiss the host
  // card via the chain. Migrated from the legacy
  // `useTugSheet().showSheet({ onClosed })` closure-callback to
  // the per-card `sheetDidReturnResult` lifecycle event so the
  // dispatch composes with other lifecycle subscribers (e.g.,
  // `SessionCardBody`'s `sheetDidHide` focus claim) on a single
  // observable pipe.
  //
  // Cascade dispatch via `sendToTarget(cardId, …)` per [D02]:
  // first-responder state at this moment is fragile (it settles
  // via the unregister fallback after FocusScope unmount, focusin
  // handlers, and stale-focus re-promotion) and was the source of
  // the cancel-cascade bug fixed here. `sendToTarget` walks
  // `parentId` from a known node, independent of focus settling.
  //
  // `result === "open"` and `"retry"` leave the card mounted (the
  // binding subscription flips into the split-pane body when
  // `spawn_session_ok` arrives, or `fireRestore` triggers a
  // re-render into `SessionRestoring`); only the implicit
  // `undefined` result and any other future cancel-class result
  // close the card.
  //
  // `CLOSE_TAB` (not `CLOSE`): a picker cancel has nothing to save —
  // the card hasn't opened a session yet — so it must bypass Dev's
  // `confirmClose: true` policy that `CLOSE` would trigger. The
  // pane's `CLOSE_TAB` handler removes the card directly, and
  // `_removeCard` cascades to `_closePane` when removing the last
  // card.
  useSheetDelegate(cardId, {
    sheetDidReturnResult: (_id, result) => {
      // The sheet left the screen — clear the open latch so a later spawn
      // rejection (below) can re-present it.
      sheetOpenRef.current = false;
      if (result === "open" || result === "retry") return;
      manager?.sendToTarget(cardId, {
        action: TUG_ACTIONS.CLOSE_TAB,
        value: cardId,
        sender: senderId,
        phase: "discrete",
      });
    },
  });

  // Drop the card's spawn-error when the picker unmounts (the card
  // bound or closed) so a later card reusing this id starts clean.
  useEffect(() => () => sessionSpawnErrorStore.clear(cardId), [cardId]);

  // Spawn-rejection recovery. When tugcast rejects this card's
  // `spawn_session` (e.g. the project directory no longer exists),
  // `action-dispatch` records it in `sessionSpawnErrorStore` and drops any
  // restore hold, so the card falls through to this picker. Rather than a
  // separate banner behind the sheet, we surface the failure as the picker's
  // own inline alert (`spawnNotice`, wired through `activeNoticeRef`).
  //
  // This effect only handles RE-presentation — the rejection that arrives
  // after the sheet was already dismissed on Open (a manual pick whose spawn
  // then failed). The FIRST presentation always stays with
  // `observeCardDidActivate` below, which gates on the card being the active
  // first responder (an inactive tab must not drop a sheet over the sibling
  // the user is looking at). So: only re-present when the sheet has been shown
  // before (`shownRef`) and is currently closed (`!sheetOpenRef`). The
  // startup-restore path leaves both refs such that this no-ops and the
  // activate observer presents the sheet — already carrying the inline alert.
  useEffect(() => {
    if (spawnError === null || sheetOpenRef.current || !shownRef.current) {
      return;
    }
    shownRef.current = false;
    presentSheet();
  }, [spawnError, presentSheet]);

  // The rejection's standing surface, and the reason a refused card is never
  // blank. The sheet is the picker's only other way to speak, and it presents
  // on activation ([D02] first-responder gating above) so that an inactive
  // tab cannot drop a sheet over the sibling in view — which left a card
  // refused while inactive, having never presented, rendering an empty
  // backdrop and no reason at all. This notice does not wait for activation.
  //
  // It retires the moment the sheet has ever been shown: from then on the
  // sheet carries the same notice through `activeNoticeRef`, and the
  // re-present effect above handles rejections that land after a dismissal.
  // So exactly one of the two is ever up.
  const standingNotice = shouldShowStandingNotice(activeNotice, sheetEverShown)
    ? activeNotice
    : null;

  return (
    <div
      className="session-card-picker-backdrop"
      data-slot="session-card-picker"
      data-testid="session-card-picker"
      // The backdrop is decorative while the sheet owns the card, but a
      // standing notice is the only thing the card is saying — it must not
      // be hidden from assistive tech.
      aria-hidden={standingNotice === null ? true : undefined}
    >
      {standingNotice !== null ? (
        <StandingPickerNotice notice={standingNotice} />
      ) : null}
      {renderSheet()}
    </div>
  );
}

interface SessionProjectPickerFormProps {
  /**
   * Notice surfaced above the form when the picker is re-presented
   * after a session failure (e.g. a resume that didn't take, a
   * canceled restore, or a restore timeout). The notice carries the
   * reason so the user sees it in the same picker that lets them
   * choose what to do next. `null` when the picker is opening fresh.
   */
  notice: PickerNotice | null;
  onOpen: (
    projectDir: string,
    sessionMode: CardSessionMode,
    sessionId: string,
    /**
     * Resume display metadata from the selected ledger row (Spec S03
     * of the resume-performance plan) — what the replay progress
     * affordance can say from t=0. `undefined` for new-mode opens.
     */
    display?: ResumeDisplayMetadata,
  ) => void;
  onCancel: () => void;
  /**
   * Invoked when the user clicks Retry on a notice that carries
   * `staleTugSessionId` + `staleProjectDir`. Re-fires the restore via
   * `fireRestore` — the card flips from picker back to
   * `SessionRestoring` and the whole cycle runs again. `null` on a
   * fresh-picker notice that doesn't carry retry context.
   */
  onRetryRestore: (() => void) | null;
}

/** One entry in the sessions record. */
interface SessionRecord {
  sessionId: string;
  projectDir: string;
  createdAt: number;
}

/**
 * Pure parser for the `dev.tugapp.dev / recent-projects` tagged-value
 * entry. Mirrors `readSessionRecentProjects` in shape — split out so the
 * picker can subscribe to live updates via `useTugbankValue` instead of
 * reading once into `useState` (an L02 violation when external state
 * is copied into React state, even via a lazy initial value).
 */
function parseRecents(entry: TaggedValue | undefined): string[] {
  if (!entry || entry.kind !== "json" || entry.value === undefined) return [];
  const raw = entry.value as { paths?: unknown } | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.paths)) return [];
  return raw.paths.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
}

/**
 * Parse a tugbank string value. The Swift host writes
 * `dev.tugapp.app/initial-project-path` as `{ kind: "string" }` via
 * `TugbankClient.setString` — empty string when the key is missing
 * or shaped unexpectedly.
 */
function parseString(entry: TaggedValue | undefined): string {
  if (!entry || entry.kind !== "string" || typeof entry.value !== "string")
    return "";
  return entry.value;
}

/** Stable `[]` reference — useTugbankValue's `fallback` must be reference-stable. */
const EMPTY_STRING_ARRAY: ReadonlyArray<string> = [];

/** Stable empty set — the initial / no-missing-recents value. */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

/** `formatValue` for the picker's scan-progress bar — "465 of 1,022". */
function formatScanProgressValue(value: number, max: number): string {
  return `${value.toLocaleString()} of ${max.toLocaleString()}`;
}

/** Title + message + icon a picker notice renders as, for {@link TugInlineAlert}. */
interface NoticeContent {
  title: string;
  message?: string;
  tone: TugInlineAlertTone;
  /** Lucide icon name. */
  icon: string;
}

/**
 * Map a picker notice to a human-centric title / message split for the inline
 * alert. `resume_failed` surfaces the *real* reason carried on `notice.message`
 * (from tugcode's `resume_failed` IPC) as the secondary line rather than
 * guessing a cause — the old copy asserted "deleted or in use elsewhere", which
 * was routinely false (the 2026-07-22 commit-xp session had a 40 MB transcript
 * sitting on disk). `restore_canceled` and `restore_timed_out` name the project
 * path from `staleProjectDir` so the user sees which card was affected. Falls
 * back to the raw `notice.message` as the title on unexpected shapes.
 */
function noticeContent(notice: PickerNotice): NoticeContent {
  switch (notice.category) {
    case "resume_failed": {
      const reason = notice.message.trim();
      const hasReason =
        reason.length > 0 && reason.toLowerCase() !== "resume failed";
      return {
        title: "Couldn’t resume the previous session",
        message: hasReason
          ? `${reason}. Retry, or start a new session below.`
          : "Retry, or start a new session below.",
        tone: "caution",
        icon: "TriangleAlert",
      };
    }
    case "restore_canceled":
      return {
        title: "Resume canceled",
        message:
          notice.staleProjectDir !== undefined
            ? `You stopped restoring the session for ${notice.staleProjectDir}.`
            : notice.message,
        tone: "muted",
        icon: "Info",
      };
    case "restore_timed_out":
      return {
        title: "Couldn’t resume the previous session",
        message:
          "Restoring it took too long. The server may be unreachable — Retry, or start a new session below.",
        tone: "caution",
        icon: "TriangleAlert",
      };
    case "signed_out":
      return notice.message === "claude_missing"
        ? {
            title: "Claude Code isn’t available",
            message: "Finish setup, then pick a session below.",
            tone: "caution",
            icon: "TriangleAlert",
          }
        : {
            title: "You were signed out of Claude",
            message: "Log back in, then resume or start a session below.",
            tone: "caution",
            icon: "LogOut",
          };
    case "spawn_failed":
      // `message` already carries the human reason (from `spawnErrorMessage`).
      // The picker itself is the recovery — pick a directory that exists and
      // Open — so there's no separate action here.
      return {
        title: "Can’t open this project",
        message: `${notice.message} Choose a directory that exists below, then Open.`,
        tone: "danger",
        icon: "FolderX",
      };
    case "spawn_budget":
      // Deliberately does NOT steer at the picker. The host refused on its
      // own budget, so the project directory is fine and "choose a directory
      // that exists" — what `spawn_failed` says — would be false advice.
      // `message` carries which budget it was and what clears it.
      return {
        title: "Can’t start another session",
        message: notice.message,
        tone: "caution",
        icon: "TriangleAlert",
      };
    default:
      return { title: notice.message, tone: "muted", icon: "Info" };
  }
}

/**
 * Persistent-cycling focus group for the session picker ([P13] persistent —
 * [#step-picker-keys]). The picker lives inside a `TugSheet`, which already
 * pushes a trapped engine focus mode (`useFocusTrap`); authoring the picker's
 * controls into this one group makes them stops in that mode's Tab walk, read
 * top-to-bottom: path combo box → Sessions → Move-all-to-Trash → Cancel → Open.
 * There is no toggle — the sheet's mode IS the picker's base mode (unlike the
 * connected card's toggleable ⌥⇥ cycle). A not-ready Sessions list and a
 * disabled stop (Move-all-to-Trash with nothing to trash, Open with no valid
 * path) simply drop out of the walk via the engine's rendered/interactive
 * filters; the order leaves a gap the walk skips. Order `1` — vacated when the
 * Recents list folded into the path combo box's own dropdown — is now the
 * Sessions filter field, which sits between the path field and the list in
 * reading order; the stops below keep their authored focus-keys.
 */
const PICKER_CYCLE_GROUP = "session-picker-cycle";
const PICKER_ORDER_PATH = 0;
// The native "Browse…" folder button leads the path field in reading order, so
// it takes a negative order to slot BEFORE PATH (0) in the Tab walk — Tab from
// the browse button lands on the path field, then the Sessions list, keeping the
// button out from between the field and the list. Its fractional order also
// avoids renumbering the stops below — their authored focus-keys
// (`session-picker-cycle:2…5`) are a stable contract the app-tests and a baked
// corpus snapshot address by string, so they must not shift.
const PICKER_ORDER_BROWSE = -0.5;
// The path combo box's chevron sits at the field's right edge, between the
// field and the filter in reading order — fractional for the same
// stable-focus-key reason as Browse above.
const PICKER_ORDER_CHEVRON = 0.5;
const PICKER_ORDER_FILTER = 1;
const PICKER_ORDER_SESSIONS = 2;
const PICKER_ORDER_TRASH_ALL = 3;
const PICKER_ORDER_CANCEL = 4;
const PICKER_ORDER_OPEN = 5;
/**
 * Stable focus-key (`group:order`) of a picker stop. The smart-latch seed lands
 * the ring on a specific stop by this key via a keyboard `place()` — the picker's
 * commit-home (Open) is LAST in reading order, so the session-card "seed = first
 * stop" convention (`focusFirstInMode`) doesn't fit; seeding by key does.
 */
const pickerFocusKey = (order: number): string =>
  `${PICKER_CYCLE_GROUP}:${order}`;

/**
 * The Choose Session sheet's arrow order — the sheet's stops laid out as the
 * rows they read as on screen. Without it the sheet is served by the liveliness
 * net alone, which walks the linear order; a sheet is exactly the surface the
 * focus language asks to be authored, so Cancel / Open get a real horizontal
 * ring (Left/Right swap, wrapping) instead of two more stops in a column.
 *
 * The Sessions list is a single-node row, so it takes no ring: the engine
 * injects its live cursor handle as the group, interior arrows rove its rows,
 * and only an arrow off the cursor's edge crosses the seam to the row above or
 * below. Every key is a module constant, so the order is too — nothing to
 * memoize.
 */
const PICKER_SPATIAL_ORDER: SpatialOrder = rowGridOrder([
  [
    pickerFocusKey(PICKER_ORDER_BROWSE),
    pickerFocusKey(PICKER_ORDER_PATH),
    pickerFocusKey(PICKER_ORDER_CHEVRON),
  ],
  [pickerFocusKey(PICKER_ORDER_FILTER)],
  [pickerFocusKey(PICKER_ORDER_SESSIONS)],
  [pickerFocusKey(PICKER_ORDER_TRASH_ALL)],
  [pickerFocusKey(PICKER_ORDER_CANCEL), pickerFocusKey(PICKER_ORDER_OPEN)],
]);

/**
 * Render `text` with `<mark>` highlights at `matches` (UTF-16 code-unit
 * half-open ranges) — the recents dropdown's substring emphasis. Empty
 * `matches` → the text unmarked.
 */
function renderRecentHighlight(
  text: string,
  matches: ReadonlyArray<readonly [number, number]>,
): React.ReactNode {
  if (matches.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of matches) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={`m-${start}`} className="session-card-picker-match">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function SessionProjectPickerForm({
  notice,
  onOpen,
  onCancel,
  onRetryRestore,
}: SessionProjectPickerFormProps) {
  const focusManager = useFocusManager();
  // Declared against the sheet's own trap, which `TugSheet` owns — hence the
  // context form, read from the enclosing `FocusModeScope`. This body renders
  // inside that trap; if the order ever landed on the base mode instead (the
  // context form no-ops there), that is the signal the call has drifted outside
  // the trap.
  useSpatialOrder(PICKER_SPATIAL_ORDER);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Per-state default focus for the picker ([P12] Picker → Open). The Open
  // button is the destination so Return opens the seeded path — but Open is
  // `disabled` until a valid path settles, and the path seed is async, so the
  // placement is a deliberate smart latch (below) that seeds the engine key view
  // by focus-key once Open settles enabled, else the path field; never yanked
  // once the user has engaged the field. Both stops are addressed by their stable
  // `group:order`, so no element ref is needed for the seed.
  const defaultFocusPlacedRef = useRef(false);
  const userTouchedFieldRef = useRef(false);
  // Form's outer DOM node — used to scope the anchor querySelector for
  // the form-owned trash-confirmation popover so the lookup never
  // walks outside the picker form's own subtree.
  const formRootRef = useRef<HTMLDivElement | null>(null);
  const formResponderId = useId();

  // External state via `useSyncExternalStore` per [L02]. Recents
  // ride on tugbank; sessions flow through the tugcast-side
  // `SessionLedgerStore` keyed on the user-typed path.
  const recents = useTugbankValue(
    "dev.tugapp.dev",
    "recent-projects",
    parseRecents,
    EMPTY_STRING_ARRAY as string[],
  );

  // Recent paths whose directory the last `/api/fs/stat` probe reported as
  // gone (deleted / moved since it was recorded). Opening one dead-ends at the
  // "Can't open project" screen, so we drop them from the dropdown seed up
  // front. Best-effort and additive: only paths explicitly reported missing
  // are hidden; a probe failure leaves the set empty and every recent shows.
  const [missingRecents, setMissingRecents] =
    useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  useEffect(() => {
    let cancelled = false;
    if (recents.length === 0) {
      setMissingRecents((prev) => (prev.size === 0 ? prev : EMPTY_STRING_SET));
      return;
    }
    void probeDirExistence(recents).then((existsMap) => {
      if (cancelled) return;
      const gone = new Set<string>();
      for (const recentPath of recents) {
        if (existsMap[recentPath] === false) gone.add(recentPath);
      }
      setMissingRecents((prev) =>
        prev.size === gone.size && [...gone].every((p) => prev.has(p))
          ? prev
          : gone,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [recents]);

  // Suggested project path the Swift host refreshes at every launch
  // (the repo source tree for debug builds, `$HOME` for release).
  // Used to seed the input when the user has no Recent Project Paths
  // yet so first launch isn't a dead-end.
  const initialProjectPath = useTugbankValue(
    "dev.tugapp.app",
    "initial-project-path",
    parseString,
    "",
  );

  // The user's chosen default project directory (Settings ▸ General, or the
  // ConfigureTug step). Outranks the Swift hint in the seed chain below.
  const defaultProjectPath = useTugbankValue(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
    parseString,
    "",
  );

  // Reliable fallback for the seed when there is no Swift hint: the backend
  // home directory (the browser can't know it). See the seed effect below.
  const hostFacts = useHostFacts();

  const [path, setPath] = useState("");
  const trimmedPath = path.trim();
  const sessionLedger = useSessionLedger(trimmedPath);

  // Re-validate the session list once per picker open. The ledger
  // store's snapshot is fetched once per connection, but terminal
  // sessions and other out-of-band JSONL writers never push
  // `session_updated` — without this the list freezes at whatever the
  // first open saw. Stale-while-revalidate: cached rows stay on screen
  // while the refresh scan runs ([L02] — the store owns the state; this
  // is an event kick, not a state mirror).
  const didRefreshLedgerRef = useRef(false);
  useLayoutEffect(() => {
    if (didRefreshLedgerRef.current || trimmedPath === "") return;
    didRefreshLedgerRef.current = true;
    getSessionLedgerStore()?.refresh(trimmedPath);
  }, [trimmedPath]);

  // One-shot input seed (effect below).
  const didSeedPathRef = useRef(false);

  // The filter field's query — transient local UI state, never persisted, and
  // meaningless across project paths (the field remounts per path, below).
  const [filterQuery, setFilterQuery] = useState("");

  // The Sessions list for the currently-typed project path (always visible —
  // placeholder when no path / ledger pending), narrowed by the filter field.
  // "New session" stays in the list under any query: Open falls to a new
  // session with or without the row, so hiding it would misrepresent what Open
  // does — and keeping it means the filtered list is never empty.
  // Recents are no longer a separate list: they seed the path combo box's own
  // dropdown (below).
  const sessionsDataSource = useSessionsDataSource(
    trimmedPath,
    sessionLedger,
    filterQuery,
  );
  // The projection's version, so the selection-invalidation effect below re-runs
  // on every filter recompute and not just on a ledger tick ([L02]).
  const sessionsVersion = useSyncExternalStore(
    useCallback(
      (cb: () => void) => sessionsDataSource.subscribe(cb),
      [sessionsDataSource],
    ),
    useCallback(() => sessionsDataSource.getVersion(), [sessionsDataSource]),
  );

  // One-shot seed so first open isn't a dead-end: if the input is empty,
  // prefer the most-recent project, then the user's default project directory,
  // then the Swift-provided hint, then the backend home directory. Skipped once
  // a value is present so later tugbank / host-facts ticks can't overwrite a
  // user edit.
  //
  // The default tier reads the *explicit* setting, never the `<home>/tug`
  // resolution: an unset key falls through to the Swift hint (which seeds the
  // repo source tree on debug builds) instead of being shadowed by a computed
  // path the user never chose.
  useLayoutEffect(() => {
    if (didSeedPathRef.current) return;
    if (path !== "") {
      didSeedPathRef.current = true;
      return;
    }
    if (recents.length > 0) {
      didSeedPathRef.current = true;
      setPath(recents[0]);
      return;
    }
    const seed =
      defaultProjectPath !== ""
        ? defaultProjectPath
        : initialProjectPath !== ""
          ? initialProjectPath
          : (hostFacts?.home ?? "");
    if (seed === "") return;
    didSeedPathRef.current = true;
    setPath(seed);
  }, [path, recents, defaultProjectPath, initialProjectPath, hostFacts]);

  // Session selection. Owned here, read by cells via context. Open
  // resolves submission per [Spec S02].
  const [selection, setSelection] = useState<PickerSelection | null>(null);

  // [Spec S03] selection invalidation — sessions only. Auto-default
  // to `session-new` on first SESSIONS visibility per [D06]; clear
  // when sessions go away; snap-back when the selected resume row
  // vanishes from the ledger.
  const sessionsReady = sessionsDataSource.isReady();
  const ledgerRows = sessionLedger.rows;
  useLayoutEffect(() => {
    if (!sessionsReady) {
      if (selection !== null) setSelection(null);
      return;
    }
    if (selection === null) {
      setSelection({ kind: "session-new" });
      return;
    }
    if (selection.kind === "session-resume") {
      // Visibility is asked of the PROJECTION, not the raw ledger: a row the
      // filter hid is not selectable, and leaving it selected would let Open
      // resume a session the user can no longer see.
      if (!sessionsDataSource.hasVisibleSession(selection.sessionId)) {
        setSelection({ kind: "session-new" });
      }
    }
    // `sessionsVersion` is the projection's change token — the effect must
    // re-run per filter recompute, not only per ledger tick.
  }, [sessionsReady, sessionsVersion, sessionsDataSource, selection]);

  // Trash actions — the picker form owns the confirmation flow per
  // [tugplan-session-picker-redesign §D14] (no per-cell popovers).
  //
  // Per-row trash: the trash `TugIconButton` in `SessionResumeCell`
  // dispatches `request-trash-session` with `{ sessionId }` payload.
  // The chain handler below populates `pendingTrashSessionId`. A
  // single anchored `TugConfirmPopover` rendered at the form level
  // confirms, and its `onConfirm` callback unconditionally moves the
  // session to trash.
  //
  // Trash-all: the picker-level button uses the imperative-mode
  // `TugConfirmPopover` API (legacy). It does not need the chain-
  // dispatch path because the button is always visible at a fixed
  // location, not anchored to a specific row.

  const trashSession = useCallback(
    (sessionId: string): void => {
      const store = getSessionLedgerStore();
      if (store === null) return;
      const row = ledgerRows.find((r) => r.session_id === sessionId);
      // Live-in-Tug and terminal-live rows are untrashable (the cell
      // hides the control; this is the defensive backstop — the
      // supervisor refuses both anyway).
      if (
        row === undefined ||
        row.state === "live" ||
        row.terminal_live !== null
      )
        return;
      // Always pass the project dir: external rows (no ledger row
      // server-side) need it to locate the JSONL; ledger rows ignore it.
      void store.trashSession(sessionId, row.project_dir);
      setSelection((prev) =>
        prev?.kind === "session-resume" && prev.sessionId === sessionId
          ? { kind: "session-new" }
          : prev,
      );
    },
    [ledgerRows],
  );

  // ---- Form-owned trash confirmation ----
  //
  // `pendingTrashSessionId` is `null` when no trash is in flight.
  // The chain handler for `request-trash-session` (registered below)
  // sets it; the popover's `onConfirm` and `onCancel` both clear it.
  // The anchor is resolved in a layout effect by querying the trash
  // icon's DOM node within this form's own subtree — the cell's
  // `data-session-id="<id>"` attribute on the row + the
  // `data-slot="tug-icon-button"` on the trash button form a stable
  // selector that survives row reordering and virtualization recycle.
  const [pendingTrashSessionId, setPendingTrashSessionId] = useState<
    string | null
  >(null);
  const [pendingTrashAnchorEl, setPendingTrashAnchorEl] =
    useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (pendingTrashSessionId === null) {
      setPendingTrashAnchorEl(null);
      return;
    }
    const root = formRootRef.current;
    if (root === null) return;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(pendingTrashSessionId)
        : pendingTrashSessionId;
    const selector = `[data-session-id="${escaped}"] [data-slot="tug-icon-button"]`;
    const el = root.querySelector<HTMLElement>(selector);
    setPendingTrashAnchorEl(el ?? null);
  }, [pendingTrashSessionId]);

  // Chain handler for `request-trash-session` dispatched by the per-
  // row trash button. The cell carries the sessionId on the event's
  // `value`; we narrow defensively per [L07] and ignore malformed
  // payloads. Setting `pendingTrashSessionId` triggers the layout
  // effect above (anchor resolution) and the popover render below.
  const handleRequestTrashSession = useCallback((event: ActionEvent) => {
    const v = event.value;
    if (
      v !== null &&
      typeof v === "object" &&
      "sessionId" in v &&
      typeof (v as { sessionId: unknown }).sessionId === "string"
    ) {
      setPendingTrashSessionId((v as { sessionId: string }).sessionId);
    }
  }, []);

  // Recents-trash pending state. The recents now live in the path combo box's
  // dropdown, which portals outside this form's DOM subtree — so a chain
  // dispatch (which walks the DOM for a responder) can't route from there. The
  // trash button uses a direct `onClick` instead, setting this state and
  // capturing the button element as the confirm popover's anchor (below).
  const [pendingTrashRecentPath, setPendingTrashRecentPath] = useState<
    string | null
  >(null);

  const {
    ResponderScope: PickerFormResponderScope,
    responderRef: pickerFormResponderRef,
  } = useResponder({
    id: formResponderId,
    actions: {
      [TUG_ACTIONS.REQUEST_TRASH_SESSION]: handleRequestTrashSession,
    },
  });

  // Merged ref: the form's root div carries BOTH the form responder's
  // `data-responder-id` (so the chain DOM walk lands here) AND our
  // own `formRootRef` (so the anchor querySelector is scoped to the
  // form's subtree). React calls function refs with the element on
  // mount and `null` on unmount, so the merge mirrors the same
  // calling shape both ways.
  const setFormRootRef = useCallback(
    (el: HTMLDivElement | null): void => {
      formRootRef.current = el;
      pickerFormResponderRef(el);
    },
    [pickerFormResponderRef],
  );

  // Confirm / cancel callbacks for the form-owned popover. Both
  // unconditionally clear `pendingTrashSessionId`, which flips the
  // popover's controlled `open` to `false`. Confirm additionally runs
  // the move-to-trash via the existing `trashSession` helper.
  const handleConfirmTrash = useCallback(() => {
    if (pendingTrashSessionId !== null) {
      trashSession(pendingTrashSessionId);
    }
    setPendingTrashSessionId(null);
  }, [pendingTrashSessionId, trashSession]);

  const handleCancelTrash = useCallback(() => {
    setPendingTrashSessionId(null);
  }, []);

  // The pending row's prompt would compose a richer message here, but
  // the picker UX uses the short, generic prompt "Move to Trash?" for
  // both single-row and bottom-button paths.
  const pendingTrashMessage = "Move to Trash?";

  // ---- Recent Project Paths trash ----
  //
  // `pendingTrashRecentPath` is declared above (next to `useResponder`). The
  // dropdown trash button captures its own element as the confirm popover's
  // anchor directly on click (see the combo-box seed builder), since the
  // portaled dropdown is outside this form's DOM subtree. Here: the remove
  // action and the confirm/cancel callbacks.
  const [pendingTrashRecentAnchorEl, setPendingTrashRecentAnchorEl] =
    useState<HTMLElement | null>(null);

  // Remove one path from the recents list. Optimistically updates the tugbank
  // cache (so the list re-renders immediately) then persists via PUT.
  const trashRecent = useCallback(
    (path: string): void => {
      const next = recents.filter((p) => p !== path);
      const client = getTugbankClient();
      client?.setLocalValue("dev.tugapp.dev", "recent-projects", {
        kind: "json",
        value: { paths: next },
      });
      putSessionRecentProjects(next);
    },
    [recents],
  );

  const handleConfirmTrashRecent = useCallback(() => {
    if (pendingTrashRecentPath !== null) {
      trashRecent(pendingTrashRecentPath);
    }
    setPendingTrashRecentPath(null);
    setPendingTrashRecentAnchorEl(null);
  }, [pendingTrashRecentPath, trashRecent]);

  const handleCancelTrashRecent = useCallback(() => {
    setPendingTrashRecentPath(null);
    setPendingTrashRecentAnchorEl(null);
  }, []);

  const trashAll = useCallback((): void => {
    const store = getSessionLedgerStore();
    if (store === null) return;
    let any = false;
    for (const row of ledgerRows) {
      if (row.state === "live") continue;
      void store.trashSession(row.session_id);
      any = true;
    }
    if (any) setSelection({ kind: "session-new" });
  }, [ledgerRows]);

  // Imperative handle for the trash-all confirm popover anchored to
  // the Move-all-to-Trash button. Click flow: open popover → await
  // confirmation → run `trashAll`.
  const trashAllConfirmRef = useRef<TugConfirmPopoverHandle>(null);
  const handleTrashAllClick = useCallback(async (): Promise<void> => {
    const ok = await trashAllConfirmRef.current?.confirm();
    if (ok === true) trashAll();
  }, [trashAll]);

  // Submit per [Spec S02] — resolves `(mode, sessionId)` from the
  // effective selection. The override parameter lets the form-level
  // Enter handler pass a synchronously-resolved selection from a
  // focused cell wrapper, since `setSelection` calls in the same
  // event don't reach state until the next render.
  const submitWith = useCallback(
    (effectiveSelection: PickerSelection | null): void => {
      const trimmed = inputRef.current?.value.trim() ?? "";
      if (!trimmed) return;

      let mode: CardSessionMode;
      let sessionId: string;
      let resumeCandidateId: string | null = null;
      let display: ResumeDisplayMetadata | undefined;

      if (effectiveSelection?.kind === "session-resume") {
        resumeCandidateId = effectiveSelection.sessionId;
        const row = ledgerRows.find(
          (r) => r.session_id === effectiveSelection.sessionId,
        );
        if (row !== undefined && row.state !== "live") {
          mode = "resume";
          sessionId = row.session_id;
          display = {
            title: row.name ?? row.last_user_prompt ?? null,
            turnCount: row.turn_count,
          };
        } else {
          mode = "new";
          sessionId = crypto.randomUUID();
        }
      } else {
        mode = "new";
        sessionId = crypto.randomUUID();
      }

      logSessionLifecycle("picker.submit", {
        project_dir: trimmed,
        session_mode: mode,
        session_id: sessionId,
        resume_candidate_id: resumeCandidateId,
      });
      onOpen(trimmed, mode, sessionId, display);
    },
    [onOpen, ledgerRows],
  );

  const submit = useCallback((): void => {
    submitWith(selection);
  }, [submitWith, selection]);

  // Open the recent-path trash confirmation. Anchored to the path field (a
  // stable element that never unmounts), so the dropdown is free to close when
  // the confirm takes focus without stranding the popover. Shared by the mouse
  // click and the Shift+Delete keyboard path.
  const requestTrashRecent = useCallback((recentPath: string): void => {
    setPendingTrashRecentPath(recentPath);
    setPendingTrashRecentAnchorEl(inputRef.current);
  }, []);

  // Seed source for the path combo box's dropdown: the recent project paths,
  // filtered to those matching the typed query (all when the query is empty, so
  // the dropdown opens like a menu), each rendered with `<mark>` highlights on
  // the matched substring. Choosing a row fills the input (the combo box's own
  // commit); the trailing trash — or Shift+Delete on the highlighted row —
  // removes the recent. The confirm popover anchors to the trash button element
  // (captured from the click, or resolved by path for the keyboard path), since
  // the dropdown portals outside this form and a form-scoped lookup wouldn't
  // find it.
  const buildRecentsSeed = useCallback(
    (query: string): TugComboBoxItem[] => {
      const q = query.trim();
      const items: TugComboBoxItem[] = [];
      for (const recentPath of recents) {
        // Don't offer a directory we already know is gone — opening it would
        // just dead-end at "Can't open project".
        if (missingRecents.has(recentPath)) continue;
        const match = caseInsensitiveSubstring(q, recentPath);
        if (q !== "" && match === null) continue;
        const matches = match?.matches ?? [];
        const pathShort =
          recentPath.split("/").filter(Boolean).slice(-1)[0] ?? recentPath;
        items.push({
          value: recentPath,
          label: (
            <span
              className="session-card-picker-path-recent"
              data-testid="session-card-picker-path-recent"
              title={recentPath}
              aria-label={recentPath}
            >
              {renderRecentHighlight(recentPath, matches)}
            </span>
          ),
          rowData: {
            "data-recent-path": recentPath,
            "data-pending-trash":
              pendingTrashRecentPath === recentPath ? "true" : undefined,
          },
          onRemove: () => requestTrashRecent(recentPath),
          trailing: (
            <TugIconButton
              icon={<Trash2 size={14} aria-hidden="true" />}
              aria-label={`Remove ${pathShort} from recent paths`}
              title={`Remove ${pathShort} from recent paths`}
              tone="danger"
              className="session-card-picker-recent-trash"
              onClick={() => requestTrashRecent(recentPath)}
            />
          ),
        });
      }
      return items;
    },
    [recents, missingRecents, pendingTrashRecentPath, requestTrashRecent],
  );

  // Sessions list delegate — onSelect updates the session selection
  // (or no-ops on live / loading rows).
  const sessionsDelegate = useMemo<TugListViewDelegate>(
    () => ({
      onSelect: (index) => {
        const row = sessionsDataSource.rowAt(index);
        switch (row.kind) {
          case "session-new":
            setSelection({ kind: "session-new" });
            return;
          case "session-resume":
            if (row.row.state === "live") return;
            setSelection({
              kind: "session-resume",
              sessionId: row.row.session_id,
            });
            return;
          case "loading":
            return;
        }
      },
    }),
    [sessionsDataSource],
  );

  // Arrow navigation over the Sessions list is owned by the focus engine: the
  // `TugListView` is authored as one single-select cycle stop, so ↑/↓ move the
  // cursor within it AND select the landed row — the session selection follows
  // the cursor (no separate Space step). A single-select list does not consume
  // Return: it falls through to the picker's default action (Open, which keeps
  // its ring the whole time via `persistentDefaultRing`), so arrowing to a row
  // and pressing Return opens it. Per-row trash stays mouse-driven (the row
  // trash icons are focus-refusing pointer affordances); keyboard users trash
  // via the Move-all-to-Trash stop.

  // Cell-context value for the Sessions list: `selection` drives session cells'
  // selection state; `pendingTrashSessionId` drives the matching row's
  // `data-pending-trash="true"` marker so its trash icon stays visible +
  // highlighted while the form-owned confirm popover is up. The per-row trash
  // flow dispatches `request-trash-session` through the chain, and the form's
  // chain handler above owns the response.
  const cellContextValue = useMemo(
    () => ({
      selection,
      pendingTrashSessionId,
      filterQuery,
    }),
    [selection, pendingTrashSessionId, filterQuery],
  );

  // The filter field's contract: report each keystroke, and hand the key view
  // down to the Sessions list on ArrowDown. Escape is the field's own (it
  // clears in place while non-empty); an empty field's Escape falls through to
  // the sheet's dismiss, so no `filterFieldDidRequestDismiss` here. Enter stays
  // with the picker's default action (Open), so no submit either.
  const pickerListRef = useRef<TugListViewHandle>(null);
  const pickerFilter = useAttachedFilter(() => pickerListRef.current);
  const filterDelegate = useMemo(
    () => ({
      filterFieldDidChangeQuery: setFilterQuery,
      // ↑/↓ cursor the Sessions list from the caret ([P08]) instead of handing
      // the key view down to it, so narrowing and choosing stay one gesture.
      ...pickerFilter.delegate,
    }),
    [focusManager, pickerFilter],
  );

  // Master/detail layout: project-path input → Recents list →
  // Sessions list (+ Move-all-to-Trash button) → Cancel/Open.
  const sessionsPending = sessionsDataSource.isPending();
  const nonLiveCount = sessionsDataSource.nonLiveCount();
  // The list omits prompt-free sessions, but the trash sweep takes every
  // session on the path — so the tooltip names both halves rather than
  // implying the visible count is the whole of it.
  const trashAllTooltip =
    nonLiveCount > 0
      ? `${nonLiveCount} ${nonLiveCount === 1 ? "session" : "sessions"}, plus all empty sessions`
      : "All empty sessions";
  // The `list_sessions` round-trip carries a filesystem existence check
  // for the typed path. An explicit `false` (path confirmed missing)
  // disables Open so a doomed `spawn_session` is never sent; `undefined`
  // (still checking) leaves Open enabled — the spawn-error banner is the
  // backstop for the race window.
  const dirMissing = sessionsDataSource.dirExists() === false;
  const openDisabled = trimmedPath.length === 0 || dirMissing;

  // Smart-latch default focus ([P12] Picker → New session). Re-evaluated as the
  // async path seed settles `openDisabled` and the sessions list becomes ready:
  //   - Open enabled + sessions ready → seed the Sessions list, which rests its
  //     cursor on the "New session" row (the selection defaults to
  //     `session-new`). A single-select list does not consume Return, so it
  //     falls through to the persistent-default Open: one Return spawns a new
  //     session at the seeded (most-recent) path. Latch.
  //   - Open enabled but sessions not ready yet → keep the caret in the path
  //     field so a still-loading picker is never ringless; do NOT latch, so the
  //     seed promotes to the Sessions list the moment the list mounts.
  //   - Open disabled → keep the ring/caret in the path field so typing starts
  //     immediately; do NOT latch, so a seed that later enables Open
  //     (before the user types) promotes the ring on the next run.
  //   - The user has touched the field → that field is the default;
  //     latch without moving so typing is never interrupted.
  // The picker is persistent-cycling ([P13]) — the seed is the engine KEY VIEW
  // (ring + DOM focus), not a bare `.focus()`, so the focus engine stays the
  // single owner and the ring rests on the seed at open. The keyboard `place()`
  // resolves the stop by its stable focus-key now (the field is already
  // registered) or re-lights it the instant it mounts. [L03] layout effect
  // (seed before paint).
  useLayoutEffect(() => {
    if (focusManager === null) return;
    if (defaultFocusPlacedRef.current) return;
    if (userTouchedFieldRef.current) {
      defaultFocusPlacedRef.current = true;
      return;
    }
    if (openDisabled || !sessionsReady) {
      focusManager.place(
        null,
        { kind: "focus-key", focusKey: pickerFocusKey(PICKER_ORDER_PATH) },
        { modality: "keyboard" },
      );
      return;
    }
    defaultFocusPlacedRef.current = true;
    focusManager.place(
      null,
      { kind: "focus-key", focusKey: pickerFocusKey(PICKER_ORDER_SESSIONS) },
      { modality: "keyboard" },
    );
  }, [openDisabled, sessionsReady, focusManager]);

  return (
    <PickerFormResponderScope>
      <div ref={setFormRootRef} className="session-card-picker-form">
        {notice !== null &&
          (() => {
            const content = noticeContent(notice);
            return (
              <div
                data-testid="session-card-picker-notice"
                data-notice-category={notice.category}
              >
                <TugInlineAlert
                  title={content.title}
                  message={content.message}
                  tone={content.tone}
                  icon={content.icon}
                  live="alert"
                  actions={
                    onRetryRestore !== null ? (
                      <TugPushButton
                        emphasis="outlined"
                        role={content.tone === "danger" ? "danger" : "action"}
                        onClick={onRetryRestore}
                        data-testid="session-card-picker-notice-retry"
                      >
                        Retry
                      </TugPushButton>
                    ) : undefined
                  }
                />
              </div>
            );
          })()}
        <label className="session-card-picker-field">
          <span className="session-card-picker-label">Project path</span>
          {/*
          The path field is a combo box: typing filters the recent projects
          (its seed) AND completes filesystem paths, both in one dropdown; a
          click / chevron / ArrowDown opens the recents as a menu; the Browse
          button is the native-picker escape hatch.
        */}
          <TugFileChooser
            ref={inputRef}
            value={path}
            onChange={(next) => {
              // A user edit (typing / completion pick) — not the programmatic
              // seed, which calls `setPath` directly — claims the field as the
              // default focus so the smart latch never yanks it to Open.
              userTouchedFieldRef.current = true;
              setPath(next);
            }}
            base={path !== "" ? path : "/"}
            kind="directory"
            onSubmit={submit}
            seed={buildRecentsSeed}
            menuMode
            placeholder="/path/to/project"
            focusGroup={PICKER_CYCLE_GROUP}
            focusOrder={PICKER_ORDER_PATH}
            browseFocusOrder={PICKER_ORDER_BROWSE}
            chevronFocusOrder={PICKER_ORDER_CHEVRON}
          />
        </label>
        <PickerCellProvider value={cellContextValue}>
          <div className="session-card-picker-section">
            <span className="session-card-picker-label">
              Sessions
              {sessionsReady && sessionLedger.scanning === true ? (
                <span
                  className="session-card-picker-scanning"
                  role="status"
                  aria-live="polite"
                  data-testid="session-card-picker-scanning"
                >
                  {sessionLedger.scanProgress !== undefined &&
                  sessionLedger.scanProgress.total > 0 ? (
                    // Determinate ticks from the host's scan: the same
                    // labeled-bar recipe as the restore strip, sized for
                    // the section header.
                    <TugProgressIndicator
                      variant="bar"
                      size={6}
                      role="action"
                      state="running"
                      label="Scanning…"
                      glyphPosition="right"
                      value={Math.min(
                        sessionLedger.scanProgress.parsed,
                        sessionLedger.scanProgress.total,
                      )}
                      max={sessionLedger.scanProgress.total}
                      showValue
                      formatValue={formatScanProgressValue}
                      className="session-card-picker-scanning-bar"
                      aria-label="Scanning sessions"
                    />
                  ) : (
                    "scanning sessions…"
                  )}
                </span>
              ) : null}
              {/* The filter trims a path's session list — hundreds of rows on a
                busy project. Keyed on the path so switching projects clears a
                filter that meant something only for the previous one. */}
              <TugFilterField
                key={trimmedPath}
                className="session-card-picker-filter"
                delegate={filterDelegate}
                attachment={pickerFilter}
                placeholder="Filter sessions"
                data-testid="session-card-picker-filter"
                focusGroup={PICKER_CYCLE_GROUP}
                focusOrder={PICKER_ORDER_FILTER}
              />
            </span>
            <div className="session-card-picker-sessions-host">
              {sessionsReady ? (
                <TugListView
                  ref={pickerListRef}
                  dataSource={sessionsDataSource}
                  delegate={sessionsDelegate}
                  cellRenderers={SESSIONS_CELL_RENDERERS}
                  scrollKey="session-card-picker-sessions"
                  rowLayout="flush"
                  className="session-card-picker-sessions-list session-card-picker-list-view"
                  focusGroup={PICKER_CYCLE_GROUP}
                  focusOrder={PICKER_ORDER_SESSIONS}
                  attachedFilter={pickerFilter}
                  singleSelect
                  // Arrowing out of a non-empty filter field should land on the
                  // first MATCH. A single-select list commits as its cursor
                  // lands, so without this seed the first Down would select
                  // "New session" and silently discard the user's prior pick.
                  initialSelectedIndex={
                    filterQuery === ""
                      ? undefined
                      : sessionsDataSource.firstResumeIndex()
                  }
                />
              ) : sessionsPending ? (
                <div
                  className="session-card-picker-empty"
                  role="status"
                  aria-live="polite"
                  data-testid="session-card-picker-pending-placeholder"
                >
                  checking…
                </div>
              ) : (
                <div
                  className="session-card-picker-empty"
                  data-testid="session-card-picker-sessions-empty"
                >
                  Type or select a project path to see sessions
                </div>
              )}
            </div>
            <div
              className="session-card-picker-trash-all"
              data-disabled={nonLiveCount === 0 ? "true" : undefined}
              title={trashAllTooltip}
            >
              <TugLabel
                emphasis="proposal"
                data-testid="session-card-picker-trash-all-label"
              >
                Move all sessions to Trash for this path
              </TugLabel>
              <TugConfirmPopover
                ref={trashAllConfirmRef}
                message={
                  nonLiveCount > 1
                    ? "Move all sessions to Trash?"
                    : "Move to Trash?"
                }
                confirmLabel="Trash"
                confirmRole="danger"
                side="top"
              >
                <TugPushButton
                  subtype="icon"
                  emphasis="ghost"
                  role="danger"
                  icon={<Trash2 size={16} aria-hidden="true" />}
                  onClick={handleTrashAllClick}
                  disabled={nonLiveCount === 0}
                  aria-label="Move all sessions to Trash for this path"
                  data-testid="session-card-picker-trash-all"
                  focusGroup={PICKER_CYCLE_GROUP}
                  focusOrder={PICKER_ORDER_TRASH_ALL}
                />
              </TugConfirmPopover>
            </div>
          </div>
        </PickerCellProvider>
        <div className="tug-sheet-actions">
          {dirMissing && (
            <TugLabel
              className="session-card-picker-dir-warning"
              emphasis="calm"
              data-testid="session-card-picker-dir-warning"
            >
              {"Directory doesn't exist"}
            </TugLabel>
          )}
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            onClick={onCancel}
            focusGroup={PICKER_CYCLE_GROUP}
            focusOrder={PICKER_ORDER_CANCEL}
          >
            Cancel
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="primary"
            role="action"
            onClick={submit}
            disabled={openDisabled}
            focusGroup={PICKER_CYCLE_GROUP}
            focusOrder={PICKER_ORDER_OPEN}
            persistentDefaultRing
          >
            Open
          </TugPushButton>
        </div>
        {/*
        Form-owned trash-session confirmation popover. Driven by
        `pendingTrashSessionId` state set by the chain handler on
        `request-trash-session`. Anchored to the requesting row's
        trash icon via a virtualRef populated in the layout effect.
        One instance, N anchor targets — see [D14] / [D15].
      */}
        <TugConfirmPopover
          open={pendingTrashSessionId !== null}
          anchorEl={pendingTrashAnchorEl}
          message={pendingTrashMessage}
          confirmLabel="Trash"
          confirmRole="danger"
          side="left"
          onConfirm={handleConfirmTrash}
          onCancel={handleCancelTrash}
        />
        {/* Form-owned confirm popover for removing a Recent Project Path,
          anchored to the (stable) path field. The message names the path since
          the anchor is the field, not the specific dropdown row. */}
        <TugConfirmPopover
          open={pendingTrashRecentPath !== null}
          anchorEl={pendingTrashRecentAnchorEl}
          message={
            pendingTrashRecentPath !== null
              ? `Remove ${pendingTrashRecentPath} from recent paths?`
              : "Remove from recent paths?"
          }
          confirmLabel="Remove"
          confirmRole="danger"
          side="bottom"
          onConfirm={handleConfirmTrashRecent}
          onCancel={handleCancelTrashRecent}
        />
      </div>
    </PickerFormResponderScope>
  );
}

interface SessionCardBodyProps {
  cardId: string;
  services: SessionCardServices;
  /** Z0 — top-of-card content; null collapses the row. */
  headerContent?: React.ReactNode;
  /** Z2 — status-bar content; null collapses the row. */
  statusBarContent?: React.ReactNode;
  /** Z1 — per-turn trailing renderer; invoked once per row half. */
  renderTurnTrailing?: SessionTurnTrailingRenderer;
  /** Z4 — prompt-entry footer content; null collapses the slot. */
  footerContent?: React.ReactNode;
}

/**
 * Render the consolidated `<TugPaneBanner>` from a derived spec.
 * The body calls this once with the spec from
 * `deriveSessionCardBannerSpec` and the `setDismissedAt` setter the
 * Dismiss footer wires up for the `error` kind. Centralized here so
 * the JSX stays close to its presentation siblings without burying
 * the precedence-chain mapping inside the body's render tree.
 *
 * `kind === "none"` still renders the banner with `visible: false`
 * — the component runs its exit animation and unmounts via its
 * internal `mounted` state, so a switch from kind="error" to "none"
 * (e.g. from a successful retry) animates out cleanly.
 *
 * Reconciliation invariant: every branch returns `<TugPaneBanner>` at
 * the same JSX position with no `key`. React reconciles the branches
 * as a single instance, so the banner can hold props through cross-kind
 * transitions and gate min-mount-time on the way out. Do not key these
 * branches by `spec.kind`; keying would unmount the prior banner
 * instance on every kind change, silently disabling the min-mount-time
 * gate (the new instance has no `shownAtRef` to compare against) and
 * losing the `lastVisiblePropsRef` hold that keeps content stable
 * during exit.
 */
function renderSessionCardBanner(
  spec: ReturnType<typeof deriveSessionCardBannerSpec>,
  setDismissedAt: (at: number) => void,
): React.ReactElement {
  if (spec.kind === "error") {
    // `spec.message` is the backend detail. For a crashed session it is
    // multi-line: a short first-line summary (e.g. `crash_budget_exhausted`)
    // followed by the subprocess's trailing stderr — the real reason claude
    // exited. Keep the summary on the strip and route the diagnostic tail to
    // the detail panel so operators see the failure without leaving the card.
    const newlineAt = spec.message.indexOf("\n");
    const summary =
      newlineAt === -1 ? spec.message : spec.message.slice(0, newlineAt);
    const diagnostic =
      newlineAt === -1 ? "" : spec.message.slice(newlineAt + 1).trim();
    return (
      <TugPaneBanner
        visible={true}
        variant="error"
        tone="danger"
        // Opt out of the min-mount-time gate. A user-visible failure
        // should exit on dismiss without an artificial 500ms hold;
        // dismissal is an explicit user action and any delay reads as
        // unresponsive UI.
        minMountedMs={0}
        label={CAUSE_LABELS[spec.cause]}
        message={humanizeErrorSummary(summary)}
        detailIcon="unplug"
        detailTitle={CAUSE_LABELS[spec.cause]}
        footer={
          <TugPushButton
            emphasis="outlined"
            role="danger"
            onClick={() => setDismissedAt(spec.at)}
          >
            Dismiss
          </TugPushButton>
        }
      >
        <p>
          This card lost its session. Dismiss to keep working here, or close and
          reopen the card to start a fresh session.
        </p>
        {spec.site ? (
          // The bridge's own name for the code path that wrote the frame.
          // "Protocol error" identifies the frame family and nothing more, so
          // without this the detail panel asks the reader to go read
          // tugcode's source to learn what actually broke.
          <p className="session-card-error-site">
            Reported by the bridge at{" "}
            <code className="session-card-error-site-slug">{spec.site}</code>.
          </p>
        ) : null}
        {diagnostic ? (
          <div className="session-card-error-diagnostic-block">
            <div className="session-card-error-diagnostic-bar">
              <TugCopyBadge value={diagnostic} copyLabel="Copy diagnostic">
                Copy diagnostic
              </TugCopyBadge>
            </div>
            <pre className="session-card-error-diagnostic">{diagnostic}</pre>
          </div>
        ) : null}
      </TugPaneBanner>
    );
  }
  // kind === "none" — banner runs its exit animation if it was
  // previously visible, then unmounts.
  return <TugPaneBanner visible={false} message="" />;
}

/**
 * Bridges the card-scoped `TugPaneBulletin` into the card body's imperative
 * handlers. `useTugPaneBulletin()` must run inside the provider, but `/copy`'s
 * `RUN_SLASH_COMMAND` handler lives in the card body (the provider's parent), so
 * this zero-render child captures the bulletin API onto a ref the handler reads
 * — the same handle-ref pattern the status row uses for `/context`.
 */
const PaneBulletinAnchor = forwardRef<TugPaneBulletinApi>(
  function PaneBulletinAnchor(_props, ref) {
    const paneBulletin = useTugPaneBulletin();
    useImperativeHandle(ref, () => paneBulletin, [paneBulletin]);
    return null;
  },
);

export function SessionCardBody({
  cardId,
  services,
  headerContent,
  statusBarContent,
  renderTurnTrailing,
  footerContent,
}: SessionCardBodyProps) {
  const {
    codeSessionStore,
    shellSessionStore,
    refsSessionStore,
    pathCommandsStore,
    shellGrammarStore,
    shellClassifyStore,
    sessionMetadataStore,
    historyStore,
    completionProviders,
    argumentHintResolver,
    inlineCommandMatcher,
    pastedCommandResolver,
    editorStore,
    transcriptStore,
    skillsInventoryStore,
    hooksInventoryStore,
    sideQuestionStore,
    changesController,
    pendingContextStore,
    entryDelegateRef,
  } = services;

  // One Find session per card body — the transcript-search state for the `⌕`
  // route. Owned here so it is in scope for both the prompt entry (query +
  // Return-navigate) and the transcript host (index, paint, scroll+flash), all
  // of which render inside this body. CardHost never remounts the body across
  // pane moves ([L23]), so a single instance survives the session. The option
  // toggles are seeded from the deck-wide persisted set (tugbank) so Case /
  // Word / Grep survive a card reload; a fresh deck falls back to all-off.
  const [findSession] = useState(() => {
    const client = getTugbankClient();
    const seeded = client ? readFindOptions(client) : null;
    return new FindSession(seeded ?? undefined, {
      onOptionsChanged: putFindOptions,
    });
  });

  // [P03] Shade visibility is card chrome state, not route state. A per-card
  // `ShadeViewController` holds which transcript-slot view is showing; the
  // card reads it via `useSyncExternalStore` to pick the active pane. All
  // three panes stay mounted — only visibility flips, via CSS ([L26]/[L06]).
  // Entering commit mode calls `show`; hiding is chrome-only (Shade close
  // affordance, Swift menu / keyboard toggles) ([P05]).
  const shadeViewControllerRef = useRef<ShadeViewController | null>(null);
  if (shadeViewControllerRef.current === null) {
    shadeViewControllerRef.current = new ShadeViewController();
  }
  const shadeViewController = shadeViewControllerRef.current;

  // Whether this card's PANE wears the folded form ([P01], [P03]). The
  // flag is deck state, so it enters React through `useSyncExternalStore`
  // ([L02]); everything the form does in CSS is keyed on the pane's
  // `data-folded` instead, and this value is only for what CSS cannot do —
  // here, the popup row's checkmark.
  //
  // Read off the process-wide registry rather than `useDeckManager()`, which
  // throws without a provider: a Session card renders in the gallery and in
  // tests that bootstrap no DeckManager, and the honest answer there is
  // not-folded rather than a crash.
  const subscribeToDeck = useCallback((onStoreChange: () => void) => {
    const store = getDeckStore();
    if (store === null) return () => {};
    return store.subscribe(onStoreChange);
  }, []);
  const folded = useSyncExternalStore(subscribeToDeck, () => {
    const store = getDeckStore();
    return store === null ? false : cardFoldedOf(store.getSnapshot(), cardId);
  });

  /**
   * Open the fold for a bidden entry into the Changes room ([B07]).
   *
   * The room is a room of the open form ([B06]): folded, the top column the
   * shade swaps over IS the Z2 instrument row, so a shade raised there covers
   * the fold control and the act it offers lives in the folded-away Z5. The
   * passive reveal answers that by deferring. An *explicit* entry cannot —
   * the user asked for the room and is owed it — so it opens the fold first
   * and enters the card it has just made able to show what it opens.
   *
   * Reads the deck store fresh rather than the rendered flag, for the same
   * reason the fold toggle does: the gesture is a command, and a command
   * decides off the state at the moment it runs.
   *
   * Returns whether it unfolded — the caller's signal that step 3's deferred
   * reveal is about to re-run and will carry the entry armed, so making the
   * entry here as well would only spend the offer twice.
   */
  const unfoldForChanges = useCallback((): boolean => {
    const deckStore = getDeckStore();
    if (deckStore === null) return false;
    if (!cardFoldedOf(deckStore.getSnapshot(), cardId)) return false;
    dispatchCommand(TUG_ACTIONS.SET_CARD_FOLDED, { cardId, folded: false });
    return true;
  }, [cardId]);

  // Commit mode's per-card state + land path ([P03], Spec S03). User-driven —
  // `/commit` and ⌃⌘C on an empty composer are the two doors INTO the mode;
  // Session ▸ Commit Changes is the door out the other side, gated on the
  // controller's `commitReady` — so it rides its
  // own controller rather than `CodeSessionStore`'s reducer. Entering the mode
  // turns the prompt entry into the message editor; the changes sheet's
  // visibility is separate card chrome (the `ShadeViewController`), coupled by
  // the card below.
  //
  // Rebuilt whenever its stores swap identity, NOT once per mount. A card
  // outlives its session: `/clear` and a re-bind hand `cardServicesStore` a
  // fresh `changesController` + `codeSessionStore` while this component stays
  // mounted (deliberately — that is what keeps the project picker from
  // flashing). A controller captured once therefore goes on addressing the
  // PREVIOUS session forever: its `fileCount` reads a changeset nobody is
  // adding to, its land gate reads a dead store's turn state, and its
  // Auto-Message asks the backend to draft for a session that owns no files —
  // a commit composer wired to a corpse while the sheet above it renders the
  // live session's changes.
  const commitModeControllerRef = useRef<CommitModeController | null>(null);
  const commitModeStoresRef = useRef<{
    changesController: ChangesRouteController;
    codeSessionStore: CodeSessionStore;
  } | null>(null);
  const commitModeStores = commitModeStoresRef.current;
  if (
    commitModeControllerRef.current === null ||
    commitModeStores === null ||
    commitModeStores.changesController !== changesController ||
    commitModeStores.codeSessionStore !== codeSessionStore
  ) {
    // A session swap is not a state the mode should survive: the new session
    // has its own changeset and its own draft, so the composer starts closed
    // rather than carrying the old session's commit message into it. The
    // outgoing controller is disposed by the effect below, whose cleanup runs
    // on exactly this identity change — render stays free of side effects.
    commitModeControllerRef.current = new CommitModeController({
      changesController,
      codeSessionStore,
    });
    commitModeStoresRef.current = { changesController, codeSessionStore };
  }
  const commitModeController = commitModeControllerRef.current;
  useEffect(() => () => commitModeController.dispose(), [commitModeController]);

  // Join mode ([P01]/[P04]) — commit mode's twin for the arc lane, rebuilt on
  // the same session-swap boundary and for the same reason: a new session has
  // its own bindings and its own arc.
  const joinModeControllerRef = useRef<JoinModeController | null>(null);
  const joinModeStoresRef = useRef<CommitModeController | null>(null);
  if (
    joinModeControllerRef.current === null ||
    joinModeStoresRef.current !== commitModeController
  ) {
    joinModeControllerRef.current = new JoinModeController({
      changesController,
      codeSessionStore,
      commitModeController,
    });
    joinModeStoresRef.current = commitModeController;
  }
  const joinModeController = joinModeControllerRef.current;
  useEffect(() => () => joinModeController.dispose(), [joinModeController]);

  const joinSnapshot = useSyncExternalStore(
    joinModeController.subscribe,
    joinModeController.getSnapshot,
  );
  const joinActive = joinSnapshot.active;

  /**
   * The bound arc's own feed entry, or null — the read the join prompt and
   * the Changes door both make ([L02]).
   *
   * Two subscriptions because two stores move independently: the binding
   * changes when the card is mated or unmated, the changeset when the
   * repository does. Missing either would leave the prompt reading an arc the
   * card is no longer about, or one whose decision has already been made.
   */
  const arcBindingId = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    () => cardSessionBindingStore.getBinding(cardId)?.arc?.id ?? null,
  );
  const changesVersion = useSyncExternalStore(changesController.subscribe, () =>
    changesController.getSnapshot(),
  );
  const boundArcEntry = useMemo(
    () =>
      arcBindingId === null
        ? null
        : (changesVersion.arcs.find(
            (row) => row.owner_id === arcBindingId,
          ) ?? null),
    [arcBindingId, changesVersion],
  );

  /**
   * The Changes door. Every way into the room — the Z4A segment, ⌃⌘C, the
   * Session menu — arrives here, and the landing it opens is a function of
   * what the card is mated to: an arc means a join, anything else means a
   * commit. The composer holds one landing-mode slot and cannot make that
   * call; the card holds both controllers, so it does.
   *
   * A card bound to an arc whose entry has not composed into the changes
   * snapshot yet falls back to commit mode rather than dead-ending — the door
   * always opens.
   */
  const enterChanges = useCallback(() => {
    // A bidden entry on a folded card opens the fold first ([B07]), so the
    // shade never mounts over Z2. The landing below still enters: the room is
    // raised through the mode↔sheet coupling, which runs after the render the
    // unfold has already been committed in.
    unfoldForChanges();
    const arcId = cardSessionBindingStore.getBinding(cardId)?.arc?.id;
    const entry =
      arcId === undefined
        ? undefined
        : changesController
            .getSnapshot()
            .arcs.find((row) => row.owner_id === arcId);
    if (entry !== undefined) {
      joinModeController.enter(joinTargetFromEntry(entry));
      return;
    }
    commitModeController.enter();
  }, [
    cardId,
    changesController,
    commitModeController,
    joinModeController,
    unfoldForChanges,
  ]);

  // Find bar: open/closed is structural (the bar mounts/unmounts above Z2),
  // mirroring the Text card's `findOpen`. The session outlives the bar here —
  // the transcript host binds its engine to it at card scope — so the bar
  // never clears it; closing does.
  //
  // Closing ends the search but not the query: the last one is remembered and
  // seeded back on the next ⌘F, which is what makes clear-on-close painless
  // (Safari and Xcode behave the same way). It lives in a ref because nothing
  // renders from it.
  const [findBarOpen, setFindBarOpen] = useState(false);
  const findBarRef = useRef<TugFindBarHandle | null>(null);
  const lastFindQueryRef = useRef("");

  const openFindBar = useCallback(() => {
    // Find and Changes are mutually exclusive: both are modes that take over
    // the bottom of the card, so summoning one leaves the other. `leave` (not
    // a bare `exit`) persists a typed commit message, so coming back to
    // Changes resumes it exactly as Cancel and the Z4A tab do.
    commitModeController.leave();
    // The bar focuses its own query field on mount.
    setFindBarOpen(true);
  }, [commitModeController]);

  // The cycle is declared further down (it needs `sessionErrored`), but the
  // find bar's close path has to reach it — a bar dismissed while the ring is
  // on one of its stops has to hand the keyboard back. Structure-zone refs
  // ([L24]), assigned right after `useCycleMode` below.
  const cyclingRef = useRef(false);
  const exitCycleRef = useRef<() => void>(() => {});

  const closeFindBar = useCallback(() => {
    lastFindQueryRef.current = findSession.getSnapshot().query;
    // A surface holding the keyboard owes it somewhere to land when it goes
    // away; a surface that is not must leave the keyboard alone. So the caret
    // returns to the composer only when the bar had it — dismissing from the
    // Session menu while the caret sits elsewhere must not yank it.
    const heldKeyboard = findBarRef.current?.holdsKeyboard() ?? false;
    setFindBarOpen(false);
    findSession.clear();
    if (!heldKeyboard) return;
    // Two ways the keyboard could be in the bar, and each has its own way
    // home. Cycling: leave the cycle and let its `restingFocus` land the
    // caret — a raw editor claim while a mode is pushed is the focus-language
    // bug that leaves the ring and the caret disagreeing. Not cycling: the
    // caret was in the query field, so claim the composer directly.
    if (cyclingRef.current) exitCycleRef.current();
    else entryDelegateRef.current?.focus();
  }, [findSession, entryDelegateRef]);

  // ⌘F / Edit ▸ Find… toggles. A find bar is a mode, and the chord that
  // summons a mode is the chord that dismisses it — the same shape ⌃⌘C has on
  // Changes. The open flag is read through a ref so the toggle keeps one
  // identity across the open/close it causes ([L24] structure zone).
  const findBarOpenRef = useRef(findBarOpen);
  findBarOpenRef.current = findBarOpen;
  const toggleFindBar = useCallback(() => {
    if (findBarOpenRef.current) closeFindBar();
    else openFindBar();
  }, [openFindBar, closeFindBar]);

  useSessionCardObserver(cardId, codeSessionStore);
  // Landing receipts as transcript ink ([P09], Spec S04): every successful
  // commit/join/release for this card's project leaves a non-context row.
  useLandingReceipts(codeSessionStore, changesController);
  // Publishes the two Shade-visibility booleans so the Swift Session menu can
  // pick its Show/Hide verb (Spec S04).
  useMenuStatePublication(
    cardId,
    codeSessionStore,
    sessionMetadataStore,
    shadeViewController,
    commitModeController,
    joinModeController,
  );

  // Imperative handle to the transcript pane. `handleAfterSubmit`
  // reads it to jump the transcript back to the live edge on submit
  // (the transcript is a split-pane sibling of the prompt entry, so
  // the gesture can't bubble through the DOM).
  const transcriptRef = useRef<SessionTranscriptHandle | null>(null);
  const shadeView = useSyncExternalStore(
    shadeViewController.subscribe,
    shadeViewController.getSnapshot,
  );
  // Commit mode ([P03] revised) is orthogonal to the changes sheet: the mode
  // turns the composer into the message editor, while the bottom-anchored
  // changes sheet is card chrome the mode rides atop. `commitModeActive`
  // drives the composer + the mode↔sheet coupling below; the transcript-slot
  // view is the shade choice alone.
  const commitModeActive = useSyncExternalStore(
    commitModeController.subscribe,
    () => commitModeController.getSnapshot().active,
  );
  // The commit cluster's Changes chip face — the count of files the commit
  // would land. Subscribed separately so the cluster re-renders only when the
  // count moves, not on every controller snapshot.
  const commitFileCount = useSyncExternalStore(
    commitModeController.subscribe,
    () => commitModeController.getSnapshot().fileCount,
  );
  // Claimable dirt (unattributed + orphaned) this session could pull in. With
  // zero attributed files, the Changes chip points here — "claim N" — instead
  // of a dead-end "0 files" ([P03]).
  const commitClaimableCount = useSyncExternalStore(
    commitModeController.subscribe,
    () => commitModeController.getSnapshot().claimableCount,
  );
  // Whether an Auto-Message scribe is streaming, on whichever landing is up.
  // The shade header's X reads it: while a draft streams the X aborts the
  // draft; otherwise it closes the shade ([P06]).
  const commitDrafting = useSyncExternalStore(
    commitModeController.subscribe,
    () => commitModeController.getSnapshot().draftPhase === "drafting",
  );
  const joinDrafting = useSyncExternalStore(
    joinModeController.subscribe,
    () => joinModeController.getSnapshot().draftPhase === "drafting",
  );
  const activeView: "transcript" | "changes" | "history" =
    shadeView === "none" ? "transcript" : shadeView;
  // The Changes and History shades are TugSheet `shade` presentations ([P17]);
  // the controller's view choice drives their imperative handles. A
  // self-initiated sheet close (Escape / Cmd-. / the chain's `cancelDialog`)
  // re-syncs the controller through `onOpenChange` — guarded on the live
  // snapshot so a swap (changes → history) closing the outgoing sheet never
  // clobbers the incoming choice.
  const changesSheetRef = useRef<TugSheetHandle | null>(null);
  const historySheetRef = useRef<TugSheetHandle | null>(null);
  useEffect(() => {
    if (shadeView === "changes") {
      changesSheetRef.current?.open();
      // Force a fresh working-tree scan on open so a just-created orphan
      // surfaces the moment you look, rather than waiting on the next
      // FS-watch bump (the recompose is diff-suppressed server-side).
      changesController.refresh();
    } else changesSheetRef.current?.close();
    if (shadeView === "history") historySheetRef.current?.open();
    else historySheetRef.current?.close();
  }, [shadeView, changesController]);
  // Mode ↔ sheet coupling ([P03]): entering commit mode ensures the changes
  // sheet is up; exiting it (composer Escape / Cancel / the Z4A commit chip /
  // land, all via `commitModeController.exit()`) drops the sheet, unless the
  // shade has already swapped to History. Observing the mode's active flag is
  // what lets a composer-initiated exit close the sheet.
  //
  // Entering also dismisses the find bar — the other half of the Find/Changes
  // exclusion `openFindBar` owns. Reading the flag rather than wiring each
  // door is what makes every entrance agree: ⌃⌘C, `/commit`, the Z4A tab, the
  // Session menu, and the failed-land re-entry.
  // Either landing counts ([P01]): the shade is the room both modes happen in,
  // so the coupling observes whether *a* landing is up rather than naming one.
  const anyLandingActive = commitModeActive || joinActive;
  const prevCommitModeActiveRef = useRef(anyLandingActive);
  useEffect(() => {
    const prev = prevCommitModeActiveRef.current;
    prevCommitModeActiveRef.current = anyLandingActive;
    if (!prev && anyLandingActive) {
      if (findBarOpenRef.current) closeFindBar();
      shadeViewController.show("changes");
    } else if (prev && !anyLandingActive) {
      if (shadeViewController.getSnapshot() === "changes") {
        shadeViewController.hide();
      }
    }
  }, [anyLandingActive, shadeViewController, closeFindBar]);
  const handleChangesSheetOpenChange = useCallback(
    (open: boolean) => {
      if (!open && shadeViewController.getSnapshot() === "changes") {
        shadeViewController.hide();
        // A passive-shade self-close while a landing is active also exits
        // that mode ([P03]) so the composer returns to the prompt.
        if (commitModeController.getSnapshot().active)
          commitModeController.exit();
        if (joinModeController.getSnapshot().active) joinModeController.exit();
      }
    },
    [shadeViewController, commitModeController, joinModeController],
  );
  // The shade header's X ([P03]). Leaving the mode — rather than exiting it —
  // persists a typed message, which is what the Z5 cancel this replaced did;
  // the mode↔sheet coupling above then drops the shade. With no landing up the
  // shade is a bare glance and hides on its own.
  const dismissChangesShade = useCallback(() => {
    if (commitModeController.getSnapshot().active) commitModeController.leave();
    else if (joinModeController.getSnapshot().active)
      joinModeController.leave();
    else shadeViewController.hide();
  }, [commitModeController, joinModeController, shadeViewController]);
  // The same X while the Auto-Message scribe streams: it aborts the draft and
  // leaves the mode standing.
  const cancelActiveDraft = useCallback(() => {
    if (commitModeController.getSnapshot().active)
      commitModeController.cancelDraft();
    else if (joinModeController.getSnapshot().active)
      joinModeController.cancelDraft();
  }, [commitModeController, joinModeController]);
  // What the header X is called, and what it does — one object so the view
  // can never show a label from one state and fire the act of another.
  const drafting = commitDrafting || joinDrafting;
  const changesDismiss = useMemo(
    () => ({
      label: drafting
        ? "Cancel auto-message"
        : commitModeActive || joinActive
          ? LANDING_WORDS[joinActive ? "join" : "commit"].cancel
          : "Close Changes",
      onDismiss: drafting ? cancelActiveDraft : dismissChangesShade,
    }),
    [
      drafting,
      commitModeActive,
      joinActive,
      cancelActiveDraft,
      dismissChangesShade,
    ],
  );
  const handleHistorySheetOpenChange = useCallback(
    (open: boolean) => {
      if (!open && shadeViewController.getSnapshot() === "history") {
        shadeViewController.hide();
      }
    },
    [shadeViewController],
  );
  // Staged commit ([P03]): a Commit press dismisses the Changes shade FIRST,
  // then fires the commit on the shade's `sheetDidHide` — so the transcript
  // receipt lands on a clean beat after the panel is gone, never on top of it.
  // The land-hook (installed on the controller) parks the commit callback and
  // dismisses the shade by exiting the mode; the `sheetDidHide` delegate below
  // runs the parked callback once the exit animation completes.
  // A join stages the same way, for the same reason ([P01]) — one hook shape,
  // installed on both controllers.
  //
  // The park carries a deadline ([L31]): the hide it waits on rides an effect
  // keyed on whether a landing is active, and a landing stranded on a hide that
  // never comes is the user's gesture lost in silence. `createStagedLanding`
  // holds both beats and the exactly-once swap.
  const stagedLandingRef = useRef<StagedLanding | null>(null);
  if (stagedLandingRef.current === null) {
    stagedLandingRef.current = createStagedLanding({
      onFault: () => {
        tugDevLogStore.warn(
          "landing",
          "sheetDidHide never fired — the watchdog landed the staged callback",
        );
      },
    });
  }
  useEffect(() => {
    const staging = stagedLandingRef.current;
    if (staging === null) return;
    const stage =
      (mode: { getSnapshot: () => { active: boolean }; exit: () => void }) =>
      (runLand: () => void) => {
        staging.stage(runLand);
        if (mode.getSnapshot().active) mode.exit();
        // The room closes on the press, as the press's own act. Exiting the
        // mode also drops it — through `anyLandingActive` flipping, a render,
        // and an effect — but a dismissal that has to survive three hops is a
        // dismissal that can fail to arrive, and when it failed the shade sat
        // over the transcript for the whole of a fifteen-second join: the
        // narration was behind it, the arc was still on offer, and the only
        // gesture left was a second press nothing could accept. Hiding here
        // is idempotent with the coupling — `ShadeViewController.commit`
        // no-ops when the view is already what it is being set to.
        shadeViewController.hide();
      };
    commitModeController.setLandHook(stage(commitModeController));
    joinModeController.setLandHook(stage(joinModeController));
    return () => {
      commitModeController.setLandHook(null);
      joinModeController.setLandHook(null);
      staging.dispose();
    };
  }, [commitModeController, joinModeController, shadeViewController]);
  useSheetDelegate(cardId, {
    sheetDidHide: () => {
      stagedLandingRef.current?.sheetDidHide();
    },
  });
  // Captured by the JSX's composed ref below for the first-mount
  // fade-in animation. Read by a useLayoutEffect with empty deps —
  // the effect runs once when this card first acquires services
  // (binding flip from picker → body, or initial mount on a session
  // restore), animates `.session-card` opacity 0 → 1 via TugAnimator,
  // and never re-runs. CardHost portals into the host pane and is
  // never remounted across cross-pane moves ([L23] minimal mutation),
  // so empty-deps semantics correctly maps to "once per fresh
  // session bind."
  const sessionCardRootRef = useRef<HTMLDivElement | null>(null);

  const codeSnap = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );

  // An inline dialog is modal for keys ([P06]): while one is pending the prompt
  // entry deactivates (read-only + blurred, no caret) so the dialog owns the
  // keyboard and the prompt visibly stands down. Derived from real store state
  // ([L06]); reactivates when the dialog resolves. Permission, Question, and
  // app-test Ask dialogs are all modal-for-keys.
  //
  // The ask belongs here for a reason the other two don't need spelled out:
  // `TugTextEditor`'s Return defers to the pane's default button, which while
  // this dialog is up is its `Continue`. Leaving the entry live would let a
  // Return meant for the composer answer a question the developer was not
  // looking at. Standing the entry down is what keeps Return unambiguous.
  const inlineDialogPending =
    Boolean(codeSnap.pendingApproval) ||
    Boolean(codeSnap.pendingQuestion) ||
    Boolean(codeSnap.pendingAsk);

  // The resume replay window deactivates the prompt the same way — a
  // session mid-reconstruction can't accept input, so no blinking
  // caret until the transcript settles. Same predicate the transcript
  // host's deferred-content hold reads.
  const replayHoldActive =
    codeSnap.phase === "replaying" || deriveColdRestoreActive(codeSnap);

  // When the dialog resolves — or the replay window closes — return focus to
  // the prompt: the card's single focus destination, which reactivates the
  // instant `deactivated` clears. Without this the caret would not come back
  // until the user clicked.
  const entryStoodDown = inlineDialogPending || replayHoldActive;
  const prevEntryStoodDownRef = useRef(false);
  useLayoutEffect(() => {
    if (prevEntryStoodDownRef.current && !entryStoodDown) {
      entryDelegateRef.current?.focus();
    }
    prevEntryStoodDownRef.current = entryStoodDown;
  }, [entryStoodDown]);

  // `/rewind` rewinds the transcript, not the prompt corpus. A rewound-away
  // turn is one the conversation no longer contains, but the user still typed
  // that prompt, and recall is a record of what they typed — so history keeps
  // it. Rewinding used to truncate here; a prompt the user could no longer
  // recall was the same loss the caps caused, arriving by a different door.

  // --- Banner derivation. ---
  // UI-only dismiss: track the `at` timestamp of the last-dismissed error.
  // A new error (different `at`) naturally reappears. The store owns the
  // clear semantics — on retry submit or turn_complete(success) the snapshot
  // transitions to `lastError: null` and the derivation drops the banner.
  // `resume_failed` is filtered out by the helper because
  // `useSessionCardObserver` is about to clear the binding and route that
  // cause through the picker.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const bannerSpec = deriveSessionCardBannerSpec(codeSnap, { dismissedAt });

  // Once the session hits any non-recoverable error, disable the entry —
  // the dismiss gesture only hides the banner, the underlying session is
  // still dead. The user recovers by closing and reopening the card.
  // `resume_failed` and the auth gate (`auth_required` / `claude_missing`)
  // are excluded upstream: the card observer unbinds the bound body on
  // those causes (the picker sheet re-renders instead), so they never
  // reach this dead-session classification. Attachment rejections never
  // reach `lastError` at all — they surface as a card bulletin, so they
  // neither disable the entry nor light its errored ring.
  const sessionErrored =
    codeSnap.lastError !== null && codeSnap.lastError.cause !== "resume_failed";

  // Keyboard-focus-cycling ([P09]/[P10]). ⌥⇥ trades the editor's Tab for
  // a trapped tour of the card's chrome zones (the submit is the
  // commit-home seed). Only the connected body cycles — the picker never
  // mounts this — and a dead session is ineligible so the toggle can't
  // strand a useless ring. `cycling` is engine-derived in the hook
  // ([L02]); the toggle is wired to `CYCLE_FOCUS_MODE` on the
  // card-content responder below, `CycleScope` wraps the prompt entry,
  // and `data-cycling` rides the card root for the fill-suppression CSS.
  // The cycle's resting destination ([P12]): a connected card's resting focus is
  // the prompt entry — a responder (caret), not a focus-group stop. The cycle
  // lands the caret here on every relinquish (⌥⇥ toggle-off, the editor stop's
  // Return-descend, or a sub-surface commit that relinquishes the cycle, [P15]),
  // skipping a mouse exit. Owning this in `useCycleMode` makes the relinquish
  // landing first-class, not bespoke per-card glue.
  const cycle = useCycleMode({
    enabled: !sessionErrored,
    restingFocus: () => entryDelegateRef.current?.focus(),
  });
  cyclingRef.current = cycle.cycling;
  exitCycleRef.current = cycle.exit;

  // Count of Z4C compose-phase attachment tiles, surfaced from the prompt
  // entry's image-atom set so the spatial grid can size the attachment row to
  // exactly the live tiles. The navigator's liveliness net ([#step-7-8]) makes
  // a brief count↔registration mismatch harmless (an absent ring target falls
  // through to the linear walk, never a beep or a dead-arrow warning), so this
  // does not have to be frame-perfect with the tile registrations.
  const [attachmentCount, setAttachmentCount] = useState(0);

  // Spatial arrow order for the cycle ([P22] / [P23]). Tab walks the cycle stops
  // linearly; arrows give them a 2D feel: horizontal rings — the bottom toolbar
  // (route → Claude Code → AI settings → submit), the Z2 status cells, and (while
  // composing with attachments) the Z4C tiles — with a vertical seam cycle
  // between the rows. The editor's text stop takes a row of its own between
  // the BEAT stop and the attachments, which is where it sits on screen: a focused
  // editor no longer keeps its caret arrows unconditionally (its boundary latch
  // hands the second discrete edge press out), so the stop is a legitimate
  // arrow destination and an arrow crossing the composer has somewhere real to
  // land instead of jumping from BEAT straight to the tiles.
  // The chips disable on the Shell route; the navigator skips a disabled ring
  // target onto the next live stop, so this grid needs no per-route membership.
  // The attachment row is sized to the live tile count (an empty row is dropped
  // by rowGridOrder, so a no-attachment compose runs as the two-row grid).
  // Declared under the cycle scope so it is consulted exactly while cycling. All
  // leaf stops — no delegated group, so no list-as-handle or edge-landing
  // primitive is needed here.
  const cycleSpatialOrder = useMemo<SpatialOrder>(() => {
    const k = (order: number) => `${SESSION_CYCLE_GROUP}:${order}`;
    return rowGridOrder([
      [
        k(SESSION_CYCLE_ORDER_ROUTE),
        k(SESSION_CYCLE_ORDER_CLAUDE_CODE),
        k(SESSION_CYCLE_ORDER_SESSION),
        k(SESSION_CYCLE_ORDER_PROJECT),
        // Slot 4 is the shell route's Cwd chip, commit mode's Changes chip,
        // and nothing on the code route (its Mode reading merged into the AI
        // settings chip along with slots 5 and 6's Model and Effort).
        k(SESSION_CYCLE_ORDER_CWD),
        k(SESSION_CYCLE_ORDER_AI),
        k(SESSION_CYCLE_ORDER_SUBMIT),
      ],
      // The find bar's row, present exactly while the bar is (rowGridOrder
      // drops an empty row, so Up from a status cell reaches the toolbar
      // directly when there is no bar).
      findBarOpen
        ? Array.from({ length: SESSION_CYCLE_FIND_STOP_COUNT }, (_, i) =>
            k(SESSION_CYCLE_ORDER_FIND_BASE + i),
          )
        : [],
      [
        // The fold control shares the Z2 row because it STANDS in it, at
        // the row's trailing edge in both forms ([B03]). So Right from JOBS
        // reaches it and Left from it reaches JOBS, which is what the eye
        // reads off the strip.
        k(SESSION_CYCLE_ORDER_STATUS_BASE + 0),
        k(SESSION_CYCLE_ORDER_STATUS_BASE + 1),
        k(SESSION_CYCLE_ORDER_STATUS_BASE + 2),
        k(SESSION_CYCLE_ORDER_STATUS_BASE + 3),
        k(SESSION_CYCLE_ORDER_STATUS_BASE + 4),
        k(SESSION_CYCLE_ORDER_FOLD),
      ],
      // The editor's text stop — the input-area wrapper, which is what wears
      // the ring while the editor itself stays blurred. Also a lone node.
      [k(SESSION_CYCLE_ORDER_EDITOR)],
      Array.from({ length: attachmentCount }, (_, i) =>
        k(SESSION_CYCLE_ORDER_ATTACHMENT_BASE + i),
      ),
    ]);
  }, [attachmentCount, findBarOpen]);
  useSpatialOrder(cycle.scopeId, cycleSpatialOrder);

  const editorSettings = useSyncExternalStore(
    editorStore.subscribe,
    editorStore.getSnapshot,
  );

  // Bind the CARD ROOT for the editor CSS variable cascade
  // (`--tug-font-family-editor` / `--tug-font-size-editor` /
  // `--tug-letter-spacing-editor` / `--tug-line-height-editor`). The root, not
  // the composer's pane: the card holds TWO editors and the find bar's query
  // field docks above the status bar, outside the entry pane — bound there it
  // never inherited the chosen editor font and silently rendered at the
  // substrate's 14px default beside a composer the user had set smaller. Every
  // editor in the card is an editor and reads the same settings.
  //
  // The `regenerateAtoms` callback re-renders baked atom chips when the editor
  // font changes, so atoms track the editor's chosen font.
  useLayoutEffect(() => {
    const el = sessionCardRootRef.current;
    if (!el) return;
    // `regenerateAtoms` re-renders the baked atom chips when the editor
    // font changes via the tools popover — atoms must track the editor
    // font so a chosen monospace actually reaches the atom chip labels.
    editorStore.bind(el, () => entryDelegateRef.current?.regenerateAtoms());
    return () => editorStore.unbind();
  }, [editorStore]);

  // Focus the prompt editor at meaningful moments:
  //
  //   - Construction: fires once when the card body first mounts.
  //     Guarantees a caret the moment the editor appears.
  //
  //   - Activation: fires on every path that makes this card the
  //     active card — click, Ctrl+`, programmatic activation, and
  //     post-close-of-active (auto-activate new top). By definition
  //     the card is active when this fires.
  //
  //   - Will-deactivate: fires when this card is about to lose
  //     active status (another card is being activated, including
  //     via new-card creation). Blur the editor here so the caret
  //     doesn't linger on a background card.
  //
  //   - Move / Resize: fires whenever this card's geometry commits.
  //     Cmd-drag and Cmd-resize move/resize a card WITHOUT activating
  //     it (a deliberate convenience for rearranging background cards
  //     without disturbing focus). We therefore guard the focus
  //     re-assertion with `getFirstResponderCardId() === cardId` so a
  //     background-card Cmd-drag does not steal focus from whatever
  //     card the user is actually working in.
  //
  // The focus paths route through `entryDelegate.focus()`, which is
  // idempotent if the editor already holds focus and places a caret
  // if the Selection has been cleared (e.g., by the selection guard).
  // `cardDidActivate` / `cardWillDeactivate` are the sole focus-management
  // path. The construction focus call is dropped — construction alone
  // does not make a card first responder (it may mount inside an
  // inactive stack). The follow-on `_flipFirstResponder` fires
  // `cardDidActivate` when the new card actually becomes FR, which
  // drives focus via the delegate handler below.
  //
  // `cardDidMove` / `cardDidResize` re-assert focus only when this card
  // is the deck's composite first responder — top-of-z-order can
  // drift from the composite bit when `activePaneId` does not match
  // the top pane (post-detach or post-move edge cases).
  const cardLifecycle = useCardLifecycle();
  const focusManager = useFocusManager();

  // Session-card's focus destination is ONE rule, not one element: the card's
  // pushed key destination when its focus context owns one — a pending
  // card-modal dialog's trap, a descended scope ([P20]) — and the resting
  // `tug-prompt-entry` otherwise. Several lifecycle triggers need to
  // re-claim that destination; each is gated on this card being first
  // responder so a background-card event never steals focus from the card
  // the user is actually in. The guard-and-claim is consolidated here so it
  // is one named thing, not a copy per trigger.
  //
  // The [P20] gate matters: a trigger that fires while a Question /
  // Permission dialog is pending (a title-bar click's zero-move
  // `cardDidMove`, a banner closing over the scrim) must land focus back on
  // the DIALOG's key view, never re-assert the deactivated editor — the
  // editor claim can't move DOM focus (the entry stands down under the
  // scrim) but its responder promotion still re-seeds the key view off the
  // dialog's stop, stripping the ring and the arrow walk. `adoptKeyCard` is
  // the same gate `applyBagFocus` runs on every activation claim.
  //
  // The [P08] gate above it: a FOLDED card has no resting editor to reclaim
  // — the transcript, the find bar and the composer are all `inert`, and the
  // browser strips focus from anything inside an inert subtree. Its one
  // destination is the fold control, so every trigger routes there while
  // the form is worn, ahead of `adoptKeyCard`: a pending Permission or Question
  // dialog is folded away with the transcript (Risk R05), so re-adopting its
  // trap would put the key view somewhere the user cannot see or reach. The
  // dialog is still pending in the store and the ordinary reclaim lands on it
  // again the moment the transcript is shown.
  //
  // `evenIfOccupied` is for the two transitions that MOVE the keyboard rather
  // than recover it: folding takes the key view off a live editor, and
  // unfolding takes it off a bar that is unmounting. Neither is a vacant
  // keyboard, so the vacancy guard below would decline both.
  const reclaimFocusDestination = useCallback((opts?: {
    evenIfOccupied?: boolean;
  }): void => {
    if (cardLifecycle?.getFirstResponderCardId() !== cardId) return;
    // While cycling, the cycle owns focus — a sheet opened from a cycle stop
    // returns to its stop (the retain disposition) or relinquishes via the engine
    // (the cycle's `restingFocus` lands the caret). Either way the card must NOT
    // also reclaim the editor here, or it would clobber the chip restore on a
    // retain close ([P15]). This reclaim is for sheets/banners closed outside a
    // cycle (a slash-command picker, a banner).
    if (cycle.cycling) return;
    if (folded && focusManager !== null) {
      focusManager.place(
        cardId,
        { kind: "focus-key", focusKey: FOLD_FOCUS_KEY },
        { modality: "keyboard" },
      );
      return;
    }
    if (focusManager?.adoptKeyCard(cardId) === true) return;
    if (focusManager !== null) {
      // The engine already holds a realized keyboard position (a
      // cold-boot restored ring, a popped mode's key view): the reclaim
      // must not clobber it with a resting-editor claim — the cold-boot
      // RESTORE path and the mode pop own focus, and a dom-granted
      // surface stripped by `inert` is re-granted by the watchdog on
      // its own. Claim only into a VACANT keyboard.
      if (opts?.evenIfOccupied !== true && focusManager.keyView() !== null) {
        return;
      }
      // Land the resting editor through the engine's one write
      // primitive — route flip + registered hook — never a raw
      // delegate focus (the boot-time steal the watchdog ledgered).
      focusManager.place(cardId, { kind: "engine" }, { modality: "pointer" });
      return;
    }
    entryDelegateRef.current?.focus();
  }, [cardLifecycle, cardId, entryDelegateRef, cycle, focusManager, folded]);

  // The fold and the unfold each move the keyboard, and neither is a mount, a
  // sheet or a banner — so neither reaches the reclaim through any trigger
  // above. Folding pulls the key view off an editor that is about to become
  // `inert` (Risk R01: without this the card is reachable and unfocused, the
  // caretless-void failure the `didHide` contract exists to prevent); showing
  // the transcript pulls it off a bar that is unmounting. Both are the
  // `evenIfOccupied` case, and both are gated on first responder inside the
  // reclaim, so a background card folding in a wall moves nobody's keyboard.
  //
  // Keyed on the flag's own transition rather than on the effect running: the
  // reclaim callback is rebuilt whenever the cycle's state moves, and a fold
  // effect that re-placed on every one of those would yank the keyboard back to
  // the bar each time the user Tab'd.
  const lastFoldRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    if (lastFoldRef.current === folded) return;
    const firstRun = lastFoldRef.current === null;
    lastFoldRef.current = folded;
    if (firstRun) return;
    // Showing the transcript ENDS a cycle rather than continuing one. The walk
    // the user was in had two kinds of stop, and the form under it has just
    // changed out from beneath them, so a retained cycle would be a mode
    // walking a card that is no longer the one they entered. `exit` pops the
    // mode and lands the resting caret, which is exactly where the mouse path
    // leaves it.
    if (!folded && cyclingRef.current) {
      exitCycleRef.current();
      return;
    }
    // A show hands the keyboard back, and the RELEASE half of that used to be
    // free: the Show Transcript bar unmounted with the form, taking its key
    // view with it, and the reclaim below then ran against an empty keyboard.
    // The control that replaced it stands in both forms ([B03]), so nothing
    // unmounts and the release has to be performed. It matters in exactly the
    // case the reclaim cannot overrule: a pending dialog owns the card's
    // keyboard through a trapped mode, and its Return-home can only take the
    // card's one mark back if no button is holding the key view when
    // `adoptKeyCard` runs.
    if (!folded) focusManager?.setKeyView(null);
    reclaimFocusDestination({ evenIfOccupied: true });
  }, [focusManager, folded, reclaimFocusDestination]);

  // ── The fold's terminal state ([B06], [P03], (#motion-build)) ────────────
  //
  // The motion itself is CSS keyed on the pane's `data-folded` ([L13],
  // [L06]) and none of it is here. What CSS cannot say is the state the
  // motion ENDS at, and writing that at the flag's flip is what would cancel
  // the motion before its first frame: a `display: none` region has no box to
  // fold, and an `inert` one loses the caret while it is still on screen. So
  // the flag drives the motion, and this writes the terminal state when the
  // motion ends.
  //
  // `data-fold` on the card root is the whole vocabulary — `"moving"` while a
  // fold is in flight in either direction, `"settled"` once one has ended with
  // the card folded, absent while the card is open. The DOM zone, never
  // React state ([L06]): a commit per frame of the fold is exactly the stream
  // the settle holds every session's notifications off for.
  //
  // The unfold's `inert` comes off at once rather than at the end. The reclaim
  // above lands the caret back in the composer on this same commit, and a
  // composer still `inert` for a beat cannot take it — the terminal state that
  // has to wait is the folded one, and only ever the folded one.
  const viewSlotRef = useRef<HTMLDivElement | null>(null);
  const entryRegionRef = useRef<HTMLDivElement | null>(null);
  const foldRef = useRef<boolean | null>(null);
  const foldEndRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const root = sessionCardRootRef.current;
    if (root === null) return;
    if (foldRef.current === folded) return;
    const firstRun = foldRef.current === null;
    foldRef.current = folded;

    const setInert = (on: boolean): void => {
      for (const el of [viewSlotRef.current, entryRegionRef.current]) {
        if (el === null) continue;
        if (on) el.setAttribute("inert", "");
        else el.removeAttribute("inert");
      }
    };
    const land = (): void => {
      if (foldEndRef.current !== null) {
        window.clearTimeout(foldEndRef.current);
        foldEndRef.current = null;
      }
      if (folded) root.setAttribute("data-fold", "settled");
      else root.removeAttribute("data-fold");
      setInert(folded);
    };

    if (!folded) setInert(false);

    // A card that mounts already folded — a restored deck, a card dropped
    // into a wall — has no fold to watch: it is there. Same for a reader who
    // asked for less motion, where the transition is a 1ms cut and the
    // `transitionend` worth waiting on is not coming.
    if (
      firstRun ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      land();
      return;
    }

    root.setAttribute("data-fold", "moving");
    const entry = entryRegionRef.current;
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.target !== entry) return;
      if (event.propertyName !== "grid-template-rows") return;
      land();
    };
    entry?.addEventListener("transitionend", onTransitionEnd);
    // The backstop. `transitionend` never fires for a transition the browser
    // did not start — a fold in a pane the compositor is not painting, a theme
    // that took the duration to zero — and a fold that never lands leaves a
    // live composer behind a card nobody can see. The window is the settle's
    // own, read off the same property the CSS reads and scaled by the same
    // `--tug-timing` the settle scales by in `deck-canvas.tsx`, so there is
    // still one clock and this is only its far edge.
    foldEndRef.current = window.setTimeout(
      land,
      readSettleMs(root) * getTugTiming() + FOLD_END_SLACK_MS,
    );
    return () => {
      entry?.removeEventListener("transitionend", onTransitionEnd);
      if (foldEndRef.current !== null) {
        window.clearTimeout(foldEndRef.current);
        foldEndRef.current = null;
      }
    };
  }, [folded]);

  useCardDelegate(cardId, {
    cardDidActivate: () => {
      // Phase E.11 Step 4h — macrotask focus claim retired.
      // The single-channel `applyBagFocus` dispatcher (called
      // synchronously from `transferFocusForActivation`) is now
      // the only path that writes activation focus, and it
      // invokes the engine via the registered engine hook (4e)
      // for engine kinds — no macrotask, no MessageChannel
      // deferral. The previous `entryDelegateRef.current?.focus()`
      // here drained AFTER the framework's claim and clobbered
      // framework-axis targets like the find input ([L05]
      // timing-derived ordering violation; [L23] single-channel
      // violation). See `tuglaws/state-preservation.md`
      // [Focus dispatch model].
      //
      // `cardDidMove` / `cardDidResize` keep their delegate focus
      // claims — those handlers fire on gestures that already
      // moved the card's DOM identity (cross-pane move, resize)
      // and re-asserting focus on the editor is the only path
      // that recovers from the inherent re-mount.
    },
    // `cardWillDeactivate` deliberately does NOT call
    // `entryDelegateRef.current?.blur()`. Calling .blur() on the
    // contenteditable here clears any non-collapsed selection the
    // user has placed. When the cascade
    // fires from `applicationWillResignActive` (cmd-tab away), the
    // OS already removes focus from the WKWebView; an additional
    // explicit blur destroys the selection BEFORE the
    // window-blur save flushes the bag, so on cmd-tab back the
    // engine's `getSelectedRange()` returns null and the
    // refocus-on-activation places a caret at end-of-content
    // instead of restoring the user's selected span.
    cardDidMove: () => {
      if (cardLifecycle?.getFirstResponderCardId() !== cardId) return;
      deckTrace.record({
        kind: "macrotask-focus-claim",
        cardId,
        delegate: "cardDidMove",
      });
      reclaimFocusDestination();
    },
    cardDidResize: () => {
      if (cardLifecycle?.getFirstResponderCardId() !== cardId) return;
      deckTrace.record({
        kind: "macrotask-focus-claim",
        cardId,
        delegate: "cardDidResize",
      });
      reclaimFocusDestination();
    },
  });

  // ── Editor focus contract — `inert` / `didHide` invariant ───────────────
  //
  // **Contract** ([L24] structure-zone events drive structure-zone
  // effects): every overlay that sets `inert` on this card's
  // `.tug-pane-body` MUST emit a per-card `xxxDidHide` lifecycle event
  // after `inert` is cleared, and `SessionCardBody` MUST subscribe with
  // an idempotent focus claim gated on this card being first
  // responder. Adding a new overlay that violates the contract
  // silently breaks the editor's caret on dismissal.
  //
  // Why it matters: the browser strips focus from any element inside
  // an `inert` subtree, and CodeMirror's caret layer paints only
  // while `view.hasFocus`. Without a re-focus after `inert` clears,
  // the editor is reachable but unfocused — the user clicks the
  // pane, sees no caret, and types into a void. The
  // `<overlay>DidHide` event fires from inside the same React commit
  // that clears `inert` (see `tug-pane-banner.tsx` /
  // `tug-sheet.tsx`), so claiming focus here lands DOM focus the
  // moment the body becomes interactive again — no race window.
  //
  // **Today's overlays satisfying the contract:**
  //
  //   - `TugSheet` → `sheetDidHide`. Covers the picker → "Open" →
  //     bind → editor-mount path; also covers the editor-settings
  //     sheet's open/close cycle for an already-mounted body.
  //   - `TugPaneBanner` → `bannerDidHide`. Covers status banners
  //     (resume-loading, transport-restoring) that mount during
  //     session-init, set inert, blur the editor, then unmount
  //     when their triggering condition resolves.
  //
  // The focus call is idempotent — `manager.focusResponder(editorId)`
  // against an already-focused editor is a no-op for chain state
  // AND for DOM focus when contentDOM is already `activeElement`.
  // Composing two emitters (sheet + banner) costs one stale call
  // per cycle; the cost is bounded and worth the simpler invariant.
  //
  // Pinned by `tests/app-test/at0175-session-mount-focus.test.ts`. A
  // future overlay that sets `inert` without emitting `didHide`
  // breaks at0051; the test exists exactly so the contract isn't
  // re-discovered the hard way. See
  // `arc/tugplan-session-init-orchestration.md` [V03] for
  // the bug history.
  //
  // [L11] the banner / sheet are status surfaces that emit lifecycle
  //       events; this card is the responder that re-claims focus.
  // [L23] focus + caret are user-visible state — preserved across
  //       every overlay show/hide cycle by this contract.
  // [L24] structure-zone (`inert` clearing) drives structure-zone
  //       (focus reclaim) via the per-overlay event pipe.
  useSheetDelegate(cardId, {
    sheetDidHide: () => {
      reclaimFocusDestination();
    },
  });
  useBannerDelegate(cardId, {
    bannerDidHide: () => {
      reclaimFocusDestination();
    },
  });

  // Picker → body handoff focus claim. The picker sheet's `didHide`
  // fires when its exit animation finishes; the body only mounts a
  // few milliseconds later, once `spawn_session_ok` flips the
  // binding. So the `sheetDidHide` subscription above is registered
  // too late to catch the picker's dismissal — by the time this
  // body exists, the event has already passed. Claim focus once on
  // mount instead, through the same first-responder-gated helper
  // (the body can also mount inside an inactive stack on cold-boot /
  // restore, where the cold-boot RESTORE path owns focus).
  useLayoutEffect(() => {
    reclaimFocusDestination();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── First-mount fade-in ─────────────────────────────────────────────────
  //
  // Coordinate the picker → body handoff: the picker sheet is in the
  // last frames of its exit translate when binding lands and this
  // body mounts. Without an enter animation the body snaps in
  // abruptly while the sheet is still translating — the two motions
  // don't share a beat. A brief opacity fade lets the body materialize
  // alongside the sheet's exit so the transition reads as a single
  // gesture rather than a hard appearance.
  //
  // Mechanics: empty-deps `useLayoutEffect` runs exactly once when
  // this card first acquires services. It captures the root element
  // via `sessionCardRootRef.current`, sets opacity to "0" synchronously
  // (so the first paint after commit shows the start state without a
  // flash), then opens a TugAnimator group that animates opacity
  // 0 → 1 over `--tug-motion-duration-moderate` with `ease-out`. The
  // group's `commitStyles()` lands the final value (opacity 1) on
  // the element when the animation finishes; `cancel()` removes the
  // animation handle. Reduced-motion users opt out automatically via
  // `isTugMotionEnabled()` inside `tug-animator` (the spatial-strip
  // path doesn't apply here — opacity has no spatial component — but
  // duration shortens to `--tug-motion-duration-fast`).
  //
  // [L13] TugAnimator owns programmatic motion that coordinates with
  //       React mount; CSS keyframes would require a parallel "first-
  //       mount-only" attribute, which is needless complexity for a
  //       one-shot animation.
  // [L14] Radix Presence is not in play here — the body's mount is
  //       driven by the binding flip, not a Radix `data-state`
  //       transition, so we are firmly in TugAnimator's lane.
  // [L23] opacity is appearance-zone state and the animation does
  //       not touch focus, selection, or scroll position. The
  //       editor's caret-layer paints behind the fade and ramps in
  //       with the rest of the body. The focus contract documented
  //       above is unaffected — the fade does not set `inert` and
  //       does not interfere with `view.hasFocus`.
  // [L24] structure-zone (`SessionCardBody` mount) drives appearance-
  //       zone (opacity ramp); the WAAPI animation writes directly
  //       to the DOM, never round-tripping through React state ([L02]
  //       does not apply because this is appearance, not data).
  //
  // No cleanup is registered: if the body unmounts mid-fade, the
  // WAAPI animation is garbage-collected with the detached element.
  // `commitStyles()` inside tug-animator catches the
  // `InvalidStateError` thrown when the element is no longer
  // rendered, so the late `.finished` resolution is harmless.
  useLayoutEffect(() => {
    const el = sessionCardRootRef.current;
    if (el === null) return;
    // No materialize fade on a restore-mount (Maker ▸ Reload /
    // cold-boot rehydration). The fade exists only to coordinate the
    // picker → body handoff (share a beat with the picker sheet's
    // exit); a restore has no picker to coordinate with, so the fade
    // reads as a gratuitous flash on top of the reveal. Skip it when
    // the card mounts into the cold-restore / replay window; keep it
    // for a genuine picker → new-card creation. The signal is read
    // fresh from the store at mount ([L02] effects may read stores
    // directly), the same predicate `replayHoldActive` derives.
    const snap = codeSessionStore.getSnapshot();
    if (snap.phase === "replaying" || deriveColdRestoreActive(snap)) return;
    // Set the start state inline so the first paint after commit
    // shows opacity:0 — WAAPI's pending-phase doesn't apply the
    // first keyframe with the default `fill: forwards`. Cleared on
    // animation completion via tug-animator's commitStyles() path.
    el.style.opacity = "0";
    const g = group({ duration: "--tug-motion-duration-moderate" });
    g.animate(el, [{ opacity: 0 }, { opacity: 1 }], {
      key: "session-card-enter",
      easing: "ease-out",
    });
    // Run once on first mount; never re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Return focus to the editor after a successful submit so the user
  // can type the next prompt immediately, and pull the transcript
  // back to the live edge. `onAfterSubmit` fires from `performSubmit`
  // only on the send/handled path — not on the Stop (canInterrupt)
  // branch, not on blocked submits — so failures that surface later
  // via `lastError` are inspectable without the caret yanking back
  // mid-read.
  //
  // `scrollToBottom` re-engages follow-bottom: if the user had
  // scrolled up to read history, their fresh submit jumps the
  // transcript down so the new turn (and the response streaming into
  // it) is in view. Once follow-bottom is re-engaged the new turn row
  // pins automatically via the list's post-commit pin.
  //
  // Submitting always collapses the entry: the cleared editor drives the
  // content sizer back to the opening floor. Keeps the transcript readable
  // after every send.
  const handleAfterSubmit = useCallback(() => {
    transcriptRef.current?.scrollToBottom();
    entryDelegateRef.current?.focus();
  }, [entryDelegateRef]);

  // Z2 telemetry popovers → transcript scroll. The Time / Tokens
  // popovers render each turn's `#NNNN` entry pair as buttons;
  // clicking one lands here with that entry's transcript row index.
  // `block: "start"` pins the entry's top flush to the viewport top.
  // The handle is read at call time ([L07]) so a not-yet-mounted
  // transcript is a safe no-op.
  const handleScrollToRow = useCallback((rowIndex: number): void => {
    transcriptRef.current?.scrollToIndex(rowIndex, {
      block: "start",
      animated: true,
    });
  }, []);

  // Card-content responder scope for key-card-routed keyboard
  // shortcuts. Registers a `kind: "card-content"` node under the
  // session card's body element; any keybinding with `scope: "key-card"`
  // (declared in keybinding-map.ts) is dispatched here when this is
  // the active card. The chain walks UP from this node, so
  // unhandled actions fall through to the card-level responder,
  // canvas, and root — same semantics as any other chain walk.
  //
  // Handlers:
  //   - FOCUS_PROMPT (⌘K): move keyboard focus to the prompt editor.
  //     Reads the delegate via the ref [L07] so the handler closure
  //     registered at mount never goes stale.
  // Permission-mode cycle + per-card persistence/restore ([D02], [D03],
  // [D07]). `cycle` advances default → acceptEdits → plan → auto → … and
  // sends the `permission_mode` frame; the Z4B chip reflects the result
  // from the next `system_metadata`. Bound to ⇧⇥ below.
  const permissionMode = usePermissionMode({
    cardId,
    codeSessionStore,
    sessionMetadataStore,
  });

  // The single permission sheet, owned at the card level so the chip click
  // and the `/permissions` slash command present the same sheet ([#step-1c]).
  // One shared sheet host for the card's pickers, so opening one (chip or
  // slash command) replaces any other open picker instead of stacking a
  // second sheet on top of it ([#step-2b]).
  const cardPickerSheet = useTugSheet();

  // The `/permissions` rules editor, owned at the card level so the slash
  // command opens it card-scoped ([D15]). Reads the session `cwd` fresh at
  // open time; a no-op until session metadata reports a cwd.
  const permissionRulesSheet = usePermissionRulesSheet({
    cardId,
    sessionMetadataStore,
    codeSessionStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // Model set path + per-card persistence/restore ([D07]). `setModel` sends
  // `model_change`, optimistically reflects on the chip, and persists per card;
  // the picker (chip press / `/model`) funnels through it, and a fresh card
  // adopts the deck-wide default (Settings card) on mount. Since model is not
  // carried on the spawn frame, this seeds both new and resumed cards.
  const model = useModel({
    cardId,
    codeSessionStore,
    sessionMetadataStore,
  });

  // Bulletin when the card's saved model selector (per-card, else the deck
  // default) is a concrete pick the persisted live catalog no longer offers:
  // reset to `default` and point the user at Settings → Assistant. Single-shot
  // per mount; the `default` zero-state never triggers it.
  useUnavailableModelBulletin({
    cardId,
    showSheet: cardPickerSheet.showSheet,
  });

  // Always-current model catalog: whenever this card's `session_capabilities`
  // reports claude's live `models[]`, persist it so the picker fallback, the
  // Settings default dropdown, and resumed / just-launched cards read the real
  // list instead of a hardcoded constant ([model-catalog.ts]). A resumed
  // session carries no capabilities (empty list) — `persistModelCatalog`
  // no-ops on empty so it never clobbers the cached catalog with nothing.
  const liveModels = useSyncExternalStore(
    sessionMetadataStore.subscribe,
    useCallback(
      () => sessionMetadataStore.getSnapshot().models,
      [sessionMetadataStore],
    ),
  );
  const persistedCatalogRef = useRef<string>("");
  useEffect(() => {
    if (liveModels.length === 0) return;
    const serialized = JSON.stringify(liveModels);
    if (serialized === persistedCatalogRef.current) return;
    persistedCatalogRef.current = serialized;
    persistModelCatalog(liveModels);
  }, [liveModels]);

  // `/rewind` turn picker + restore confirm ([#step-7-3]), card-scoped per
  // [D15]. Reads the transcript fresh at open time; the popup already gates
  // the command on having a rewind target, and `openRewindSheet` no-ops if
  // there is none.
  const rewindSheet = useRewindSheet({
    codeSessionStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // The join's decision surface is the Changes shade, and this is what
  // summons it. Nothing opens it by hand — the feed causes it, on the card of
  // a session bound to that arc and nowhere else.
  //
  // The card goes to the Changes **route**, not to a glance at it. Work that
  // is ready to join is presented the way the user would present it by hand:
  // `enterChanges()` enters join mode, which raises the shade through the
  // mode↔sheet coupling below, flips the Z4A toggle (its value derives from
  // `landingActive`), swaps the composer to the join's draft, and arms ⬆ as
  // Join. A shade raised without the mode was the half-switched card — the
  // room open, the composer still a prompt composer, and the join behind a
  // mode nothing had entered.
  //
  // Entering is not destructive: the composer stashes an in-progress prompt on
  // mode entry and restores it verbatim on exit, and every existing exit —
  // Escape, ⌘., the shade's ✕, the Prompt segment, ⌃⌘C, a completed land —
  // already returns the card to the Prompt route with the shade down. Nothing
  // here needs its own way out.
  //
  // **Quiet moments only, and the gate re-arms.** The shade is a view swap —
  // it replaces the transcript pane rather than pushing it — so entering over
  // a running turn would cover the output the user is reading, and entering
  // over a half-typed composer would take the surface out from under them. So
  // all five hold before it fires: the card not folded, no turn in flight, no
  // landing up, an empty composer, and the shade not already showing. Every
  // one of them is a *dependency*, not a peek: a deferral re-runs this effect
  // the moment the turn settles, the composer empties, the shade closes, or
  // the user unfolds. (Read as refs, the composer and shade gates could defer
  // forever — nothing would wake the effect once the offer stopped changing.)
  //
  // **The room is a room of the open form ([B06]).** Folded, the top column
  // the shade swaps over IS the Z2 instrument row, so the shade's scrim lands
  // on the fold control and the Join it offers lives in the folded-away Z5:
  // a room open behind a door nobody can reach. The deferral is free, because
  // `folded` is a dependency like the rest — the user's own unfold re-runs
  // this effect and the room opens armed.
  //
  // The conditions are {@link shouldRevealJoinOffer}, apart from the card so
  // the decision is a unit test rather than a claim about a rendered tree.
  //
  // **Once per arc head, remembered only for this mount.** The offer's
  // `request_id` moves when *either* head does, so it is not what to remember:
  // a base push would mint a new id over work the reader has already been
  // shown, and the room would open again every time somebody else landed
  // something. The **arc head** is the fact that says "work you have not
  // seen" — a new round moves it, a base move does not. Nothing durable
  // records the reveal: closing the shade discards nothing, and the worst case
  // of forgetting is one extra glance ([L22] — mount-local memory,
  // deliberately not a store).
  const joinOffer = boundArcEntry?.join?.offer ?? null;
  const turnInFlight = useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().canInterrupt === true,
  );
  // Whether the composer holds no user content. The entry reports this on
  // transitions only — never per keystroke — so this is render state that
  // moves a handful of times a session ([L22]), and unlike a ref peek it is a
  // signal the gate above can wait on: a reveal deferred over a half-typed
  // composer fires on its own when the composer empties.
  const [composerEmpty, setComposerEmpty] = useState(true);
  const revealedOffersRef = useRef<Set<string>>(new Set());
  // **A cleared block is new work to show, even at the same arc head.**
  //
  // The memory above is keyed on the arc head because that is the fact that
  // means "work you have not seen" — a base move must not re-open the room.
  // A resolve is the one thing that moves the BASE and changes the answer: a
  // arc blocked by uncommitted work on the base carries a standing offer its
  // head already spent, so without this the room would stay shut on the arc
  // the user just unblocked, which is the moment they most want it open.
  //
  // The edge is what is remembered, not the state: forgetting on every clean
  // frame would re-open the room on every recompute.
  const joinBlocked = (boundArcEntry?.join?.blockers ?? []).length > 0;
  const wasBlockedRef = useRef(false);
  useEffect(() => {
    if (wasBlockedRef.current && !joinBlocked) revealedOffersRef.current.clear();
    wasBlockedRef.current = joinBlocked;
  }, [joinBlocked]);
  useEffect(() => {
    const arcHead = joinOffer?.arc_head;
    if (arcHead === undefined) return;
    // A refusal never spends the head: spending it says the reader has seen
    // this work, and a reveal that did not happen showed them nothing.
    if (
      !shouldRevealJoinOffer({
        alreadyRevealed: revealedOffersRef.current.has(arcHead),
        turnInFlight,
        anyLandingActive,
        composerEmpty,
        shadeShowing: shadeView !== "none",
        folded,
      })
    ) {
      return;
    }
    revealedOffersRef.current.add(arcHead);
    enterChanges();
  }, [
    joinOffer,
    turnInFlight,
    anyLandingActive,
    composerEmpty,
    shadeView,
    folded,
    enterChanges,
  ]);

  // The same reveal, asked for out loud — an Arcs card arc row activating routes
  // here through the card-content responder, and this is [D152]'s one reveal
  // path rather than a second one. Defined beside the effect above so both
  // share the controller and the memory: whichever fires first spends the
  // standing offer's head, so the passive reveal never re-opens the room for
  // work the reader has just been shown.
  //
  // The quiet-moment gate is deliberately not consulted. It exists to keep an
  // *unbidden* entry from covering what somebody is reading; an explicit click
  // is its own license, exactly as the Z4A Changes segment is.
  //
  // One path, two forms, chosen by the offer. An arc with work ready to join
  // gets the same route entry the automatic path performs, so the row the user
  // clicked arrives armed. An arc still mid-implementation has no join to arm:
  // entering join mode on it would seed a composer for a press its own gate
  // must refuse, so that stays a glance at the room.
  //
  // **Folded, it unfolds and then enters ([B07]).** A card that has to be
  // opened before it can show a room takes its one gesture to open, and the
  // entry follows in the same commit — the mode↔sheet coupling raises the
  // shade after the render the unfold has already been committed in, so it
  // never lands over Z2. Handing the entry to the deferred effect instead
  // would put a bidden entry behind the unbidden gate: a head already spent
  // on this mount, a half-typed composer or a turn in flight would each
  // swallow the click and leave the reader with a card that merely unfolded.
  // The head is added first, so the effect re-running on the unfold sees the
  // room as already shown and defers rather than entering it twice.
  const revealChanges = useCallback((): void => {
    const arcHead = joinOffer?.arc_head;
    if (arcHead === undefined) {
      unfoldForChanges();
      shadeViewController.show("changes");
      return;
    }
    revealedOffersRef.current.add(arcHead);
    enterChanges();
  }, [joinOffer, shadeViewController, enterChanges, unfoldForChanges]);

  // `/resume` focused sessions overlay ([#step-8]), card-scoped per [D15].
  // Reads the bound project from the binding store and lists its sessions;
  // picking one rebinds this card to that conversation. Distinct from the
  // full-card `SessionProjectPicker` (unbound state) and from `/rewind`.
  const resumeSheet = useResumeSheet({
    cardId,
    showSheet: cardPickerSheet.showSheet,
  });

  // `/skills` listing sheet ([#step-12d]), card-scoped per [D15]. Fires
  // `skills_inventory_query` on open; the response renders as a read-only
  // `TugListView`. Single-shot, not a feed.
  const skillsSheet = useSkillsSheet({
    skillsInventoryStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // `/agents` listing sheet ([#step-12b]), card-scoped per [D15]. A simple
  // read-only directory of the subagents Claude can delegate to — projected
  // from the agent names already in `SessionMetadataStore.slashCommands`.
  const agentsSheet = useAgentsSheet({
    sessionMetadataStore,
    codeSessionStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // `/memory` listing sheet ([#step-12a]), card-scoped per [D15]. Lists the
  // project / user / auto-memory destinations; a row hands its path to the OS
  // (file → editor, folder → Finder) via the host `openPath` bridge.
  const memorySheet = useMemorySheet({
    sessionMetadataStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // `/hooks` listing sheet ([#step-12c]), card-scoped per [D15]. Fires
  // `hooks_query` on open; the response renders as a read-only `TugAccordion`
  // of hook events. Single-shot, not a feed.
  const hooksSheet = useHooksSheet({
    hooksInventoryStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // `/usage` sheet, card-scoped per [D15]. The panel (limit gauges + reset
  // times + the contributing breakdown) comes from the app-level `UsageStore`,
  // which shells `claude -p "/usage"` on open (account-global, reached via
  // context); the session cost/token totals fold from this card's transcript.
  const usageStore = useUsageStore();
  const usageSheet = useUsageSheet({
    usageStore,
    codeSessionStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // `/help` tabbed sheet ([#step-13b2]) per [D16], card-scoped per [D15]. A
  // General tab (Dev + shortcuts + the unsupported-commands doc link) over a
  // Commands / Custom-commands browse of the session catalog, projected through
  // the [D14] allowlist so it lists exactly what the slash popup offers.
  const helpSheet = useHelpSheet({
    cardId,
    sessionMetadataStore,
    showSheet: cardPickerSheet.showSheet,
  });

  // Pane-scoped bulletin API, captured from inside the provider by
  // `PaneBulletinAnchor` (rendered below) so `/copy` can raise its
  // confirmation toast in this card.
  const paneBulletinRef = useRef<TugPaneBulletinApi>(null);

  // `/rename` session name ([#step-13d]). `/rename <text>` sets it directly;
  // bare `/rename` opens a one-field dialog seeded with the current name. Both
  // optimistically update the Z4B chip, send `rename_session` to tugcast, and
  // report the outcome in this card's bulletin when the ack lands — which is
  // why the hook is handed the bulletin: the dialog path has no other voice.
  const renameSheet = useRenameSessionSheet({
    cardId,
    showSheet: cardPickerSheet.showSheet,
    notify: () => paneBulletinRef.current,
  });

  // Reasoning-effort set path + per-card persistence/restore ([#step-4],
  // [D07]). `setEffort` sends `effort_change` (tugcode respawns with
  // `--effort` + `--resume`, [R07]); the effort chip + picker funnel through
  // it. The shared picker (chip press / future `/effort`) reads the active
  // model's supported levels fresh at open time.
  const effort = useEffort({
    cardId,
    codeSessionStore,
    sessionMetadataStore,
  });

  // Surface for each local slash command, keyed by command name. The
  // `as const satisfies` registry narrows `LocalCommandName` to the literal
  // union, so this `Record` is exhaustive — a registered command without a
  // wired surface is a compile error ([#step-1c] / [D23]).
  // Handle on the Z2 status row so `/context` can pop its CONTEXT
  // popover — the breakdown is already a click on that cell; the slash
  // command just opens the same surface (no separate sheet). Null while
  // the row isn't the current Z2 datum, in which case the call no-ops.
  const statusRowRef = useRef<SessionTelemetryStatusRowHandle>(null);

  // Close out a `/compact` run: when the progress store reaches a terminal
  // outcome, clear the store — which dismisses the progress sheet (it watches
  // the same store). Success is self-evident (the Compaction Summary block +
  // boundary divider land in place), so it raises no bulletin; cancel / failure
  // DO, since nothing visible changed. Native compaction happens in place —
  // there is no session swap to mask, so every outcome dismisses immediately.
  // [L02] store state via `useSyncExternalStore`.
  const getCompactionProgress = useCallback(
    () => compactionProgressStore.getFor(cardId),
    [cardId],
  );
  const compactionProgress = useSyncExternalStore(
    compactionProgressStore.subscribe,
    getCompactionProgress,
  );
  useEffect(() => {
    if (compactionProgress === null || compactionProgress.outcome === null) {
      return;
    }
    const notify = paneBulletinRef.current;
    if (compactionProgress.outcome === "canceled") {
      notify?.caution("Compaction canceled — session left intact");
    } else if (compactionProgress.outcome === "failed") {
      notify?.danger(compactionProgress.failureReason ?? "Compaction failed");
    }
    // "succeeded" → the divider + summary block speak for themselves.
    compactionProgressStore.clear(cardId);
  }, [compactionProgress, cardId]);

  // The card's `/compact` run, whoever sends the command: the pane-modal sheet
  // and the hold it puts on the card, the watcher that settles it, and — for a
  // `/compact` the wheel sent, which tugcast dispatches itself and no command
  // handler here ever sees — the watch that opens the run off the turn.
  // Dispatch stays with the caller; `compact` below sends its own submission.
  const beginCompactionRun = useCompactionRun({
    cardId,
    codeSessionStore,
    showSheet: cardPickerSheet.showSheet,
    bulletinRef: paneBulletinRef,
  });

  // A Mode / Model / Effort change must not race a running turn ([source→
  // delegate]): the setter seam declines it, and the surfaces that reach those
  // setters (the slash pickers, ⇧⇥ cycle, the Permission Mode menu) refuse up
  // front with a caution so the refusal is visible rather than a silent no-op.
  // Reads `canSubmit` live at invocation time ([L07]).
  const guardTurnIdleForSetting = (noun: string): boolean => {
    if (codeSessionStore.getSnapshot().canSubmit) return true;
    paneBulletinRef.current?.caution(
      `Can't change ${noun} while a turn is in flight`,
    );
    return false;
  };

  // The Claude Code version the sheet footer reports: the live one once the
  // session has reported it, else the last version any session saw ([L02]).
  const lastKnownCcVersion = useTugbankValue<string | null>(
    CC_VERSION_DOMAIN,
    CC_VERSION_KEY,
    parseLastKnownVersion,
    null,
  );

  // The one AI configuration sheet, owned at the card level so the chip press,
  // `/ai`, and the three deep-link commands all present the same sheet.
  const aiConfigSheet = useAiConfigSheet({
    cardId,
    sessionMetadataStore,
    showSheet: cardPickerSheet.showSheet,
    commitDisposition: SESSION_CYCLE_PICKER_COMMIT_DISPOSITION,
    // Walk the ordered array through the existing single set paths — each
    // already handles optimistic reflection, per-card persistence, and its
    // frame, so the transaction adds no send code of its own.
    //
    // The guard runs ONCE here, before the first action, and not per action.
    // Opening the sheet already funnels through it, but the sheet is a
    // transaction the user can hold open across the start of a turn — and the
    // set paths' seam declines a mid-turn change individually, which would
    // half-apply a two-action commit (model sent, effort refused). All or
    // nothing: refusing here is what a transaction is for.
    onCommit: (actions) => {
      if (!guardTurnIdleForSetting("the AI configuration")) return false;
      for (const action of actions) {
        switch (action.kind) {
          case "mode":
            permissionMode.setMode(action.value);
            break;
          case "model":
            model.setModel(action.value);
            break;
          case "effort":
            effort.setEffort(action.value);
            break;
        }
      }
      return true;
    },
    scopeNote: "Settings apply to this session only",
    renderFooter: (close) => (
      <>
        <TugPushButton
          size="sm"
          emphasis="ghost"
          role="action"
          data-slot="ai-config-rules-link"
          onClick={() => {
            // One sheet host: close this one before opening the rules editor,
            // so the two are sequential rather than stacked.
            close();
            permissionRulesSheet.openRulesSheet();
          }}
        >
          Edit permission rules…
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="ghost"
          role="action"
          data-slot="ai-config-changelog-link"
          onClick={() => openUrlInOS(CLAUDE_CODE_CHANGELOG_URL)}
        >
          {`Claude Code ${sessionMetadataStore.getSnapshot().version ?? lastKnownCcVersion ?? "?"} · changelog`}
        </TugPushButton>
      </>
    ),
  });

  /**
   * Run one refs op ([P01]/[P07]). The typed line is the truth: it is parsed
   * once here into needles + normalized flags, and the same line is echoed to
   * the feed so the block header shows what the user typed rather than a
   * reconstruction of what was parsed.
   *
   * An unknown flag is a subdued notice, not a refusal — the rest of the line
   * still names a search worth running.
   */
  const runRefsCommand = (kind: RefsOpKind, args: string): void => {
    const notify = paneBulletinRef.current;
    const parsed = parseRefsArgs(kind, args);
    if (parsed.unknown.length > 0) {
      notify?.caution(
        `Ignoring unknown ${kind} ${
          parsed.unknown.length === 1 ? "flag" : "flags"
        }: ${parsed.unknown.join(" ")}`,
      );
    }
    if (parsed.needles.length === 0) {
      notify?.caution(`Usage: /${kind} <needle>…`);
      return;
    }
    refsSessionStore.run({
      kind,
      needles: parsed.needles,
      flags: parsed.flags,
      command: `/${kind} ${args.trim()}`,
    });
  };

  const slashCommandSurfaces: Record<
    LocalCommandName,
    (args: string, draft?: SlashCommandDraft) => void
  > = {
    // `/permissions` is the tool-permission RULES editor, a different surface
    // from the mixer — it keeps its own door.
    permissions: () => permissionRulesSheet.openRulesSheet(),
    // `/ai` opens on the sticky row; the three attribute names deep-link to
    // their own row, so the muscle memory lands where it always did.
    ai: () => {
      if (guardTurnIdleForSetting("the AI configuration")) {
        aiConfigSheet.openAiConfigSheet();
      }
    },
    model: () => {
      if (guardTurnIdleForSetting("the AI configuration")) {
        aiConfigSheet.openAiConfigSheet("model");
      }
    },
    effort: () => {
      if (guardTurnIdleForSetting("the AI configuration")) {
        aiConfigSheet.openAiConfigSheet("effort");
      }
    },
    mode: () => {
      if (guardTurnIdleForSetting("the AI configuration")) {
        aiConfigSheet.openAiConfigSheet("mode");
      }
    },
    rewind: () => rewindSheet.openRewindSheet(),
    // `/resume` opens the overlay to choose a session; `/resume <callsign>`
    // names one and skips it ([P12] — the tag is addressable). An unresolvable
    // callsign is answered in this card rather than swallowed: a silent no-op
    // on a typed command reads as the app being broken.
    resume: (args) => {
      const tag = args.trim();
      if (tag.length === 0) {
        resumeSheet.openResumeSheet();
        return;
      }
      const failure = resumeSheet.resumeByTag(tag);
      if (failure === null) return;
      const notify = paneBulletinRef.current;
      switch (failure.kind) {
        case "unknown-tag":
          notify?.caution(`No session called ${failure.tag}`);
          break;
        case "already-bound":
          notify?.caution(`${failure.tag} is already open in this card`);
          break;
        case "live-elsewhere":
          notify?.caution(`${failure.tag} is open elsewhere`);
          break;
        case "disconnected":
          notify?.danger("Not connected");
          break;
      }
    },
    // `/diff` opens the Project Diff card — the repo-wide `git diff HEAD`
    // for this card's project, descriptor-keyed so a re-run reuses (and
    // refreshes) the already-open card ([P20]). Session-scoped review lives
    // in the Changes shade, whose rows expand into their own diffs.
    diff: () => {
      const binding = cardSessionBindingStore.getBinding(cardId);
      if (binding === undefined) return;
      dispatchCommand(TUG_ACTIONS.OPEN_DIFF, {
        descriptor: { kind: "head", root: binding.projectDir },
      });
    },
    context: () => statusRowRef.current?.openContext(),
    // The two finally mean different things: `/tasks` is the numbered
    // checklist, `/bashes` (upstream: running shells + subagents) is
    // the background-work surface those rows live in here.
    tasks: () => statusRowRef.current?.openTasks(),
    bashes: () => statusRowRef.current?.openJobs(),
    skills: () => skillsSheet.openSkillsSheet(),
    agents: () => agentsSheet.openAgentsSheet(),
    memory: () => memorySheet.openMemorySheet(),
    hooks: () => hooksSheet.openHooksSheet(),
    usage: () => usageSheet.openUsageSheet(),
    // Copy the most recent assistant message (committed transcript only, read
    // live at click time per [L07]) to the clipboard, with a pane-scoped
    // confirmation bulletin. No message yet → caution; clipboard failure →
    // danger; both surface in this card, not the deck.
    copy: () => {
      const notify = paneBulletinRef.current;
      const text = lastAssistantCopyText(
        codeSessionStore.getSnapshot().transcript,
      );
      const writeText = navigator.clipboard?.writeText.bind(
        navigator.clipboard,
      );
      if (text === null || writeText === undefined) {
        notify?.caution("No message to copy yet");
        return;
      }
      void writeText(text).then(
        () => notify?.success("Most recent message copied"),
        () => notify?.danger("Copy failed"),
      );
    },
    help: () => helpSheet.openHelpSheet(),
    // Start a fresh session in this card ([#step-13b3]). Spawn a new session
    // (the spawn ack flips this card's binding → `cardServicesStore` swaps in
    // a fresh, empty store: the transcript resets without ever wiping it,
    // [L23]), then close the old subprocess. The card stays bound throughout
    // (old → new), so the project picker never flashes. The previous session
    // persists on disk and is resumable via `/resume` if it had committed
    // turns. No-op when the card isn't bound (nothing to clear). Reads the
    // binding live at click time ([L07]).
    clear: () => {
      const binding = cardSessionBindingStore.getBinding(cardId);
      const connection = getConnection();
      if (binding === undefined || connection === null) return;
      const newSessionId = crypto.randomUUID();
      // `/clear` is a plain `/new`: a fresh line, not the card's ([P03]). The
      // server births it and answers with `session_line_rebound`, which is what
      // re-seats the binding and starts the card's identity over.
      const lineId = provisionSpawnLine(newSessionId);
      sendSpawnSession(
        connection,
        cardId,
        newSessionId,
        binding.projectDir,
        "new",
        provisionSpawnTag(lineId),
        lineId,
      );
      sendCloseSessionKeepingBinding(connection, cardId, binding.tugSessionId);
    },
    // `/private` — toggle this session out of the Overview.
    // Deliberately a composer command and nothing else: no menu row, no chord.
    // The store write is optimistic so the atom's marker turns over with the
    // gesture; the `set_session_private_ok` / `_err` acks reconcile it either
    // way. The bulletin confirms the TRANSITION — the marker is the record of
    // the STATE, which is why both exist — and it waits for the ack, because a
    // refused write would otherwise leave the user holding a promise that the
    // Overview has stopped listening when it has not. The wait is a local socket
    // and one row's UPDATE. Reads the binding live at invoke time ([L07]).
    private: () => {
      const binding = cardSessionBindingStore.getBinding(cardId);
      const connection = getConnection();
      if (binding === undefined || connection === null) return;
      const next = !sessionPrivateStore.isPrivate(binding.tugSessionId);
      const notify = paneBulletinRef.current;
      sessionPrivateStore.setPrivate(binding.tugSessionId, next);
      sessionPrivateStore.awaitSettle(binding.tugSessionId, next, (settle) => {
        if (settle.ok) {
          notify?.success(
            next
              ? "This session is now private — nothing new reaches the Overview"
              : "This session is public again — the Overview resumes from here",
          );
          return;
        }
        notify?.danger(
          next
            ? "This session is still public — the Overview is still listening"
            : "This session is still private — the Overview is still skipping it",
          { description: privateRefusalDetail(settle.reason), sticky: true },
        );
      });
      const frame = encodeSetSessionPrivate(binding.tugSessionId, next);
      connection.send(frame.feedId, frame.payload);
    },
    // `/compact [focus]` — native compaction over the stream-json bridge
    // ([P01]). Dispatch the literal `/compact` (plus focus args) as a normal,
    // visible submission: Claude Code compacts in place under the SAME session
    // id and JSONL, streaming a `compact_boundary` (divider) and a summary
    // event (the carry-forward). A pane-modal, indeterminate "Compacting…"
    // sheet ([P07]) covers the card for the opaque run — minutes, not seconds,
    // on a full context (measured: 111 s and 159 s on two 140k/170k-token
    // compactions); Cancel maps to the turn interrupt.
    //
    // The run settles off `codeSessionStore` snapshots, no timers ([P07]): the
    // `/compact` turn opens, and when it settles we succeed if compaction ink
    // was observed since dispatch (the summary re-marked `compactionSeed`, or a
    // `source: "compact"` note attached to the turn), else cancel (interrupted)
    // or fail (refused / errored — e.g. "Not enough messages to compact").
    // Reads live ([L07]).
    compact: (args, draft) => {
      const notify = paneBulletinRef.current;
      const snap0 = codeSessionStore.getSnapshot();
      if (!snap0.canSubmit) {
        notify?.caution("Can't compact while a turn is in flight");
        return;
      }
      const focus = args.trim();
      beginCompactionRun();
      // Sent as a substrate, not a flat line: the command is a leading
      // `command` atom and the focus keeps whatever atoms the user typed, so
      // the transcript row reads `/compact` + its file chips — the same ink
      // a replay reconstructs from claude's `<command-name>` echo. The wire
      // still carries a clean `/compact …` (see `hasLeadingCommandAtom`).
      const submission = buildCommandSubmission("compact", focus, draft);
      codeSessionStore.send(submission.text, submission.atoms);
    },
    // Export the committed transcript ([#step-13c]). The content (both
    // Markdown + JSON Lines renderings) is built client-side from the
    // transcript we already hold; the host `NSSavePanel` owns format choice +
    // file write. Read live at click time ([L07]). Outcomes surface in this
    // card's pane bulletin; a cancel is silent.
    export: () => {
      const notify = paneBulletinRef.current;
      const transcript = codeSessionStore.getSnapshot().transcript;
      if (transcript.length === 0) {
        notify?.caution("Nothing to export yet");
        return;
      }
      if (!isExportAvailable()) {
        notify?.caution("Export needs the Tug app");
        return;
      }
      const sessionId =
        cardSessionBindingStore.getBinding(cardId)?.tugSessionId ?? null;
      void exportSession({
        baseName: exportBaseName(sessionId),
        markdown: transcriptToMarkdown(transcript),
        jsonl: transcriptToJsonl(transcript),
      }).then((result) => {
        if (result === "saved") notify?.success("Session exported");
        else if (result === "unavailable")
          notify?.caution("Export needs the Tug app");
        // "canceled" → no bulletin.
      });
    },
    // Add a working directory ([#step-13c]). The native directory picker
    // supplies the path; `addDirectory` sends an `add_directory` CODE_INPUT
    // frame and tugcode respawns claude with the dir in `--add-dir` (+
    // `--resume`) — claude has no live add-directory verb over the bridge, so
    // it applies on respawn like an effort change. No-op on cancel, or when the
    // picker is unavailable.
    "add-dir": () => {
      const notify = paneBulletinRef.current;
      if (!isPathPickerAvailable()) {
        notify?.caution("Directory picker needs the Tug app");
        return;
      }
      void pickPath("directory").then((dir) => {
        if (dir === null) return; // canceled
        codeSessionStore.addDirectory(dir);
        notify?.success("Working directory added");
      });
    },
    // `/rename <text>` names the session directly; bare `/rename` opens the
    // one-field dialog seeded with the current name ([#step-13d]). The
    // pane-bulletin confirmation belongs to the rename surface, which raises it
    // on the ack for both paths — naming a session is not done until the ledger
    // says it is.
    rename: (args) => {
      const name = args.trim();
      if (name.length === 0) {
        renameSheet.openRenameSheet();
        return;
      }
      renameSheet.renameTo(name);
    },
    // `/unname` — clears the session's name so the callsign comes back. The
    // clearing path already existed behind the dialog; a blank is what
    // `commitRename` reads as a clear, and it bulletins the outcome on the ack
    // like every other rename.
    unname: () => renameSheet.renameTo(""),
    // `/logout` — app-level. Hands off to the deck-root TugLogout orchestrator
    // (confirm → interrupt every turn → `claude_logout` → ConfigureTug reopens);
    // the same nonce the File-menu "Log out…" bumps, so there's one flow.
    logout: () => requestLogout(),
    // `/commit` — enters commit mode ([P03]/[P09]): the commit sheet rises
    // and the prompt entry becomes the message editor. A `/commit <message>`
    // seeds the composer with the args as an edited draft ([P05]); the `now`
    // keyword loses its meaning (args are just the message). Claude's built-in
    // `/commit` stays shadowed dead by this local match.
    commit: (args) => {
      const message = args.trim();
      commitModeController.enter(message.length > 0 ? message : undefined);
    },
    // `/arc-bind <name>` — work on an arc, making it if needed ([P06]).
    //
    // Two paths, each using the thing for what it is. An existing name is a
    // pure UI-concept write, so it goes over the `bind_arc` CONTROL verb:
    // silent, no transcript ink, and the `bind_arc_ok` broadcast is what
    // paints the chip and fronts the lane. A new name is a git mutation, so it
    // goes through the card's shell route, where the row is a durable receipt
    // saying what was made — and `arc create`'s own auto-bind does the
    // binding, rather than this handler duplicating it.
    //
    // The name is matched against this card's snapshot rather than sent for
    // the server to resolve, because `bind_arc` MINTS: a bind naming no arc
    // succeeds anyway and leaves the card wearing a chip for an arc that is
    // not there. The uncomposed guard is part of that same verb, not a
    // nicety — before the first aggregate emit every name misses the match,
    // and falling through to create would fire a git mutation on the strength
    // of a snapshot that has not answered yet.
    //
    // A mistyped name therefore creates an arc. That is `tugtool arc
    // create`'s semantics and this gesture inherits it on purpose:
    // `/arc-bind` means "work on this arc, making it if needed", so there is
    // no name it can refuse for being unfamiliar. The shell receipt is what
    // makes the outcome legible.
    //
    // Bare form picks ([P01]): several arcs open the picker sheet, exactly
    // one binds directly, none cautions. `/arc` no longer arrives here — the
    // bare name was surrendered to the `tugplug:arc` orchestrator skill, and
    // `/arc-bind` is the only spelling that reaches this handler.
    "arc-bind": (args) => {
      const notify = paneBulletinRef.current;
      // The `/diff` precedent: a surface that needs a binding returns silently
      // when the store has none.
      const binding = cardSessionBindingStore.getBinding(cardId);
      if (binding === undefined) return;
      const snap = changesController.getSnapshot();
      const name = args.trim();
      // The one place the frame is built. Every caller names an arc from the
      // snapshot, which matters because `bind_arc` MINTS — a frame built from
      // free text would create rather than refuse.
      const bindToArc = (arcName: string): void => {
        getConnection()?.sendControlFrame("bind_arc", {
          tug_session_id: binding.tugSessionId,
          project_dir: binding.projectDir,
          arc: arcName,
        });
      };

      // Above the bare-form branch, not below it: before the first aggregate
      // emit the arc list is empty for reasons that have nothing to do with
      // the project, and "no arcs in this project" would be a lie.
      if (!snap.composed) {
        notify?.caution("Still scanning this project — try again in a moment");
        return;
      }
      if (name.length === 0) {
        // Bare form picks. With several arcs, showing them all and offering
        // no way to choose is what the shade already did; with exactly one,
        // opening a sheet to confirm the only option is ceremony.
        if (snap.arcs.length === 0) {
          notify?.caution(
            "No arcs in this project — /arc-bind <name> starts one",
          );
          return;
        }
        if (snap.arcs.length === 1) {
          bindToArc(snap.arcs[0]!.display_name);
          return;
        }
        void cardPickerSheet.showSheet({
          title: "Work on an arc",
          icon: "GitBranch",
          iconRole: "agent",
          presentation: "rise",
          bottomAnchorSelector: MODAL_REST_LINE,
          content: (close) => (
            <ArcPickerSheet
              arcs={snap.arcs}
              boundArcId={binding.arc?.id ?? null}
              onPick={(entry) => bindToArc(entry.display_name)}
              onClose={close}
            />
          ),
        });
        return;
      }
      const known = snap.arcs.some((entry) => entry.display_name === name);
      if (known) {
        bindToArc(name);
        return;
      }
      if (!isShellSafeArcName(name)) {
        notify?.caution(ARC_NAME_CAUTION);
        return;
      }
      if (shellSessionStore.getSnapshot().inflight !== null) {
        notify?.caution("A shell command is already running");
        return;
      }
      shellSessionStore.exec(`tugtool arc create ${name}`);
    },
    // `/arc-review [path]` — review a plan, as an ordinary turn on whatever
    // model is selected right now. Nothing here changes the model, and nothing
    // schedules a turn on the user's behalf: the chip is the gesture, and the
    // moment before clicking it is the moment to switch models if they want to.
    //
    // Bare-form resolution is the only cleverness — explicit arg, else the plan
    // this card last reviewed, else the bound arc's recorded plan.
    "arc-review": (args) => {
      const notify = paneBulletinRef.current;
      if (!codeSessionStore.getSnapshot().canSubmit) {
        notify?.caution("Can't review a plan while a turn is in flight");
        return;
      }
      // The `/diff` precedent: a surface that needs a binding returns silently
      // when the store has none.
      const binding = cardSessionBindingStore.getBinding(cardId);
      if (binding === undefined) return;
      const boundName = binding.arc?.name;
      const entry =
        boundName === undefined
          ? undefined
          : changesController
              .getSnapshot()
              .arcs.find((row) => row.display_name === boundName);
      // An arc the card is bound to may still be branchless — its plan is on
      // the document-arc list rather than on a changeset entry.
      const boundPlan =
        entry?.documents?.plan ??
        (boundName === undefined
          ? undefined
          : changesController
              .getSnapshot()
              .documentArcs.find((row) => row.display_name === boundName)
              ?.documents.plan);
      const target = resolvePlanReviewTarget({
        args,
        projectDir: binding.projectDir,
        lastReviewed: readLastReviewedPlan(cardId),
        boundArc: boundPlan === undefined ? null : { plan: boundPlan },
      });
      if ("refused" in target) {
        notify?.caution("Name the plan — /arc-review <path>");
        return;
      }
      writeLastReviewedPlan(cardId, target.path);
      const submission = buildCommandSubmission(
        REVIEW_PLAN_COMMAND,
        target.path,
      );
      codeSessionStore.send(submission.text, submission.atoms);
    },
    // `/arc-join [name] [message…]` — the arc lane's landing gesture ([P04]).
    // It no longer submits a turn: the landing is the user's act and belongs in
    // front of the button, so this enters join mode and the card runs the git
    // itself.
    //
    // Bare = the bound arc; a name = that arc in this project; a name plus a
    // message seeds the join message as an edited draft, exactly as `/commit
    // <message>` does. There is no turn gate: entering a mode mid-turn is
    // harmless — only the *land* is gated ([P05]).
    "arc-join": (args) => {
      const notify = paneBulletinRef.current;
      const snap = changesController.getSnapshot();
      const rest = args.trim();
      const [first = "", ...tail] = rest.length === 0 ? [] : rest.split(/\s+/);
      const binding = cardSessionBindingStore.getBinding(cardId);

      // A leading word that names an arc is the target; otherwise the whole
      // argument is a message for the bound arc.
      const named = snap.arcs.find((entry) => entry.display_name === first);
      const entry =
        named ??
        (binding?.arc === undefined
          ? undefined
          : snap.arcs.find((row) => row.owner_id === binding.arc?.id));
      if (entry === undefined) {
        notify?.caution(
          first.length > 0
            ? `No arc named '${first}' in this project`
            : "No arc bound — /arc-join <name>",
        );
        return;
      }
      const seed = (named === undefined ? rest : tail.join(" ")).trim();
      joinModeController.enter(
        joinTargetFromEntry(entry),
        seed.length > 0 ? seed : undefined,
      );
    },
    // `/shell <command>` — the deliberate override under the shell
    // auto-router: the classifier decides by default, and a user who knows
    // better forces one exchange against the card's shell session (the row
    // threads into the transcript via `ingestShellExchange`). `exec` silently
    // drops a command while an exchange is in flight (the shell child is
    // serial), so surface that as a bulletin instead of losing the input.
    shell: (args) => {
      const notify = paneBulletinRef.current;
      const command = args.trim();
      if (command.length === 0) {
        notify?.caution("Usage: /shell <command>");
        return;
      }
      if (shellSessionStore.getSnapshot().inflight !== null) {
        notify?.caution("A shell command is already running");
        return;
      }
      shellSessionStore.exec(command);
    },
    // `/btw <question>` — ask a side question and open the non-modal placard.
    // Un-gated and pre-`canSubmit`, so it works idle AND mid-turn with no
    // `performSubmit` change. A bare `/btw` just opens the placard (history /
    // earlier asks) without asking — which is the ONLY way back to it, now that
    // the Z2 BTW cell is gone: the placard is where answers live, and `/btw` is
    // both how you ask and how you look.
    btw: (args) => {
      if (args.trim().length > 0) sideQuestionStore.ask(args);
      statusRowRef.current?.openSideQuestions();
    },
    // `/match` and `/search` run the refs feed and stream a numbered `#r`
    // block into the transcript ([P01] — local commands, not a route). Both
    // share one runner: the ops differ only in their flag table and which
    // body kind the block renders.
    match: (args) => runRefsCommand("match", args),
    search: (args) => runRefsCommand("search", args),
    // `/ref <spec>` opens refs from the latest run by number ([P09]). The
    // payload is byte-identical to the one a click on that row sends, so both
    // gestures reach the deck's open handler by the same route and honor the
    // same `openTarget` preference.
    ref: (args) => {
      const notify = paneBulletinRef.current;
      const spec = args.trim();
      if (spec === "") {
        notify?.caution("Usage: /ref 3 | 3-5 | 3 7 9");
        return;
      }
      const refs = refsSessionStore.currentRefs();
      if (refs.length === 0) {
        notify?.caution("No refs yet — run /match or /search first");
        return;
      }
      const byNumber = new Map(refs.map((r) => [r.index, r]));
      const resolved = resolveRefSpec(spec, (n) => byNumber.has(n));
      if (resolved.invalid.length > 0) {
        notify?.caution(`Not a ref number: ${resolved.invalid.join(" ")}`);
      }
      if (resolved.outOfRange.length > 0) {
        notify?.caution(
          `No ref ${resolved.outOfRange.join(", ")} — this run has ${refs.length}`,
        );
      }
      if (resolved.capped) {
        notify?.caution(`Opening the first ${REF_OPEN_CAP} refs`);
      }
      const root = refsSessionStore.root();
      const targets: Array<Record<string, unknown>> = [];
      for (const n of resolved.numbers) {
        const ref = byNumber.get(n);
        if (ref === undefined) continue;
        const target: Record<string, unknown> = {
          path: joinRefPath(root, ref.path),
        };
        if (ref.line !== null) target.line = ref.line;
        // A search ref knows which characters matched; the first span is the
        // one the row's own highlight leads with ([P10]).
        if (ref.columns.length > 0) target.columns = ref.columns[0];
        targets.push(target);
      }
      if (targets.length === 0) return;
      // One dispatch for the whole spec: each open re-seats the first
      // responder, so a per-ref dispatch would open the first and lose the
      // rest to a chain that has moved on.
      dispatchCommand(TUG_ACTIONS.OPEN_FILE, { targets });
    },
  };

  // What ⌘E searches for: the live selection anywhere inside this card —
  // transcript prose, a shell row, the composer — read through the shared
  // query-only selection adapter over the card's own root, so a selection in
  // some other card is not this card's to search for.
  const cardSelectionQuery = useCallback((): string => {
    const root = sessionCardRootRef.current;
    if (root === null) return "";
    return new HighlightSelectionAdapter(root).getSelectedText().trim();
  }, []);

  const {
    ResponderScope: CardContentResponderScope,
    responderRef: cardContentResponderRef,
  } = useResponder({
    id: `${cardId}-card-content`,
    kind: "card-content",
    actions: {
      [TUG_ACTIONS.FOCUS_PROMPT]: (_event: ActionEvent) => {
        entryDelegateRef.current?.focus();
      },
      // Open this card's Changes shade. Sent by a surface that shows this
      // card's arc — the Arcs card's Arcs row — after fronting the card.
      //
      // It has to live on THIS responder rather than on the bare `cardId`:
      // `sendToTarget` walks `parentId` upward from its target, the bare id
      // belongs to `card-host`, and this scope is beneath it. A dispatch that
      // finds no handler fails silently, so the target spelling is pinned by
      // an app-test rather than by inspection.
      [TUG_ACTIONS.REVEAL_CHANGES]: (_event: ActionEvent) => {
        revealChanges();
      },
      // ⌘F / Edit ▸ Find… — toggle the transcript find bar. Registering this
      // handler is also what ENABLES the menu item: `host-menu-state` derives
      // Edit ▸ Find…'s enablement from `chain.validateAction(FIND)`, so
      // without a handler AppKit eats the chord at the menu bar and it never
      // reaches the web view.
      //
      // The bar's OWN responder answers FIND while the caret is inside it (it
      // re-summons the query field), so this handler only ever sees a ⌘F from
      // outside the bar — which is exactly when "dismiss" is the right reading.
      [TUG_ACTIONS.FIND]: (_event: ActionEvent) => {
        toggleFindBar();
      },
      // ⌘E / Edit ▸ Use Selection for Find — the selection becomes the query
      // and the search runs. Unlike ⌘F this is not a toggle: an open bar is
      // re-seeded in place rather than dismissed, because the gesture names
      // what to search for, and "search for this" can never mean "stop
      // searching". A closed bar seeds through the same `lastFindQueryRef`
      // the remembered-query path uses, so the summoned bar arrives with the
      // text already selected whole and the first match already active.
      //
      // Registering the handler is the whole gate, exactly as it is for FIND:
      // the item is live wherever this card is, and an empty selection is a
      // no-op here rather than a dark menu item. Gating on the selection
      // would be a LIE the mirror cannot correct — a gate is computed when
      // the menuState is pushed, and dragging out a selection pushes nothing,
      // so the item would still read disabled and AppKit would eat ⌘E with a
      // beep. Edit ▸ Delete carries the same focus-granular answer for the
      // same reason.
      [TUG_ACTIONS.FIND_SELECTION]: (_event: ActionEvent) => {
        const query = cardSelectionQuery();
        if (query === "") return;
        if (findBarOpenRef.current) {
          findBarRef.current?.setQuery(query);
          return;
        }
        lastFindQueryRef.current = query;
        openFindBar();
      },
      // ⌥⇥ toggles keyboard-focus-cycling: the editor's Tab gives way to a
      // trapped tour of the card's chrome zones, seeded on the submit
      // commit-home; toggling again restores the editor caret ([P09]).
      [TUG_ACTIONS.CYCLE_FOCUS_MODE]: (_event: ActionEvent) => {
        cycle.toggle();
      },
      // ⌃⌘[ / ⌃⌘] — step the transcript one turn back / forward. The
      // card-content responder owns this because the transcript is the
      // card's content; routing the chord here (rather than a listener
      // on the transcript's scroll container) is what makes it work from
      // anywhere focus sits in the card, prompt editor included. The
      // step routes through `SessionTranscriptHandle.pageByEntry`, which
      // keeps the [D07] follow-bottom intent coherent.
      [TUG_ACTIONS.PREVIOUS_TURN]: (_event: ActionEvent) => {
        transcriptRef.current?.pageByEntry("up");
      },
      [TUG_ACTIONS.NEXT_TURN]: (_event: ActionEvent) => {
        transcriptRef.current?.pageByEntry("down");
      },
      // ⌃⇧⌘[ / ⌃⇧⌘] — jump the transcript to the very top / bottom.
      [TUG_ACTIONS.FIRST_TURN]: (_event: ActionEvent) => {
        transcriptRef.current?.scrollToTop();
      },
      [TUG_ACTIONS.LAST_TURN]: (_event: ActionEvent) => {
        transcriptRef.current?.scrollToBottom();
      },
      // ⌃⌘P — select the Prompt route directly. Unlike ⌃⌘C's toggle this
      // names the route it wants, so pressing it while already on Prompt is
      // a no-op rather than a flip into Changes. Applied through
      // `CommitModeController`, which is where the selection lives, so the
      // Z4A group follows without being told.
      [TUG_ACTIONS.SELECT_COMPOSER_ROUTE]: (event: ActionEvent) => {
        if (event.value === "changes") {
          enterChanges();
        } else if (event.value === "prompt") {
          commitModeController.exit();
          joinModeController.exit();
        }
      },
      // ⌃⌥⌘P cycles the permission mode. Only the session card registers this
      // handler, so on any other card ⇧⇥ falls through to reverse-tab
      // navigation (Risk R02). `cycle` reads the current mode fresh from
      // the metadata store [L07].
      [TUG_ACTIONS.CYCLE_PERMISSION_MODE]: (_event: ActionEvent) => {
        if (!guardTurnIdleForSetting("the permission mode")) return;
        permissionMode.cycle();
      },
      // Session ▸ Stop. Always means interrupt — the menu deliberately
      // bypasses Escape's dismiss-priority walk (popover > drag >
      // interrupt); the menu item's `canInterrupt` enablement is the
      // only gate, and a stray dispatch while idle is a no-op.
      [TUG_ACTIONS.INTERRUPT_SESSION]: (_event: ActionEvent) => {
        codeSessionStore.interrupt();
      },
      // A typed local slash command, dispatched key-card-scoped by the prompt
      // entry. Open the matching surface. An unknown name is a no-op (the
      // matcher only dispatches registered names, so this is defensive
      // against registry/handler drift) ([D23]).
      [TUG_ACTIONS.RUN_SLASH_COMMAND]: (event: ActionEvent) => {
        const payload = event.value as
          | {
              name: LocalCommandName;
              args: string;
              // Present only on a typed dispatch (the prompt entry attaches
              // the composer's substrate); absent on a menu dispatch.
              draft?: SlashCommandDraft;
            }
          | undefined;
        if (payload === undefined) return;
        type Surface = (args: string, draft?: SlashCommandDraft) => void;
        const open = (slashCommandSurfaces as Partial<Record<string, Surface>>)[
          payload.name
        ];
        if (open !== undefined) open(payload.args, payload.draft);
      },
      // Seed the corresponding command chip at the head of the prompt
      // draft, preserving typed text as args ([P07]). No chord dispatches
      // this today — the command is named in the registry with no door.
      [TUG_ACTIONS.INSERT_SLASH_COMMAND]: (event: ActionEvent) => {
        const payload = event.value as { name: string } | undefined;
        if (payload === undefined) return;
        entryDelegateRef.current?.insertCommandChip(payload.name);
      },
      // ⌘/ ([P06]): focus the editor and open the command completion popup.
      [TUG_ACTIONS.OPEN_COMMAND_PICKER]: (_event: ActionEvent) => {
        entryDelegateRef.current?.openCommandPicker();
      },
      // ⌘I / Session ▸ Insert File… — the host picked the path, this is the
      // insertion. The composer answers this action itself when it holds the
      // caret; registering it here too is what makes the command reachable
      // from anywhere in the card, since the composer is a SIBLING of the
      // transcript rather than its ancestor — a first responder in the
      // transcript walks past the composer entirely, and a command the card
      // can plainly perform must not dim because focus is one seat over. The
      // delegate focuses the editor before inserting, so the path always
      // lands where the user will type next.
      [TUG_ACTIONS.INSERT_FILE]: (event: ActionEvent) => {
        const path = (event.value as { path?: unknown } | undefined)?.path;
        if (typeof path !== "string" || path === "") return;
        entryDelegateRef.current?.insertFilePath(path);
      },
      // Swift Session-menu "Show/Hide Changes" and the ⌃⌘C deck twin — toggle
      // the Changes shade. Showing Changes is the landing the card is mated to,
      // whether or not there are changes and whether or not a prompt is typed:
      // the composer's in-progress draft is stashed on entry and restored on
      // exit (see `tug-prompt-entry`), so nothing is clobbered. Visible: exit
      // whichever landing is up (drop the sheet). Hidden: enter (raise it).
      //
      // Exiting must test both controllers. Testing only commit mode left a
      // arc-bound card's ⌃⌘C hiding the shade out from under a live join.
      [TUG_ACTIONS.TOGGLE_CHANGES_VIEW]: (_event: ActionEvent) => {
        const sheetVisible = shadeViewController.getSnapshot() === "changes";
        if (!sheetVisible) {
          enterChanges();
          return;
        }
        if (commitModeController.getSnapshot().active) {
          commitModeController.exit();
        } else if (joinModeController.getSnapshot().active) {
          joinModeController.exit();
        } else {
          shadeViewController.hide();
        }
      },
      // Swift Session-menu "Show/Hide History" and the ⌃⌘H deck twin.
      // History and commit mode are mutually exclusive ([P03]): exit the
      // mode before toggling History.
      [TUG_ACTIONS.TOGGLE_HISTORY_VIEW]: (_event: ActionEvent) => {
        commitModeController.exit();
        shadeViewController.toggle("history");
      },
      // The Fold control at Z2's trailing edge, Session ▸ Fold Session, and
      // ⌥⌘M all land here ([P02]): the card is where the gesture knows which
      // card it is about, and the deck commit is dispatched from one place so
      // the three doors cannot drift apart.
      //
      // Folding closes the surfaces that stand on a transcript there is
      // about to be none of ([P03]) — the find bar, and whichever landing or
      // shade is up. Exiting a landing rather than only hiding the shade is
      // the `TOGGLE_CHANGES_VIEW` handler's own ladder, and a landing draft
      // survives it because `CommitModeController.leave()` persists one.
      // Showing runs none of them: what was closed on the way down was closed
      // deliberately, and re-opening it would be the card guessing.
      [TUG_ACTIONS.TOGGLE_SESSION_FOLD]: (_event: ActionEvent) => {
        const deckStore = getDeckStore();
        if (deckStore === null) return;
        const folded = cardFoldedOf(deckStore.getSnapshot(), cardId);
        if (!folded) {
          if (findBarOpenRef.current) closeFindBar();
          if (commitModeController.getSnapshot().active) {
            commitModeController.exit();
          } else if (joinModeController.getSnapshot().active) {
            joinModeController.exit();
          } else {
            shadeViewController.hide();
          }
        }
        dispatchCommand(TUG_ACTIONS.SET_CARD_FOLDED, {
          cardId,
          folded: !folded,
        });
      },
      // ⌃⌘A / ⌃⇧⌘A — the Changes shade's bulk verbs as chords. The composer
      // registers them (it is the surface holding focus under the passive
      // shade) and the card handles them, because the card is what holds
      // `changesController`; the chain walks composer → card.
      //
      // Claim All takes the unattributed AND orphaned buckets together — one
      // keyboard verb for "make everything claimable in front of me mine".
      // The shade's two buttons remain the granular path.
      [TUG_ACTIONS.CLAIM_ALL_CHANGES]: (_event: ActionEvent) => {
        const verbs = getChangesetVerbStore();
        if (verbs?.claimState(changesController.entryKey).phase === "pending")
          return;
        const snap = changesController.getSnapshot();
        const paths = [...snap.unattributed, ...snap.orphaned].map(
          (f) => f.path,
        );
        if (paths.length === 0) return;
        changesController.claim(paths);
      },
      [TUG_ACTIONS.DISCLAIM_ALL_CHANGES]: (_event: ActionEvent) => {
        const verbs = getChangesetVerbStore();
        if (
          verbs?.disclaimState(changesController.entryKey).phase === "pending"
        )
          return;
        const paths = (changesController.getSnapshot().entry?.files ?? []).map(
          (f) => f.path,
        );
        if (paths.length === 0) return;
        changesController.disclaim(paths);
      },
      // A typed `/command` the session card will not run, dispatched by the prompt
      // entry ([#step-13a]). `unknown` = a typo (not in claude's catalog);
      // `unsupported` = a real Claude Code command we hide (no meaning over the
      // bridge). Present a pane-modal alert with reason-appropriate text rather
      // than burning a turn (unknown) or silently dropping it (unsupported).
      [TUG_ACTIONS.SHOW_SLASH_COMMAND_NOTICE]: (event: ActionEvent) => {
        const payload = event.value as
          { name: string; reason: "unknown" | "unsupported" } | undefined;
        if (payload === undefined) return;
        const { title, message } =
          payload.reason === "unsupported"
            ? {
                title: "Command Not Available",
                message: `The /${payload.name} command is not available in the session card. Type / to see the available commands.`,
              }
            : {
                title: "Unknown Command",
                message: `There is no /${payload.name} command in this project. Type / to see the available commands.`,
              };
        void presentAlertSheet(cardPickerSheet.showSheet, {
          title,
          // The `.tug-alert-icon` box owns the glyph size (tugx-header.css).
          icon: <AlertTriangle aria-hidden="true" />,
          message,
        });
      },
    },
  });

  // --- Status row + tools panel content. ---
  // The status badge shows the card's bound `projectDir` — the cwd that
  // Claude is running against. Subscribed via L02 so a rebind (when
  // picker → spawn_session completes) repaints without an extra prop
  // handoff. Fallback to null is defensive: `SessionCardBody` only renders
  // when services are non-null, which implies a binding, but during the
  // narrow window between binding clear and services teardown we render
  // nothing rather than a stale path.
  const projectDir = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(
      () => cardSessionBindingStore.getBinding(cardId)?.projectDir ?? null,
      [cardId],
    ),
  );
  const boundSessionId = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(
      () => cardSessionBindingStore.getBinding(cardId)?.tugSessionId ?? null,
      [cardId],
    ),
  );
  // Whether this card is bound to an arc — what puts the Join segment in the
  // composer's route group ([P03]). Read as the arc's id rather than the
  // binding object so an unrelated binding write is not a re-render.
  const boundArcId = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(
      () => cardSessionBindingStore.getBinding(cardId)?.arc?.id ?? null,
      [cardId],
    ),
  );
  // The arc lane's landing face. What a landing would do comes off the arc's
  // own feed entry, so the card hands the shade only the gestures; the view
  // supplies the round trip and the turn gate from its own reads. None of these
  // lands — landing is the composer's, and the composer is where a refusal can
  // be shown to the hand that made it.
  const arcJoinActions = useMemo<ArcJoinActions>(
    () => ({
      aim: (entry) => joinModeController.aim(joinTargetFromEntry(entry)),
      // The escalation's answer ([P06]). Addressed by `request_id` rather than
      // by arc, because the resolve that raised it may already have expired
      // and a later one may be asking something else — an answer must never
      // resolve a question it was not written for.
      answerQuestion: (entry, requestId, answer) =>
        getChangesetJoinStore()?.answerQuestion(
          changesController.workspaceKey,
          entry.display_name,
          requestId,
          answer,
        ),
      // Clear the base-side work refusing this arc's join. It clears the
      // block and stops — landing stays the ⬆ — which is why the control it
      // rides reads `Resolve` rather than `Resolve and join`.
      resolveBase: (entry) =>
        getChangesetJoinStore()?.resolveBase(
          changesController.workspaceKey,
          entry.display_name,
        ),
      // And its reversal, which rides beside the fold's own receipt. The
      // receipt is durable and the undo is the one act that retires it early,
      // so the gesture belongs wherever the receipt is read.
      undoResolveBase: (entry) =>
        getChangesetJoinStore()?.undoResolveBase(
          changesController.workspaceKey,
          entry.display_name,
        ),
      // Discard is deliberately absent here. It reaches past the fronted row —
      // any arc no live session holds is releasable from this shade — so it
      // rides the lane's own release bundle, which the view builds, rather than
      // the landing face's actions, which the fronted row alone receives.
    }),
    [changesController, joinModeController],
  );
  const arcJoin = useMemo<ArcJoinSource>(
    () => ({
      // Which arc the landing is ABOUT, which is not always the one this card
      // is bound to: `/arc-join <name>` aims at an arc by name without
      // binding. The face has to follow the target, or a named join comes up
      // live in the composer and unmounted in the room that explains it.
      //
      // Gated on `active`, and that gate is load-bearing: `aim()` sets the same
      // target when a row is merely EXPANDED. Fronting on an aim would move the
      // lane under the reader for an arc they did not ask to land.
      arcId: joinSnapshot.active ? (joinSnapshot.arc?.ownerId ?? null) : null,
      actions: arcJoinActions,
    }),
    [joinSnapshot.active, joinSnapshot.arc, arcJoinActions],
  );
  // A question put to the developer by a process outside the turn stream, with
  // that process blocked on the answer. The snapshot's `pendingAsk` reference
  // is stable while one is up, so this is not a per-token re-render
  // source ([L02]).
  const pendingAsk = useSyncExternalStore(
    codeSessionStore.subscribe,
    useCallback(
      () => codeSessionStore.getSnapshot().pendingAsk,
      [codeSessionStore],
    ),
  );
  const handleAskRespond = useCallback(
    (choice: string) => {
      if (pendingAsk === null) return;
      const answered = pendingAskStore.respond(pendingAsk.requestId, choice);
      // A question the store no longer tracks was already answered on its way
      // out (a reap during a transient services miss), leaving only the parked
      // dialog behind. It still has to come down — a press that visibly does
      // nothing is a refused gesture with no reason, and the session would
      // read Awaiting forever.
      if (!answered) codeSessionStore.setPendingAsk(null);
    },
    [pendingAsk, codeSessionStore],
  );

  // The bound session's identity, through the one hook every identity surface
  // uses ([L02]).
  const sessionIdentity = useSessionIdentity(
    boundSessionId,
    projectDir !== null ? { projectDir } : undefined,
  );
  const sessionLine =
    sessionIdentity !== null && projectDir !== null
      ? sessionIdentityLine(sessionIdentity)
      : null;

  // Publish the session's identity to the pane chrome's title bar via
  // `cardTitleStore` — the Line tier, `<project>/<callsign>`. Cleared on
  // unmount or when the binding goes away so the title bar falls back to the
  // registry default.
  //
  // The branch is gone from this string, and so is the name: what a session is
  // CALLED is its callsign, which is immutable, so this string is constant for
  // the life of the binding and `set` no-ops after the first call. Nothing may
  // be built on a re-`set` firing — identity changes reach surfaces through
  // `useSessionIdentity`, which is the only notification path.
  //
  // The masthead sidecar rides beside the string: it asks the pane for the
  // taller chrome tier and names the session it is about. A KEY, not a
  // snapshot — the masthead resolves what to display from the identity stores
  // itself, so nothing about the name travels this channel.
  useEffect(() => {
    cardTitleStore.set(
      cardId,
      sessionLine ?? "Session",
      boundSessionId !== null
        ? { kind: "session-masthead", sessionId: boundSessionId }
        : undefined,
    );
    return () => {
      cardTitleStore.clear(cardId);
    };
  }, [cardId, sessionLine, boundSessionId]);

  const projectChipText =
    projectDir !== null ? formatPathChipText(projectDir) : null;
  // Right-click → Copy the full project path (not the ellipsized chip face).
  const projectCopy = useCopyableButton(`Project: ${projectDir ?? ""}`);
  const projectStatusContent =
    projectDir !== null ? (
      <>
        {/* A plain TugTooltip, not a TugActionTooltip: revealing the folder is
          `openPathInOS`, not a registry command, so there is no chord to read
          and nothing for an action tooltip to add. The chip face is
          ellipsized, so the hover is where the full path lives. */}
        <TugTooltip content={`Reveal in Finder: ${projectDir}`}>
          <TugPushButton
            ref={projectCopy.ref as React.Ref<HTMLButtonElement>}
            onContextMenu={projectCopy.onContextMenu}
            size="sm"
            emphasis="tinted"
            role="action"
            layout="label-top"
            label="Project"
            data-slot="project-chip"
            focusGroup={SESSION_CYCLE_GROUP}
            focusOrder={SESSION_CYCLE_ORDER_PROJECT}
            aria-label="Reveal project folder in Finder"
            onClick={() => openPathInOS(projectDir, "folder")}
          >
            {projectChipText}
          </TugPushButton>
        </TugTooltip>
        {projectCopy.contextMenu}
      </>
    ) : null;

  // Z2 — the session status row. An explicit `statusBarContent` prop
  // (tests / gallery) wins; otherwise the card renders the row itself.
  const effectiveStatusBarContent = statusBarContent ?? (
    <SessionTelemetryStatusRow
      ref={statusRowRef}
      codeSessionStore={codeSessionStore}
      sessionMetadataStore={sessionMetadataStore}
      onScrollToRow={handleScrollToRow}
      // Author the Z2 status cells into the card's cycle as five leaf stops
      // ([P10] revised) starting at SESSION_CYCLE_ORDER_STATUS_BASE; the status-bar
      // region is wrapped in a second `cycle.CycleScope` (below) sharing this
      // card's mode id.
      //
      // An open shade takes them back out. A shade rises from the entry region's
      // top edge and covers everything above it, Z2 included — and the Changes
      // shade is passive, so the walk is NOT trapped into it the way History's
      // is. Left registered, the five cells stayed in the cycle while sitting
      // behind the shade: five Tab stops in a row that paint their ring on a
      // covered element and so look like nothing at all. A stop you cannot see
      // is a ghost, and the cure is not to paint it but to not stop there.
      // Passing an undefined group is how `SessionTelemetryStatusRow` leaves the
      // walk entirely.
      focusGroup={shadeView === "none" ? SESSION_CYCLE_GROUP : undefined}
      focusOrderBase={SESSION_CYCLE_ORDER_STATUS_BASE}
      // The `/btw` placard's body (there is no BTW cell; `/btw` opens it).
      sideQuestionStore={sideQuestionStore}
      // Staged-context queue: the `/btw` overlay's Add-to-context action.
      pendingContextStore={pendingContextStore}
    />
  );

  // Compose two ref consumers onto the card's root DOM node:
  //   - `cardContentResponderRef` registers this element as the
  //     card-content responder for chain dispatch.
  //   - `sessionCardRootRef` captures the same element for the
  //     first-mount fade-in `useLayoutEffect` declared above.
  // Stable across renders (`useCallback`): an inline lambda gets a new
  // identity every render, and React answers a changed ref identity with a
  // detach/attach cycle in every commit — per-render DOM attribute churn.
  const sessionCardRootComposedRef = useCallback(
    (el: HTMLDivElement | null) => {
      sessionCardRootRef.current = el;
      (cardContentResponderRef as (node: Element | null) => void)(el);
    },
    [cardContentResponderRef],
  );

  return (
    <CardContentResponderScope>
      <div
        ref={sessionCardRootComposedRef}
        className="session-card"
        data-slot="session-card"
        data-testid="session-card"
        // Provenance for every copy taken out of this card — transcript prose,
        // a block's Copy, the composer's own selection. The paths in a session
        // are spelled against the project it is bound to, and this is where
        // that root is knowable; a destination that keeps the text keeps the
        // root with it. Unbound cards stamp nothing ([lib/clipboard-origin]).
        {...clipboardOriginProps(projectDir)}
        // Keyboard-focus-cycling signal ([P12]). Set while the card's
        // cycle mode is on; the fill-suppression CSS keys on this ancestor
        // so the submit's standing fill stands down to outlined and the
        // promoted fill follows the focused stop instead. Engine-derived
        // ([L02]); appearance via the attribute, never React state ([L06]).
        // `"true"` while cycling; `"false"` while resting on the editor (the
        // focus-ring suppression that hides the card's resting cycle-stop rings).
        // While an inline dialog is pending the card is **card-modal** ([P16]) —
        // neither cycling nor resting-on-editor — so the attribute is REMOVED,
        // which lifts the `[data-cycling="false"]` suppression off the trapped
        // dialog's own rings (its Allow ring must show on open, not after a Tab).
        data-cycling={
          cycle.cycling ? "true" : inlineDialogPending ? undefined : "false"
        }
        // Card-modal scrim signal ([P19]). Set while an inline dialog
        // (permission / question) is pending; the scrim CSS keys on this
        // ancestor to dim the card content around the dialog so the modality is
        // felt. Engine-derived from the store ([L02]); appearance via the
        // attribute, never React state ([L06]).
        data-inline-dialog-pending={inlineDialogPending ? "true" : undefined}
        // Open-shade signal ([P17]) — the shade's NAME, not a bare boolean,
        // because the two shades differ on the one question the attribute is
        // read for: who owns Return.
        //
        // History carries its own Done, which holds the card's persistent
        // default ring, and the shade's modal carve-out deliberately leaves the
        // prompt entry live beneath its bottom edge — so a click into the
        // composer puts `data-entry-keyboard` back on the entry shell and lights
        // a SECOND default beside Done. The stand-down CSS in
        // `tug-prompt-entry.css` keys on `="history"` for exactly that.
        //
        // Changes carries no Done at all: its act is the commit, and the button
        // that performs it is the composer's own Z5. Standing the composer's
        // default down there took the ring away and gave it to nobody, which is
        // why the Changes Z5 wore no ring ([#chord-ring]). Appearance via the
        // attribute, never React state ([L06]).
        data-shade-open={shadeView === "none" ? undefined : shadeView}
      >
        {/*
          Card body is a plain flex column ([L06]/[L13] — no JS sizing).
          The transcript region (this `session-card-top-column`: header +
          multi-turn transcript + Z2 status bar) flexes into all remaining
          height (floored at `--session-transcript-min`); the prompt-entry region
          below is content-sized and grows with the editor (auto-height,
          capped at `--session-entry-max-height` so the Z4/Z5 toolbar stays
          pinned). This replaces the old `TugSplitPane` +
          `useContentDrivenPanelSize` machine wholesale.

          `SessionTranscriptHost` mounts a `TugListView` over a
          `SessionTranscriptDataSource` mapping `codeSessionStore.transcript`
          (committed turns) + `inflightUserMessage` onto `(user, code)`
          rows; the streaming `code` cell observes
          `codeSessionStore.streamingDocument` directly ([D06]/[L22]). The
          column is always rendered so the transcript's mount identity
          stays stable across slot-content changes ([L26]).
        */}
        <div
          className="session-card-top-column"
          data-slot="session-card-top-column"
        >
          {/*
              Two pane-bulletin scopes share the top column as sibling Sonner
              toasters (distinct `useId` ids). The OUTER provider anchors
              top-right and carries transient interruption notices (retry,
              transport, replay-timeout, unknown-event) driven by
              `TransientNoticeController`; the INNER provider anchors bottom for
              command confirmations (`/copy`). Nesting — not two roots — keeps
              each consumer reading the right `PaneToasterIdContext`: the
              controller sees the outer (top-right), `PaneBulletinAnchor` sees
              the inner (bottom). [P02]

              Nothing landing-shaped reaches either lane. A commit or join
              refusal speaks at the seam between the shade and the composer
              instead ([P03]) — inside the gesture, and outside the shade's
              scrim, which is what dimmed this lane's copy of it.
            */}
          <TugPaneBulletinProvider
            placement="top-right"
            className="session-card-notice-host"
          >
            <TransientNoticeController store={codeSessionStore} />
            <DiscardErrorNoticeController
              entryKey={changesController.entryKey}
            />
            <ClaimErrorNoticeController entryKey={changesController.entryKey} />
            <DraftErrorNoticeController changesController={changesController} />
            {boundSessionId !== null ? (
              <ArcBindErrorNoticeController tugSessionId={boundSessionId} />
            ) : null}
            {boundSessionId !== null ? (
              <ArcReplayNoticeController tugSessionId={boundSessionId} />
            ) : null}
            {boundSessionId !== null ? (
              <ArcPressNoticeController tugSessionId={boundSessionId} />
            ) : null}
            <TugPaneBulletinProvider
              placement="bottom"
              className="session-card-bulletin-host"
            >
              <div
                className="session-card-header-content"
                data-slot="session-card-header-content"
              >
                {headerContent}
              </div>
              {/*
              Route-driven view slot ([P01]/[P02]). The transcript pane is
              ALWAYS visible and its mount identity stays stable ([L26]);
              the History view rides the TugSheet `shade` presentation
              ([P17]) descending over it from the top — modal over the
              transcript region only, while the prompt entry stays live
              beneath the shade's bottom edge. The find overlay, Z2 status
              bar, and beat strip stay OUTSIDE the slot — Find is a
              target-route over the transcript. The Changes shade's wrapper
              is a sibling of all three, at the end of the top column: it
              rises from the top of the prompt entry, over them.
            */}
              <div
                className="session-view-slot"
                ref={viewSlotRef}
                data-active-view={activeView}
                // Folded away with the card ([P03]). The CSS takes it off the
                // screen; `inert` is what takes it out of the FOCUS walk and
                // the accessibility tree, and it is the same flag rather than
                // a second opinion on it. Never unmounted ([L26]) — the
                // transcript's list view keeps its scroll and its identity.
                //
                // `inert` is written by the fold effect rather than declared
                // here, because it belongs to the END of the fold ([B06]) —
                // see the terminal-state effect above. React never sets the
                // attribute on this element, so nothing here fights it.
              >
                <div className="session-view-pane" data-view="transcript">
                  <SessionTranscriptHost
                    ref={transcriptRef}
                    cardId={cardId}
                    codeSessionStore={codeSessionStore}
                    shellSessionStore={shellSessionStore}
                    refsSessionStore={refsSessionStore}
                    pendingContextStore={pendingContextStore}
                    sessionMetadataStore={sessionMetadataStore}
                    transcriptStore={transcriptStore}
                    findSession={findSession}
                    renderTurnTrailing={renderTurnTrailing}
                    // The landing arc narrates at the live edge, beneath every
                    // row and above the composer — ink in motion, never
                    // ledgered. Built inline rather than memoized for the same
                    // reason the dialogs below are: caching the element would
                    // freeze the component reference against Fast Refresh.
                    liveEdgeContent={
                      <SessionLandingProgressRow
                        joinModeController={joinModeController}
                      />
                    }
                  />
                  {/*
                  A question raised from outside the turn stream (`/api/ask`),
                  with a command-line tool blocked on the answer.

                  Mounted here at session level rather than inside a turn cell
                  like `PermissionDialog`, because an ask belongs to no turn:
                  one usually arrives while the session sits idle, and the
                  transcript's `isLastAssistant && !isCommitted` gating would
                  render nothing at all in that case — leaving the caller to
                  block until its own timeout with no dialog on screen.

                  Built inline every render (no `useMemo` over the element) so
                  Fast Refresh can swap the component; caching it would freeze
                  the `Component` reference, the same constraint
                  `session-card-transcript.tsx` documents for the dialogs it
                  owns.
                */}
                  {pendingAsk !== null ? (
                    <AppTestAskDialog
                      ask={pendingAsk}
                      onRespond={handleAskRespond}
                    />
                  ) : null}
                </div>
                <div className="session-view-pane" data-view="history">
                  <TugSheet
                    ref={historySheetRef}
                    onOpenChange={handleHistorySheetOpenChange}
                  >
                    {/* History is content-sized ([P17] `shadeAutoSize`): it pages
                      the log in as the reader scrolls, so a fixed fraction
                      would cap a list that always has more to show. `fit-
                      content` under a full-slot cap gives the one rule that
                      fits: only a COMPLETE history short enough to fit sizes
                      the shade small and leaves the transcript showing —
                      anything longer fills the transcript and scrolls inside.
                      The grabber goes with it (autosize never shows one): the
                      content owns the height, so there is nothing to drag. */}
                    {/* And it rests on the card's modal rest line
                      (`shadeAnchor="bottom"`, MODAL_REST_LINE): its wrapper
                      already fills `.session-view-slot`, so the anchor
                      resolves with no measurement, and the shade rises from
                      the top of Z2 — or of the find bar while the bar is
                      open — toward the masthead, the direction the card's
                      own content moves. */}
                    <TugSheetContent
                      title="History"
                      presentation="shade"
                      shadeAnchor="bottom"
                      persistKey="session-card"
                      shadeAutoSize
                      modalScopeSelector='.session-view-pane[data-view="transcript"]'
                    >
                      <SessionHistoryView
                        projectDir={projectDir}
                        active={activeView === "history"}
                        onClose={() => shadeViewController.hide()}
                      />
                    </TugSheetContent>
                  </TugSheet>
                </div>
              </div>
              <PaneBulletinAnchor ref={paneBulletinRef} />
            </TugPaneBulletinProvider>
          </TugPaneBulletinProvider>
          {/*
              The find bar ([P06]/[P07]): a flow sibling between the view slot
              and Z2, outside `.session-view-slot` — so History coexists with
              it rather than displacing it, and rises from ITS top edge while
              it is open. (Find and Changes are mutually exclusive routes, so
              the Changes shade's wider cover never lands on an open bar.)
              The transcript pane is a flex column with the list at
              `flex 1 1 auto`, so the bar takes its height from the list
              exactly as Z2 telemetry growth does. It mounts the find-wrap
              overlay, which is why the card has none of its own: a search is
              live only while the bar is open ([P13]).
            */}
          {findBarOpen ? (
            // Under the SAME CycleScope the prompt entry uses, so the bar's
            // four stops register into this card's one focus cycle rather
            // than a walk of their own ([P10]) — the card has one Tab order
            // and the bar takes its seat in it, between the Z4 toolbar and
            // the Z2 cells.
            <cycle.CycleScope>
              <TugFindBar
                ref={findBarRef}
                session={findSession}
                onClose={closeFindBar}
                cardRootRef={sessionCardRootRef}
                placeholder="Find in transcript"
                dataSlot="session-card-find-bar"
                inputTestId="session-card-find-input"
                initialQuery={lastFindQueryRef.current}
                focusGroup={SESSION_CYCLE_GROUP}
                focusOrderBase={SESSION_CYCLE_ORDER_FIND_BASE}
              />
            </cycle.CycleScope>
          ) : null}
          <div
            className="session-card-status-bar"
            data-slot="session-card-status-bar"
          >
            {/*
                Z2 status content. Rendered only when Z2 has content: an
                empty slot leaves the wrapper `:empty`, which collapses the
                whole strip (CSS).

                The `/btw` surface is one of the Z2 status row's placards, so
                there is no separate pinned strip — the row owns the placard and
                its open/close. It has no cell of its own: `/btw` is how you
                ask, and the placard pops from the strip's trailing edge.
              */}
            {effectiveStatusBarContent != null && (
              <div
                className="session-card-status-bar-main"
                // Z2 status content is chrome: clicking a status cell, its
                // popover trigger, or an empty gap must not pull focus off
                // the editor. Ancestor-matched `data-tug-focus="refuse"`
                // covers the cells + gaps. Keeping first-responder on the
                // editor also lets a status popover restore editor focus on
                // Escape / Cmd-. via the service-popup binding.
                data-tug-focus="refuse"
              >
                {/*
                    Second cycle scope, sharing this card's mode id, so
                    each Z2 status cell's `useFocusable` registers into
                    the same cycle as the prompt-entry stops ([P10]
                    revised — the cells are leaf stops at orders 5…9).
                    The row is rendered in the transcript pane — outside
                    the prompt entry's own `CycleScope` — so it needs its
                    own here.
                  */}
                <cycle.CycleScope>{effectiveStatusBarContent}</cycle.CycleScope>
              </div>
            )}
            {/* The card's one fold control ([B03]–[B06]), at the trailing
                edge of the row in BOTH forms — a sibling of the status
                content rather than a child of it, because `-main` refuses
                focus for its cells and gaps and a door must not ([F07]).

                Under a `CycleScope` of its own for the same reason the status
                content above takes one: the strip sits outside the prompt
                entry's subtree, and a stop that is not in the cycle's mode is
                not a member of the walk — folded, ⌥⇥ would seed the first
                Z2 cell and Tab would never reach the one door the form has
                ([P08]). */}
            <cycle.CycleScope>
              <SessionFoldControl
                folded={folded}
                focusGroup={SESSION_CYCLE_GROUP}
                focusOrder={SESSION_CYCLE_ORDER_FOLD}
              />
            </cycle.CycleScope>
          </div>
          {/*
              Changes glance ([P03] revised): a bottom-anchored PASSIVE shade
              that rises from the TOP OF THE PROMPT ENTRY over the whole
              transcript region — find bar and Z2 status row included. ⌃⌘C
              toggles it; on an empty composer it also enters
              commit mode so the prompt entry becomes the message editor.
              `shadePassive` keeps focus in the composer below; `shadeAnchor=
              "bottom"` + auto-size gives the rise-from-the-composer geometry.
              Landing lives in the composer's Z5; the shade's own dismissal is
              the X at the trailing edge of its header.

              Mounted as the top column's own overlay wrapper rather than a
              pane inside `.session-view-slot` (where History still lives):
              the wrapper's bottom edge IS the shade's bottom edge, and the
              column ends exactly where the entry region begins. Purely a
              positioning move — no measurement, no JS geometry ([L06]).
            */}
          <div className="session-view-pane" data-view="changes">
            <TugSheet
              ref={changesSheetRef}
              onOpenChange={handleChangesSheetOpenChange}
            >
              <TugSheetContent
                title="Changes"
                presentation="shade"
                persistKey="session-card"
                shadeAutoSize
                shadeAnchor="bottom"
                shadePassive
                grabberLabel="Resize the Changes view"
                modalScopeSelector='.session-view-pane[data-view="transcript"]'
              >
                <SessionChangesView
                  cardId={cardId}
                  projectDir={projectDir}
                  changesController={changesController}
                  codeSessionStore={codeSessionStore}
                  // A landing in flight supplies its own target, so an
                  // aimed-but-unbound arc still gets its face.
                  arcJoin={
                    boundArcId !== null ||
                    (joinSnapshot.active && joinSnapshot.arc !== null)
                      ? arcJoin
                      : undefined
                  }
                  dismiss={changesDismiss}
                />
              </TugSheetContent>
            </TugSheet>
          </div>
        </div>
        {/*
          Prompt-entry region — content-sized and pinned to the card bottom.
          The text area grows with the editor up to `--session-entry-max-height`
          then scrolls; the transcript above yields.
        */}
        <div
          className="session-card-entry-region"
          ref={entryRegionRef}
          data-slot="session-card-entry-region"
          // The other folded region ([P03]). The composer keeps an unsent
          // draft, its caret, and its route across a fold because it is
          // hidden rather than unmounted ([B05]); `inert` is what keeps a Tab
          // out of it while it is not on screen — written by the fold effect
          // at the motion's end, not declared here ([B06]).
          //
          // This is the fold's transitioning element: its `grid-template-rows`
          // is the one property that animates, and its `transitionend` is what
          // tells the effect the fold has landed.
        >
          <TugBox
            variant="plain"
            inset={false}
            disabled={sessionErrored}
            className="session-card-entry-pane"
          >
            {/* A landing's refusal, in the seam between the shade's bottom
                edge and the composer's top edge — inside the gesture it
                belongs to, and outside the shade's scrim by geometry ([B01],
                [P03]). One per landing mode, each self-hiding unless its own
                mode is active, so at most one is ever up. `handleAfterSubmit`
                is the same reader-return Z5 gets, because Retry and Z5 are one
                act ([P04]). */}
            <SessionLandingNoticeStrip
              controller={commitModeController}
              onAfterRetry={handleAfterSubmit}
            />
            <SessionLandingNoticeStrip
              controller={joinModeController}
              onAfterRetry={handleAfterSubmit}
            />
            {/* Composer-side reminder of staged shell / `/btw` context that
                will ride the next `❯` submission. Self-hides when empty. */}
            <SessionPendingContextStrip
              pendingContextStore={pendingContextStore}
            />
            {/*
              CycleScope keys the prompt entry's authored focus stops
              into this card's cycle mode (not the base mode), so the
              submit registers as a cycle stop that is inert while typing
              and walked only while cycling ([P09]/[P10]). The editor
              itself is a responder (caret), not a focus-group stop, so
              it is untouched. Z2 / Z4A stops join in later slices via
              additional `CycleScope`s sharing this same mode id.
            */}
            <cycle.CycleScope>
              <TugPromptEntry
                ref={entryDelegateRef}
                id={`${cardId}-entry`}
                // Code is the only resting mode ([P01]). Draft generation now
                // lives in the Changes shade's composer ([P02]/[P15]) — the
                // entry carries no changeset plumbing.
                // The editor stands down (read-only + caret off + dimmed)
                // only while an inline dialog owns the keyboard ([P06]) —
                // which must NOT inert the subtree (the dialog needs the
                // card alive around it). NOT during cycling: the editor is a
                // live stop of the cycle that grants the caret when the walk
                // lands on it, and a deactivated stop is a disabled one,
                // which the walk skips — standing it down while cycling
                // removes the composer from traversal entirely.
                deactivated={inlineDialogPending}
                // A resume replay disables the WHOLE entry — route toggle,
                // chips, and submit included — via the inert subtree: nothing
                // here can act on a session that is still reconstructing. It
                // reactivates when the window closes (the stood-down effect
                // re-focuses the editor).
                disabled={replayHoldActive}
                submitFocusGroup={SESSION_CYCLE_GROUP}
                submitFocusOrder={SESSION_CYCLE_ORDER_SUBMIT}
                commitFocusOrderBase={SESSION_CYCLE_ORDER_COMMIT_BASE}
                routeFocusGroup={SESSION_CYCLE_GROUP}
                routeFocusOrder={SESSION_CYCLE_ORDER_ROUTE}
                editorFocusGroup={SESSION_CYCLE_GROUP}
                editorFocusOrder={SESSION_CYCLE_ORDER_EDITOR}
                attachmentFocusGroup={SESSION_CYCLE_GROUP}
                attachmentFocusOrderBase={SESSION_CYCLE_ORDER_ATTACHMENT_BASE}
                onAttachmentCountChange={setAttachmentCount}
                localCommandTargetId={`${cardId}-card-content`}
                codeSessionStore={codeSessionStore}
                shellSessionStore={shellSessionStore}
                pathCommandsStore={pathCommandsStore}
                shellGrammarStore={shellGrammarStore}
                shellClassifyStore={shellClassifyStore}
                findSession={findSession}
                // A join that has been pressed keeps the slot until something
                // else claims it ([P03]): landing exits the mode, so handing the
                // composer straight back to commit mode would take the join's
                // own account of itself down on the beat it was pressed. Commit
                // mode going active supersedes it — that is a person asking this
                // composer for something else.
                landingMode={
                  joinActive || (joinSnapshot.narrating && !commitModeActive)
                    ? joinModeController
                    : commitModeController
                }
                // What the Changes room lands for this card: an arc in reach —
                // bound, or aimed at by name through `/arc-join` — means a join.
                // The aimed case matters because that command enters join mode
                // without binding.
                changesLandingKind={
                  boundArcId !== null ||
                  (joinSnapshot.active && joinSnapshot.arc !== null)
                    ? "join"
                    : "commit"
                }
                // Derived on every render from two live reads, and remembered
                // nowhere: a join stands for this card's arc, and the room it
                // stands in is closed. When the join lands the arc leaves the
                // feed and the offer goes with it, so the dot cannot outlive
                // what it points at.
                changesHasOffer={joinOffer !== null && shadeView === "none"}
                onEnterChanges={enterChanges}
                // A rejected drop / paste (unsupported, oversize, or
                // undecodable image) is transient input validation, not a
                // session fault. Surface it as a calm, dismissible bulletin
                // above the entry — never the red session-lost banner, and
                // never `lastError` (which would light the entry's errored
                // ring). A stable id coalesces repeat rejections into one
                // notice instead of stacking.
                onAttachmentError={(message) =>
                  paneBulletinRef.current?.caution(message, {
                    id: "attachment-error",
                    sticky: true,
                  })
                }
                sessionMetadataStore={sessionMetadataStore}
                historyStore={historyStore}
                completionProviders={completionProviders}
                argumentHintResolver={argumentHintResolver}
                argumentHintRefresh={sessionMetadataStore}
                pastedCommandResolver={pastedCommandResolver}
                inlineCommandMatcher={inlineCommandMatcher}
                onAfterSubmit={handleAfterSubmit}
                onDoubleEscapeWhenEmpty={() => rewindSheet.openRewindSheet()}
                onEmptyChange={setComposerEmpty}
                indicatorsContent={
                  commitModeActive ? (
                    // Commit cluster ([P03], Table T01): the Claude-session
                    // chips (identity / mode / model / effort) describe sending
                    // a prompt and unmount for the mode; what remains is what a
                    // commit is about — WHERE it lands (Project) and WHAT it
                    // lands (Changes). The Changes chip's click toggles the
                    // changes sheet without leaving the mode.
                    <>
                      {projectStatusContent}
                      <TugActionTooltip
                        action={TUG_ACTIONS.TOGGLE_CHANGES_VIEW}
                        content={
                          commitFileCount === 0 && commitClaimableCount > 0
                            ? "Nothing attributed to this session yet — open Changes to claim these files into the commit"
                            : "Show or hide the changes sheet"
                        }
                      >
                        <TugPushButton
                          size="sm"
                          emphasis="tinted"
                          role="action"
                          layout="label-top"
                          label="Changes"
                          data-slot="changes-chip"
                          focusGroup={SESSION_CYCLE_GROUP}
                          focusOrder={SESSION_CYCLE_ORDER_CHANGES}
                          aria-label={
                            commitFileCount === 0 && commitClaimableCount > 0
                              ? `Claim ${commitClaimableCount} unclaimed ${
                                  commitClaimableCount === 1 ? "file" : "files"
                                } to commit — open the changes sheet`
                              : "Show or hide the changes sheet"
                          }
                          onClick={() => {
                            if (
                              shadeViewController.getSnapshot() === "changes"
                            ) {
                              shadeViewController.hide();
                            } else {
                              shadeViewController.show("changes");
                            }
                          }}
                        >
                          {commitFileCount === 0 && commitClaimableCount > 0
                            ? `claim ${commitClaimableCount}`
                            : commitFileCount === 1
                              ? "1 file"
                              : `${commitFileCount} files`}
                        </TugPushButton>
                      </TugActionTooltip>
                    </>
                  ) : (
                    // Static Code chip set ([P01]/[P10]): the Claude Code identity
                    // chip, then one AI settings chip carrying model · effort ·
                    // mode. The find cluster is not here — it lives in the find
                    // bar, which owns the search for exactly as long as it is open.
                    //
                    // The Session and Project chips are deliberately absent on THIS
                    // route. Both names already read in the pane title bar (the
                    // identity's Line tier), so on the strip they were a
                    // second copy — and they were the two most expensive variable
                    // faces on the one route that has a width problem. The shell and
                    // commit clusters keep theirs: those routes are not
                    // space-challenged, and Project means something different in a
                    // commit (where it lands) than as an identity label.
                    <>
                      <SessionRouteIndicatorBadge
                        codeSessionStore={codeSessionStore}
                        sessionMetadataStore={sessionMetadataStore}
                        focusGroup={SESSION_CYCLE_GROUP}
                        focusOrder={SESSION_CYCLE_ORDER_CLAUDE_CODE}
                      />
                      {/* Disabled while a turn is in flight so a model/effort/mode
                      change never races the running turn — the chip mirrors the
                      submit button, live exactly when `canSubmit`. */}
                      <AiChip
                        cardId={cardId}
                        sessionMetadataStore={sessionMetadataStore}
                        onOpenSheet={aiConfigSheet.openAiConfigSheet}
                        disabled={!codeSnap.canSubmit}
                        focusGroup={SESSION_CYCLE_GROUP}
                        focusOrder={SESSION_CYCLE_ORDER_AI}
                      />
                      {footerContent}
                    </>
                  )
                }
                lineWrap={editorSettings.lineWrap}
                lineNumbers={editorSettings.lineNumbers}
                softTabs={editorSettings.softTabs}
                tabSize={editorSettings.tabSize}
                highlightActiveLineGutter={
                  editorSettings.highlightActiveLineGutter
                }
                returnAction={editorSettings.returnKeyAction}
                numpadEnterAction={editorSettings.numpadEnterAction}
                // The other half of the History stand-down above ([P17]/[P14]).
                // The same state that takes the composer's default ring away and
                // gives it to the shade's Done has to take the KEY too: the
                // carve-out leaves the composer live under the shade, so a
                // Return there was writing a newline while the only ring on
                // screen promised dismissal. One state, one owner, both halves.
                defaultButtonOwnsReturn={shadeView === "history"}
                placeholder={
                  joinOffer !== null
                    ? SESSION_READY_PROMPT_PLACEHOLDER
                    : SESSION_PROMPT_PLACEHOLDER
                }
              />
            </cycle.CycleScope>
          </TugBox>
          {cardPickerSheet.renderSheet()}
        </div>
        {/*
        Single TugPaneBanner driven by `deriveSessionCardBannerSpec`.
        The precedence chain (error > transport > none) is enforced
        in the helper; this JSX maps the spec's discriminated kind
        to TugPaneBanner props. Mutual exclusion by construction —
        no two visible flags racing on the portal slot.

        The error variant carries the Dismiss footer + detail
        copy ("The card can't reach its session…"). Status variants
        are strip-only with copy keyed off the transport state.
        When `kind === "none"` the banner renders with `visible:
        false`; the component runs its exit animation and then
        unmounts via its internal `mounted` state.
      */}
        {renderSessionCardBanner(bannerSpec, setDismissedAt)}
      </div>
    </CardContentResponderScope>
  );
}
