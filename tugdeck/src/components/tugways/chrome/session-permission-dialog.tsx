/**
 * `PermissionDialog` — inline chrome for a tool-permission request.
 *
 * Renders a `control_request_forward` event with `is_question: false`
 * (Claude is asking the user to allow or deny a tool call) as an
 * *inline* block in the transcript flow — never a modal overlay. The
 * dialog is *pending-only*: once the user clicks Allow / Deny the
 * reducer clears `pendingApproval`, `isPending` flips to `false`, and
 * this component returns `null`. There is no post-decision recorded
 * chrome — JSONL has no durable record to reconstruct one from on
 * cold boot, so the tool block that follows is the only post-decision
 * artifact (output on allow; `is_error` band + SDK rejection text on
 * deny). See `#step-3-5` in `arc/archive/dev-interactive-dialogs.md`.
 *
 * The single rendered state composes the `TugInlineDialog`
 * header-bar primitive with `iconRole="caution"` and a per-tool rich
 * description. `Deny` and `Allow` (`TugPushButton size="xs"`) flow
 * into the primitive's trailing `actions` slot; this dialog owns the
 * focus-on-mount on `Allow`. The body picker (`DiffBlock` for Edit;
 * the real transcript tool block — `BashToolBlock` for Bash,
 * `DefaultToolBlock` for an unknown tool, `NullToolBlock` for a hidden
 * one — mounted in `preview` mode for everything else) renders in the
 * primitive's `children` slot. When the request carries actionable
 * `permission_suggestions`, those (plus an implicit "Allow once"
 * first option) are passed to the primitive's `options` prop as a
 * mandatory-single-select radio group; the user picks the *scope*,
 * then commits with Allow. Deny is the off-ramp — clicking it
 * ignores the chosen scope and denies the request outright.
 *
 * `Deny` is a *positive decision* (`respondApproval({decision:
 * "deny"})`), not a walk-away. It paints as outlined-danger
 * (`role="danger"`) to communicate the destructive intent of denying
 * a tool call. Esc keeps reaching `popInteractive` via the responder
 * chain; that walk-away cancels the running turn rather than denying
 * the permission.
 *
 * Per-tool description (`PermissionDescription`):
 *
 *   - `Bash` →  `"This command requires approval."` (the command renders
 *     below through `BashToolBlock`'s header — see the body picker)
 *   - `Edit` / `MultiEdit` →  `"This will edit `{file_path}`."`
 *   - `Read` →  `"This will read `{file_path}` ({line range})."`  (range when set)
 *   - `Write` →  `"This will write `{file_path}`."`
 *   - default →  `"This will run `{tool_name}`."`
 *
 * The wire `decision_reason`, when present, is appended as a second
 * sentence in the same description ReactNode. The cohesive sentence
 * belongs in the description; do not fragment the same idea into
 * separate slots.
 *
 * Body picker (`PendingBody`) — three branches:
 *
 *   - `edit` → `DiffBlock` (`two-text` source from `(old_string,
 *     new_string)`).
 *   - `dispatch` → the real transcript tool block for this tool, via
 *     `dispatchToolCallState(..., preview: true)`. This is the general
 *     mechanism — `Bash`, every bespoke tool, an unknown tool (→
 *     `DefaultToolBlock`), and a hidden tool (→ `NullToolBlock`) all
 *     route here. The wrapper renders only its input/command side in
 *     preview mode; the dialog preview and the transcript row share one
 *     rendering by construction. A `session-permission-dialog-preview`
 *     wrapper caps the height so an unbounded input scrolls instead of
 *     stretching the dialog.
 *   - `path` → `null`. The file path is already in the description.
 *
 * Laws:
 *  - [L02] external state (is this request still pending?) enters
 *    React via `useSyncExternalStore` over the `CodeSessionStore`.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    this docstring.
 *  - [L20] component-token sovereignty — the visual is delegated to
 *    `TugInlineDialog` (`--tugx-idialog-*`) and the tool block the
 *    preview mounts. This dialog itself contributes only the small
 *    reason fragment used inside the pending description and the
 *    height-capped preview wrapper.
 *  - [L23] the user's chosen scope is user data and must survive
 *    reload / cross-pane move / cold boot. The dialog opts into the
 *    [A9] Component State Preservation Protocol via
 *    {@link useSavedComponentState} + {@link useComponentStatePreservation},
 *    keyed by `permission-dialog/<request_id>` so the SAME request
 *    rehydrates the in-progress pick but a NEW request mounts fresh.
 *    {@link seedPermissionDialogSelectedOption} is the pure
 *    seed-merger consumed inside the `useState` initializer; the
 *    capture closure round-trips through it.
 *
 * Decisions:
 *  - [D13] three-layer survival contract: wire (tugcode in-flight
 *    snapshot re-emits the `control_request_forward`), reducer
 *    (`handleControlRequestForward` rehydrate branch restores it to
 *    `pendingApproval`), and this component's per-instance [A9]
 *    opt-in restores the chosen scope the user had selected before
 *    the boundary fired.
 *
 * @module components/tugways/chrome/session-permission-dialog
 */

import "./session-permission-dialog.css";

import React from "react";
import { ShieldAlert } from "lucide-react";

import { DiffBlock } from "@/components/tugways/body-kinds/diff-block";
import { dispatchToolCallState } from "@/components/tugways/cards/session-assistant-renderer-dispatch";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import type { TugInlineDialogOption } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugRadioGroup, TugRadioItem } from "@/components/tugways/tug-radio-group";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import { useSpatialOrder } from "@/components/tugways/use-spatial-order";
import type { SpatialOrder } from "@/components/tugways/spatial-order";
import { useInlineDialogScope } from "@/components/tugways/use-inline-dialog-scope";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "@/components/tugways/use-component-state-preservation";
import type {
  CodeSessionStore,
  ControlRequestForward,
} from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * The `permission` `RenderInput` shape, restated locally. The dispatch
 * owns the `RenderInput` union; restating the one variant this
 * component consumes keeps the import graph one-directional (the
 * dispatch imports this component for `KIND_RENDERERS.permission`, so
 * this component must not import the dispatch).
 */
export interface PermissionRenderInput {
  kind: "permission";
  request: ControlRequestForward;
}

/**
 * Context the dispatch threads through. Structurally a subset of the
 * dispatch's `DispatchContext` — only `session` is needed (the
 * permission round-trip goes through `respondApproval`).
 */
export interface PermissionDialogContext {
  session: CodeSessionStore;
}

export interface PermissionDialogProps {
  input: PermissionRenderInput;
  context: PermissionDialogContext;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the pure-logic test suite.
// ---------------------------------------------------------------------------

/** Which read-only body kind best fits a tool's permission `input`. */
export type PermissionBodyKind = "edit" | "path" | "dispatch";

/**
 * Pick the body kind for a permission request's `tool_use.input`:
 *
 *   - `Edit` / `MultiEdit`→ `"edit"`  (`(old,new)` via `DiffBlock` in children)
 *   - `Read` / `Write`    → `"path"`  (path surfaced inline in description)
 *   - everything else      → `"dispatch"` (the real transcript wrapper,
 *                            mounted in `preview` mode — input/command side
 *                            only, no result surfaces)
 *
 * The `"dispatch"` branch is the general mechanism: rather than a
 * bespoke per-tool dialog UI, the dialog reuses the same tool block
 * renderer the transcript uses (`dispatchToolCallState`). `Bash` routes
 * here too — its command renders through `BashToolBlock`'s header, the
 * same chrome the transcript shows — as do every bespoke tool, an
 * unknown tool (→ `DefaultToolBlock`, input JSON tree collapsed), and a
 * hidden tool (→ `NullToolBlock`, no body). The dialog preview and the
 * transcript row share one rendering by construction.
 *
 * `Edit` and `Read` / `Write` stay on dedicated dialog branches: the
 * raw `DiffBlock` reads better than `EditToolBlock`'s chrome in dialog
 * context, and the file path already lives in the description (no body
 * needed for `"path"`). Case-insensitive.
 */
export function selectPermissionBodyKind(toolName: string): PermissionBodyKind {
  switch (toolName.toLowerCase()) {
    case "edit":
    case "multiedit":
      return "edit";
    case "read":
    case "write":
      return "path";
    default:
      return "dispatch";
  }
}

/**
 * The structured SDK `PermissionUpdate` carried by an actionable
 * suggestion (the rules-bearing variant). Restated locally — the wire
 * delivers `permission_suggestions` as opaque `unknown[]`, and on
 * Allow the dialog round-trips the user's chosen entry straight back
 * as `updatedPermissions` so the CLI records a durable rule at its
 * `destination`. We never construct one; we only narrow + echo, so the
 * shape stays minimal (extra wire fields ride along untouched).
 */
export interface PermissionUpdate {
  type: string;
  destination: string;
  behavior?: "allow" | "deny";
  rules?: Array<{ toolName: string; ruleContent?: string }>;
}

/**
 * An actionable `permission_suggestion` narrowed to what the dialog
 * needs: a wire `behavior` the `tool_approval` round-trip can honor
 * (`allow` / `deny`), a human-readable button label, and — when the
 * suggestion is a structured durable-scope update — the raw
 * {@link PermissionUpdate} to echo back on Allow. `update` is absent
 * for a degenerate suggestion that names no scope (it then behaves
 * like "Allow once" — no rule added).
 */
export interface PermissionSuggestionAction {
  behavior: "allow" | "deny";
  label: string;
  update?: PermissionUpdate;
}

/**
 * Compose the human-readable suggestion label from the wire's
 * `behavior` + `destination` pair. Pure; exported so the test suite
 * can pin every (behavior × destination) cell.
 *
 * The dialog's *description* already names the specific tool +
 * command being asked about (e.g. "Bash · `tokei`"); the suggestion
 * button only needs to communicate the *scope* of the rule that gets
 * added — repeating the rule content here ("Allow Bash tokei (this
 * project)") read as clumsy and pushed the button width past the
 * dialog. Per the Step 18.5 design feedback we drop the wire's
 * `rules` content from the label and key off (behavior, destination)
 * alone:
 *
 *  - `allow` + `session`        → "Allow for this session"
 *  - `allow` + `project`/`localSettings`/`projectSettings`
 *                               → "Allow for this project"
 *  - `allow` + `userSettings`   → "Always allow"
 *  - `allow` + (no destination) → "Allow this action"
 *  - mirror for `deny`.
 *  - unknown destination        → `"{Verb} ({destination})"`
 *    (graceful passthrough so a forward-compat scope still reads).
 */
export function composePermissionSuggestionLabel(
  behavior: "allow" | "deny",
  destination: string | undefined,
): string {
  const verb = behavior === "allow" ? "Allow" : "Deny";
  if (destination === undefined) return `${verb} this action`;
  switch (destination) {
    case "session":
      return `${verb} for this session`;
    case "project":
    case "localSettings":
    case "projectSettings":
      return `${verb} for this project`;
    case "userSettings":
      return behavior === "allow" ? "Always allow" : "Always deny";
    default:
      return `${verb} (${destination})`;
  }
}

/**
 * Narrow one raw `permission_suggestions[]` entry. Returns `null` when
 * the entry carries no actionable `behavior` (`allow` / `deny`) — those
 * are the only behaviors the `tool_approval` wire shape can express, so
 * a non-actionable suggestion (e.g. `ask`) is dropped rather than
 * rendered as a dead button.
 *
 * The wire shape (from the v2.1.x catalog) is
 * `{ behavior, destination, rules: [{ ruleContent, toolName }], type }`.
 * The narrowed label is composed from `behavior` + `destination` only
 * (see {@link composePermissionSuggestionLabel}); the wire's `rules`
 * content is dropped from the visible *label* since the dialog's
 * description already carries it. The structured entry itself is
 * retained as `update` (when it carries a `type` + `destination`) so
 * the Allow round-trip can echo it back as `updatedPermissions`; a
 * suggestion without those fields yields no `update` and reads as a
 * one-shot allow.
 */
export function narrowPermissionSuggestion(
  value: unknown,
): PermissionSuggestionAction | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const behavior = v.behavior;
  if (behavior !== "allow" && behavior !== "deny") return null;
  const destination =
    typeof v.destination === "string" ? v.destination : undefined;
  // Retain the raw object as the round-trip `update` only when it is a
  // structured scope update (string `type` + a `destination`). It is
  // echoed verbatim — it came from the SDK, so it is valid by
  // construction; we never reshape it.
  const update =
    typeof v.type === "string" && destination !== undefined
      ? (v as unknown as PermissionUpdate)
      : undefined;
  return {
    behavior,
    label: composePermissionSuggestionLabel(behavior, destination),
    ...(update !== undefined ? { update } : {}),
  };
}

/**
 * Stable identifier reserved for the implicit "Allow once" option that
 * heads every options list when at least one allow-scoped suggestion
 * exists. Exported so the dialog and its tests share the constant
 * verbatim — never drifting between caller and asserter.
 */
export const ALLOW_ONCE_OPTION_VALUE = "allow-once";

/** Visible label for the implicit "Allow once" option. */
export const ALLOW_ONCE_OPTION_LABEL = "Allow once";

/**
 * Description for the implicit "Allow once" option. Anchors the
 * default semantic so the user understands what happens when they
 * commit Allow without picking a more durable scope.
 */
export const ALLOW_ONCE_OPTION_DESCRIPTION =
  "Allow this single invocation. No rule is added.";

/**
 * The stable option `value` for an allow-scoped suggestion, derived
 * from its label. Shared by {@link buildPermissionOptions} (which
 * stamps it onto the radio option) and the dialog's Allow handler
 * (which maps the selected value back to the suggestion's `update`),
 * so the two never drift. Pure; exported for the test suite.
 */
export function permissionScopeOptionValue(label: string): string {
  return `allow:${label}`;
}

/**
 * Build the options array fed to `TugInlineDialog`'s `options` prop
 * from the narrowed allow-scoped suggestions. The implicit "Allow
 * once" option is prepended whenever at least one allow-scoped
 * suggestion exists, so the user always has the no-rule default
 * available alongside the persistent scopes Claude proposed.
 *
 * Returns an empty array when no allow-scoped suggestions are
 * present — the dialog then renders without an options block (Allow
 * defaults to the one-shot scope).
 *
 * Deny-scoped suggestions are intentionally not surfaced as scope
 * options — Deny in this dialog is always a single button that
 * skips the entire scope-picking flow. A future enhancement could
 * model deny-scope as a separate group; today it would conflate
 * "scope of allow" with "scope of deny" inside one radio group.
 *
 * Pure; exported for the test suite.
 */
export function buildPermissionOptions(
  suggestions: ReadonlyArray<PermissionSuggestionAction>,
): TugInlineDialogOption[] {
  const allowSuggestions = suggestions.filter((s) => s.behavior === "allow");
  if (allowSuggestions.length === 0) return [];
  const out: TugInlineDialogOption[] = [
    {
      value: ALLOW_ONCE_OPTION_VALUE,
      label: ALLOW_ONCE_OPTION_LABEL,
      description: ALLOW_ONCE_OPTION_DESCRIPTION,
    },
  ];
  for (const suggestion of allowSuggestions) {
    out.push({
      value: permissionScopeOptionValue(suggestion.label),
      label: suggestion.label,
    });
  }
  return out;
}

/**
 * Recognise wire `decision_reason` strings that merely restate what
 * the dialog already says — "This command requires approval" /
 * "Approval required" / similar boilerplate — so the
 * description doesn't end up doubling the same sentence twice.
 *
 * The wire occasionally fills `decision_reason` with this kind of
 * generic copy when the underlying gating logic has nothing more
 * specific to add (typically Bash). When the reason carries
 * substantive context — "Path is outside allowed working
 * directories", "File is outside the workspace root" — it is kept
 * intact.
 *
 * Match is case-insensitive, trims surrounding whitespace, and
 * tolerates trailing `.` / `!` / `?`. Pure; exported for tests.
 */
export function isBoilerplateApprovalReason(reason: string): boolean {
  const stripped = reason.trim().toLowerCase().replace(/[.!?]+$/, "");
  switch (stripped) {
    case "":
    case "this command requires approval":
    case "this tool requires approval":
    case "this action requires approval":
    case "approval required":
    case "requires approval":
    case "permission requested":
    case "permission required":
      return true;
    default:
      return false;
  }
}

/**
 * Compose the optional line-range badge for a `Read` permission
 * request whose input carried `offset` / `limit`. Mirrors
 * `ReadToolBlock`'s `composeLineRangeBadge` semantics. Returns
 * `undefined` when no window was requested.
 */
export function composePermissionLineRange(
  input: unknown,
): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const v = input as Record<string, unknown>;
  const offset = typeof v.offset === "number" ? v.offset : undefined;
  const limit = typeof v.limit === "number" ? v.limit : undefined;
  if (offset === undefined && limit === undefined) return undefined;
  if (offset !== undefined && limit !== undefined) {
    return `lines ${offset}–${offset + limit - 1}`;
  }
  if (offset !== undefined) return `from line ${offset}`;
  if (limit !== undefined) return `first ${limit} lines`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Preserved state — the [A9] capture payload
// ---------------------------------------------------------------------------

/**
 * The serialized payload the dialog captures into `bag.components`.
 * Mirrors the one piece of local state — the chosen scope option —
 * so a user mid-pick survives HMR / Maker > Reload / cross-pane
 * move. Mirrors {@link QuestionDialogPreservedState}'s shape so both
 * dialogs in the family use the same protocol the same way.
 */
export interface PermissionDialogPreservedState {
  selectedOption: string;
}

/** Stable preservation-key prefix for the dialog's per-request slot.
 *  Joined with the request id to form the scoped key
 *  `permission-dialog/<request_id>` — namespace-distinct from
 *  `question-dialog/<request_id>` and from any other component
 *  opting into [A9] inside the same card. */
export const PERMISSION_DIALOG_PRESERVATION_KEY_PREFIX = "permission-dialog/";

/**
 * Compose the scoped preservation key for one permission-dialog
 * instance. Pure; exported for the test suite.
 */
export function permissionDialogPreservationKey(requestId: string): string {
  return `${PERMISSION_DIALOG_PRESERVATION_KEY_PREFIX}${requestId}`;
}

/** Type guard for the saved-state envelope read from the bag. JSON
 *  storage means we can't trust the shape blindly; a mismatch falls
 *  through to the default seed. */
function isPreservedPermissionState(
  value: unknown,
): value is PermissionDialogPreservedState {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.selectedOption === "string";
}

/**
 * Merge a possibly-saved state envelope with the default seed to
 * produce the initial `selectedOption`. Defensive against a malformed
 * payload (returns the default) and against a saved option no longer
 * present in the current `allowOptions` list (also returns the
 * default — the saved key is meaningless without a matching option).
 *
 * `allowOptions` may be empty (no scoped suggestions); in that case
 * the default is `ALLOW_ONCE_OPTION_VALUE` which the dialog falls
 * back to when no options block renders.
 *
 * Pure; exported for the test suite.
 */
export function seedPermissionDialogSelectedOption(
  saved: unknown,
  allowOptions: ReadonlyArray<TugInlineDialogOption>,
): string {
  const defaultValue = allowOptions[0]?.value ?? ALLOW_ONCE_OPTION_VALUE;
  if (!isPreservedPermissionState(saved)) return defaultValue;
  // Only accept the saved value when the current options list still
  // contains it. A stale value (option list shape changed) falls
  // through to the default rather than silently selecting nothing.
  const present = allowOptions.some((o) => o.value === saved.selectedOption);
  if (!present && saved.selectedOption !== ALLOW_ONCE_OPTION_VALUE) {
    return defaultValue;
  }
  return saved.selectedOption;
}

// ---------------------------------------------------------------------------
// Internal narrowings
// ---------------------------------------------------------------------------

function readStringField(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Description composer
// ---------------------------------------------------------------------------

interface DescriptionProps {
  toolName: string;
  input: unknown;
  decisionReason?: string;
}

/**
 * Compose the rich-description ReactNode for the pending dialog. Per
 * [D13] / step-18-5 design feedback the description is one cohesive
 * sentence (or sentence-pair) that pulls together the prose, the tool
 * kind, and the relevant input fragment — never three loose lines.
 */
const PermissionDescription: React.FC<DescriptionProps> = ({
  toolName,
  input,
  decisionReason,
}) => {
  const lower = toolName.toLowerCase();
  let primary: React.ReactNode;
  if (lower === "bash") {
    // The command itself renders below through `BashToolBlock`'s header
    // (the same terminal-icon + "Bash" + command chrome the transcript
    // shows). The description keeps only the cohesive lead-in — no tool
    // identity chip, since the block carries it.
    primary = <>This command requires approval.</>;
  } else if (lower === "edit" || lower === "multiedit") {
    const filePath = readStringField(input, "file_path");
    primary =
      filePath !== undefined ? (
        <>
          This will edit <code>{filePath}</code>.
        </>
      ) : (
        <>This will edit a file.</>
      );
  } else if (lower === "read" || lower === "write") {
    const filePath = readStringField(input, "file_path");
    const verb = lower === "write" ? "write" : "read";
    const lineRange = composePermissionLineRange(input);
    primary =
      filePath !== undefined ? (
        <>
          This will {verb} <code>{filePath}</code>
          {lineRange !== undefined ? ` (${lineRange})` : ""}.
        </>
      ) : (
        <>This will {verb} a file.</>
      );
  } else {
    primary = (
      <>
        This will run <code>{toolName}</code>.
      </>
    );
  }
  if (decisionReason !== undefined && decisionReason !== "") {
    return (
      <>
        {primary}{" "}
        <span className="session-permission-dialog-reason">{decisionReason}</span>
      </>
    );
  }
  return <>{primary}</>;
};

// ---------------------------------------------------------------------------
// Body picker (children slot)
// ---------------------------------------------------------------------------

interface PendingBodyProps {
  toolName: string;
  input: unknown;
  /**
   * Unique request id from the wire — used to derive a synthetic
   * `tool_use_id` for the preview-mode dispatch call so the
   * transcript wrapper's [A9] preservation key (typically
   * `<wrapper>/<toolUseId>/fold`) does NOT collide with the same
   * call's preserved state in the transcript surface. A permission
   * dialog and its corresponding transcript row are two distinct
   * UI surfaces and must persist independently.
   */
  requestId: string;
}

/**
 * Render the body kind that goes inside the inline dialog's `children`
 * slot. Returns `null` when the description already carries the
 * relevant input fragment (Read/Write path).
 */
const PendingBody: React.FC<PendingBodyProps> = ({
  toolName,
  input,
  requestId,
}) => {
  const kind = selectPermissionBodyKind(toolName);
  if (kind === "edit") {
    const before = readStringField(input, "old_string");
    const after = readStringField(input, "new_string");
    if (before !== undefined && after !== undefined) {
      return (
        <DiffBlock
          data={{
            source: "two-text",
            before,
            after,
            filePath: readStringField(input, "file_path"),
          }}
          className="session-permission-dialog-diff"
        />
      );
    }
    return null;
  }
  if (kind === "dispatch") {
    return (
      <PendingDispatchBody
        toolName={toolName}
        input={input}
        requestId={requestId}
      />
    );
  }
  // path — the description already carries the file path; no body needed.
  return null;
};

interface PendingDispatchBodyProps {
  toolName: string;
  input: unknown;
  requestId: string;
}

/**
 * Render the real transcript wrapper as the permission-dialog preview.
 * Builds a synthetic `ToolUseMessage`-shape input for
 * `dispatchToolCallState` with `status: "done"` + no result data and
 * `preview: true`; mounts the returned Component with its returned
 * props inside a height-capped, scrollable container.
 *
 * The preview-mode invariant: a wrapper mounted with `preview: true`
 * renders only its input/command side — `BashToolBlock` holds its
 * `(no output)` hint + empty body, `DefaultToolBlock` shows the input
 * JSON tree collapsed (`defaultDepth: 1`), and a hidden tool resolves
 * to `NullToolBlock` (no body at all — the path that keeps a giant
 * `ExitPlanMode` plan from blowing up the dialog). The
 * `session-permission-dialog-preview` wrapper caps the height regardless,
 * so even an unbounded input scrolls inside the dialog rather than
 * stretching it.
 */
const PendingDispatchBody: React.FC<PendingDispatchBodyProps> = ({
  toolName,
  input,
  requestId,
}) => {
  // Synthetic `ToolUseMessage` shape — display-only preview, never
  // enters the substrate. The dispatch only reads `toolUseId` /
  // `toolName` / `input` / `textOutput` / `structuredResult` / `status`
  // (plus `caution` which is only set on drift — preview is never
  // drift); `messageKey` + `createdAt` are required by the type but
  // not read by the renderer. `awaiting: true` gives the header
  // lifecycle dot the "awaiting" pose (the call is held on the user's
  // approval, not finished — a "success" dot would mislead). The
  // trailing `preview` flag tells the resolved wrapper not to paint
  // result-side surfaces.
  const result = dispatchToolCallState(
    {
      kind: "tool_use",
      messageKey: `permission-dialog/${requestId}`,
      createdAt: 0,
      toolUseId: `permission-dialog/${requestId}`,
      toolName,
      input,
      status: "done",
      result: null,
      structuredResult: null,
      toolWallMs: null,
    },
    0,
    undefined,
    undefined,
    true,
    false,
    true,
  );
  const Component = result.Component as React.ComponentType<
    Record<string, unknown>
  >;
  return (
    <div className="session-permission-dialog-preview">
      <Component {...result.props} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Focus ordering — the dialog's controls as cycle stops inside the trap
// ---------------------------------------------------------------------------

/**
 * Tab order inside the dialog's trapped mode: **Allow → Deny → scope group**
 * (user directive). Allow leads (it is the seeded default + recommended action);
 * Deny follows; the scope choices are the last stop. DOM order of the header
 * buttons is unchanged (Deny left, Allow right) — only the focus order differs.
 */
const ALLOW_FOCUS_ORDER = 0;
const DENY_FOCUS_ORDER = 1;
const SCOPE_FOCUS_ORDER = 2;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PermissionDialog: React.FC<PermissionDialogProps> = ({
  input,
  context,
  className,
}) => {
  const { request } = input;
  const { session } = context;
  const requestId = request.request_id;
  const toolName =
    typeof request.tool_name === "string" && request.tool_name.trim() !== ""
      ? request.tool_name
      : "Tool";

  // One focus group for the dialog's controls inside its trapped mode ([P16]):
  // Allow (0) → Deny (1) → scope group (2). Tab cycles only these — the dialog
  // is card-modal, so the keyboard never reaches the (deactivated) editor or the
  // scrimmed chrome while it is open.
  const focusGroup = React.useId();

  // [L02] — "is this request still the session's pendingApproval?"
  // is external state; it enters through `useSyncExternalStore`. The
  // moment `respondApproval` dispatches, the reducer clears
  // `pendingApproval` and notifies synchronously, so this flips to
  // `false` and the component returns `null` — leaving no post-decision
  // chrome behind. The tool block that follows is the only visible
  // artifact (see `#step-3-5`).
  const isPending = React.useSyncExternalStore(
    session.subscribe,
    React.useCallback(
      () => session.getSnapshot().pendingApproval?.request_id === requestId,
      [session, requestId],
    ),
  );

  const respond = React.useCallback(
    (next: "allow" | "deny", updatedPermissions?: unknown[]) => {
      // Re-check against the live store rather than the rendered
      // `isPending` — robust against a click that arrives in the same
      // tick as another responder, or a stale closure.
      const stillPending =
        session.getSnapshot().pendingApproval?.request_id === requestId;
      if (!stillPending) return;
      session.respondApproval(
        requestId,
        updatedPermissions !== undefined
          ? { decision: next, updatedPermissions }
          : { decision: next },
      );
    },
    [session, requestId],
  );

  const suggestions = React.useMemo<PermissionSuggestionAction[]>(() => {
    const raw = request.permission_suggestions ?? [];
    const out: PermissionSuggestionAction[] = [];
    for (const entry of raw) {
      const narrowed = narrowPermissionSuggestion(entry);
      if (narrowed !== null) out.push(narrowed);
    }
    return out;
  }, [request.permission_suggestions]);

  const allowOptions = React.useMemo(
    () => buildPermissionOptions(suggestions),
    [suggestions],
  );

  // [L23] / [D13] — the chosen scope is user data and must survive
  // reload / cross-pane / cold boot. The scoped key is per-request so
  // a genuinely new request mounts fresh while the SAME request
  // rehydrates its in-progress pick. Read synchronously in render so
  // the `useState` initializer below sees the saved value on first
  // paint (no post-mount apply path — bag is populated before the
  // dialog mounts on the boundaries we care about; the [A9] protocol
  // doesn't reconcile late-arriving saved state into a `useState`
  // initializer because the initializer runs exactly once).
  const preservationKey = permissionDialogPreservationKey(requestId);
  const savedState =
    useSavedComponentState<PermissionDialogPreservedState>(preservationKey);

  // Mandatory single-select: the first option (the implicit "Allow
  // once" when scopes are offered) is the default. Initialised once
  // per request from the *initial* options list — switching pending
  // requests would remount this component anyway, so the seed never
  // drifts under us. A saved value from a prior mount supersedes the
  // default when present and still valid against `allowOptions`.
  const [selectedOption, setSelectedOption] = React.useState<string>(
    () => seedPermissionDialogSelectedOption(savedState, allowOptions),
  );

  // Register the capture closure. The framework re-syncs the closure
  // on every render so the latest `selectedOption` is always
  // available at capture time.
  useComponentStatePreservation<PermissionDialogPreservedState>({
    componentStatePreservationKey: preservationKey,
    captureState: () => ({ selectedOption }),
  });

  const decisionReason = React.useMemo<string | undefined>(() => {
    const raw = request.decision_reason;
    if (typeof raw !== "string") return undefined;
    if (raw.trim() === "") return undefined;
    // Drop wire boilerplate that merely restates the dialog's own
    // synthesized prose ("This command requires approval"). When the
    // reason carries substantive context ("Path is outside allowed
    // working directories"), it stays.
    if (isBoilerplateApprovalReason(raw)) return undefined;
    return raw;
  }, [request.decision_reason]);

  // Allow handler — declared HERE, before the `!isPending` early
  // return, so every render of this component calls the same set of
  // hooks in the same order ([L02] / [L24] structure zone). When the
  // user clicks Allow `isPending` flips and this render returns
  // `null`; if `useCallback` were declared inside the pending render
  // body, the post-flip render would hit the early return before
  // reaching the hook and React would crash with "Rendered fewer
  // hooks than expected."
  // Allow with an explicit scope value — the keyboard path (Return on a
  // scope option) commits directly with that option rather than reading
  // the lagging `selectedOption` state.
  const respondAllowWithOption = React.useCallback(
    (optionValue: string) => {
      // The implicit "Allow once" maps to allow-without-scope (no rule
      // written). Any other selection round-trips the chosen suggestion's
      // structured `update` back as `updatedPermissions`, so the CLI
      // records a durable rule at its destination. A selected scope whose
      // suggestion carried no structured `update` degrades to a one-shot
      // allow rather than sending a malformed rule.
      if (optionValue === ALLOW_ONCE_OPTION_VALUE) {
        respond("allow");
        return;
      }
      const chosen = suggestions.find(
        (s) =>
          s.behavior === "allow" &&
          permissionScopeOptionValue(s.label) === optionValue,
      );
      respond(
        "allow",
        chosen?.update !== undefined ? [chosen.update] : undefined,
      );
    },
    [respond, suggestions],
  );

  const handleAllow = React.useCallback(() => {
    respondAllowWithOption(selectedOption);
  }, [respondAllowWithOption, selectedOption]);

  const handleDeny = React.useCallback(() => {
    respond("deny");
  }, [respond]);

  // The dialog is **card-modal** ([P16]): inline display, trapped focus. The
  // trap owns the keyboard while pending — Tab cycles the dialog's own controls
  // (Deny / Allow / scope group) and the opener's key view is restored on
  // dismiss. The prompt entry deactivates off the session's pending state (see
  // `SessionCardBody`), and the card content around the dialog is scrimmed ([P19]).
  // Declared above the `!isPending` early return so hook order is stable.
  // Host-less inline dialog: no Radix focus primitive, so no teardown-autofocus
  // slot to own the DOM-focus write. It does NOT defer — the engine moves DOM
  // focus to the restored key view in `popFocusMode` on close, as before.
  // [P01] The engine's Escape ladder owns Escape now: when this dialog's trap is
  // the top mode, the ladder calls `handleDeny` directly (the same action
  // `useInlineDialogScope`'s CANCEL_DIALOG handler runs — Escape denies a
  // permission prompt) instead of Stage-1's CANCEL_DIALOG fallthrough. ⌘. stays
  // chain-routed via the scope.
  const { FocusModeScope, scopeId } = useFocusTrap({
    active: isPending,
    onEscapeDismiss: handleDeny,
  });

  // Spatial arrow order ([P22] / [P23]) — a closed *vertical loop* through the
  // button row and the scope group, plus the horizontal button ring:
  //   • Left / Right swap the buttons ([Deny, Allow] closed ring) — Left from Allow
  //     lands on Deny, the reported expectation;
  //   • Down from either button drops into the scope group; Up from either button
  //     loops around into it too (there is nothing above the buttons), so the
  //     keyboard always reaches the options;
  //   • Up from the top of the scope group returns to the recommended Allow.
  // The scope group's options are its delegated 1D cursor ([Q12]), not ring nodes —
  // the seams join the button row to the group as one node. Any edge the seams don't
  // name (e.g. Down off the last option) is caught by the navigator's linear-order
  // liveliness fallback, so no arrow ever dead-ends. Nodes are stable `group:order`
  // keys.
  const denyKey = `${focusGroup}:${DENY_FOCUS_ORDER}`;
  const allowKey = `${focusGroup}:${ALLOW_FOCUS_ORDER}`;
  const scopeKey = `${focusGroup}:${SCOPE_FOCUS_ORDER}`;
  const spatialOrder = React.useMemo<SpatialOrder>(
    () => ({
      rings: [{ axis: "horizontal", nodes: [denyKey, allowKey], closed: true }],
      seams: [
        { from: allowKey, direction: "down", to: scopeKey },
        { from: denyKey, direction: "down", to: scopeKey },
        { from: allowKey, direction: "up", to: scopeKey },
        { from: denyKey, direction: "up", to: scopeKey },
        { from: scopeKey, direction: "up", to: allowKey },
      ],
    }),
    [denyKey, allowKey, scopeKey],
  );
  useSpatialOrder(scopeId, isPending ? spatialOrder : null);

  // The dialog's keyboard scope: a `CANCEL_DIALOG` responder so Escape / Cmd-.
  // → Deny, and a seed that lands the key view on Allow (the recommended
  // default) when the dialog opens so Return commits and the ring lands home.
  // `attachRoot` wires the responder onto the dialog's outer element (the
  // ancestor of every control, so the cancel-action routes up to it).
  const { attachRoot, responderId: dialogResponderId } = useInlineDialogScope({
    active: isPending,
    defaultFocusKey: `${focusGroup}:${ALLOW_FOCUS_ORDER}`,
    onCancel: handleDeny,
  });

  // The scope choices are a bog-standard `TugRadioGroup` ([P02]): one item-group
  // Tab stop, arrows move the cursor, Space/Enter check the cursor row. It is a
  // controlled radio whose selection arrives through the responder chain ([L11])
  // — `useResponderForm` registers the `selectValue` handler, keyed on the
  // group's `senderId`, that updates the chosen scope. Its `parentId` is the
  // dialog's cancel responder, so an Escape while the radio holds the key view
  // walks `CANCEL_DIALOG` up to Deny (instead of escaping past the dialog).
  const radioSenderId = React.useId();
  const { ResponderScope: ScopeResponderScope, responderRef: scopeResponderRef } =
    useResponderForm({
      selectValue: { [radioSenderId]: (next: string) => setSelectedOption(next) },
      parentId: dialogResponderId,
    });

  // The dialog has no post-decision chrome — see the module docstring
  // and `#step-3-5`. Once the user clicks (or the request resolves
  // out-of-band), `isPending` flips to `false` and the component
  // returns `null`, leaving no UI trace. The gated tool block that
  // follows is the only post-decision artifact.
  if (!isPending) {
    return null;
  }

  // ---- Pending: composed on TugInlineDialog ([P16]/[P17]) ----------------
  // The controls are decomposed into focus-language archetypes inside the trap:
  // Deny / Allow are leaf buttons (Allow is the recommended default — `primary`
  // emphasis that rests at the badge tint and promotes to fill + ring when
  // engaged, plus `persistentDefaultRing` so it wears the "Return's home" ring
  // the whole time the dialog is open; Deny is outlined-danger and promotes to
  // filled-danger when it holds the key view). The scope choices are a standard
  // `TugRadioGroup` ([P02]) — one item-group Tab stop, arrows move the cursor,
  // Space/Enter check the cursor row; selection rides the responder chain. The
  // body picker (`DiffBlock` for Edit / the dispatch tool block for everything
  // else) and the radio group both render in the `children` slot; for `path` the
  // picker returns `null` and only the radio group shows.
  //
  // The outer wrapper carries the `session-permission-dialog` class (the scrim's
  // bright-island marker, [P19]) and the cancel-action responder root
  // (`attachRoot`). It is NOT focusable — clicking inert chrome establishes no
  // focus state ([P18], the wide-ring dead-zone is gone).
  return (
    <FocusModeScope>
      <div
        ref={attachRoot}
        className="session-permission-dialog"
        data-slot="session-permission-dialog"
      >
        <TugInlineDialog
          icon={<ShieldAlert />}
          iconRole="caution"
          title="Permission requested"
          description={
            <PermissionDescription
              toolName={toolName}
              input={request.input}
              decisionReason={decisionReason}
            />
          }
          actions={
            <>
              <TugPushButton
                emphasis="outlined"
                role="danger"
                size="xs"
                focusGroup={focusGroup}
                focusOrder={DENY_FOCUS_ORDER}
                onClick={handleDeny}
              >
                Deny
              </TugPushButton>
              <TugPushButton
                emphasis="primary"
                role="action"
                size="xs"
                focusGroup={focusGroup}
                focusOrder={ALLOW_FOCUS_ORDER}
                persistentDefaultRing
                onClick={handleAllow}
              >
                Allow
              </TugPushButton>
            </>
          }
          className={className}
        >
          <PendingBody
            toolName={toolName}
            input={request.input}
            requestId={requestId}
          />
          {allowOptions.length > 0 ? (
            <ScopeResponderScope>
              <div
                ref={scopeResponderRef as (el: HTMLDivElement | null) => void}
                className="session-permission-dialog-scope"
              >
                <TugRadioGroup
                  value={selectedOption}
                  senderId={radioSenderId}
                  size="md"
                  orientation="vertical"
                  aria-label="Permission scope"
                  focusGroup={focusGroup}
                  focusOrder={SCOPE_FOCUS_ORDER}
                >
                  {allowOptions.map((option) => (
                    <TugRadioItem
                      key={option.value}
                      value={option.value}
                      description={option.description}
                    >
                      {option.label}
                    </TugRadioItem>
                  ))}
                </TugRadioGroup>
              </div>
            </ScopeResponderScope>
          ) : null}
        </TugInlineDialog>
      </div>
    </FocusModeScope>
  );
};
