/**
 * Pure-logic tests for `session-permission-dialog.tsx`.
 *
 * `PermissionDialog`'s behaviour is its exported pure helpers —
 * the body-kind picker, the suggestion narrowing + label composer,
 * the options builder for the radio-group scope picker, and the Read
 * line-range badge — plus the dispatch wiring
 * (`KIND_RENDERERS.permission` resolves to the real component). Per
 * project policy (pure-logic `bun:test` + real-app tests only, no
 * fake-DOM render tests), the suite pins those exhaustively; the
 * Allow/Deny round-trip, the radio-group radio-mark paint, and
 * primary-button focus are HMR / live-smoke vetted because the
 * app-test harness can't inject `control_request_forward` events
 * (same gap that gates #step-15–#step-17).
 *
 * Coverage:
 *  - `selectPermissionBodyKind` — Bash / Edit / MultiEdit / Read /
 *    Write / fallthrough, case-insensitive.
 *  - `composePermissionSuggestionLabel` — every (behavior ×
 *    destination) cell, including the destination-less fallback and
 *    the unknown-destination passthrough.
 *  - `narrowPermissionSuggestion` — the v2.1.x catalog shape,
 *    allow/deny behaviors, non-actionable drop, the "rules content is
 *    intentionally dropped" contract.
 *  - `buildPermissionOptions` — empty list passthrough, allow-only
 *    filtering, implicit "Allow once" head, deny-suggestion drop.
 *  - `composePermissionLineRange` — offset+limit / offset / limit /
 *    neither / non-object.
 *  - dispatch routing — a `permission` RenderInput resolves to
 *    `PermissionDialog`.
 *
 * The dialog is *pending-only* post-Step-3.5 (see `#step-3-5`); the
 * former `recordedPermissionPresentation` helper and its describe
 * block are gone along with the recorded chrome.
 */

import { describe, it, expect } from "bun:test";

import {
  ALLOW_ONCE_OPTION_DESCRIPTION,
  ALLOW_ONCE_OPTION_LABEL,
  ALLOW_ONCE_OPTION_VALUE,
  PERMISSION_DIALOG_PRESERVATION_KEY_PREFIX,
  buildPermissionOptions,
  composePermissionLineRange,
  composePermissionSuggestionLabel,
  isBoilerplateApprovalReason,
  narrowPermissionSuggestion,
  permissionDialogPreservationKey,
  permissionScopeOptionValue,
  seedPermissionDialogSelectedOption,
  selectPermissionBodyKind,
  type PermissionDialogPreservedState,
  type PermissionSuggestionAction,
} from "./session-permission-dialog";
import {
  KIND_RENDERERS,
  dispatch,
  type DispatchContext,
  type RenderInput,
} from "@/components/tugways/cards/session-assistant-renderer-dispatch";
import { hasBespokeWrapper } from "@/components/tugways/cards/session-assistant-renderer-registrations";

// ---------------------------------------------------------------------------
// selectPermissionBodyKind
// ---------------------------------------------------------------------------

describe("selectPermissionBodyKind", () => {
  it("routes Bash through the dispatch body kind", () => {
    // Bash no longer has a bespoke dialog preview — its command renders
    // through the same `BashToolBlock` the transcript uses, mounted in
    // preview mode. So the picker routes it to `"dispatch"`.
    expect(selectPermissionBodyKind("Bash")).toBe("dispatch");
    expect(selectPermissionBodyKind("bash")).toBe("dispatch");
  });

  it("routes Edit and MultiEdit to the edit body kind", () => {
    expect(selectPermissionBodyKind("Edit")).toBe("edit");
    expect(selectPermissionBodyKind("MultiEdit")).toBe("edit");
    expect(selectPermissionBodyKind("MULTIEDIT")).toBe("edit");
  });

  it("routes Read and Write to the path body kind", () => {
    expect(selectPermissionBodyKind("Read")).toBe("path");
    expect(selectPermissionBodyKind("Write")).toBe("path");
  });

  it("routes a bespoke transcript wrapper through the dispatch body kind", () => {
    // Any tool with a bespoke transcript wrapper routes through the
    // `"dispatch"` body kind so the dialog preview matches the
    // transcript rendering. Only `edit` / `read` / `write` keep their
    // dedicated dialog branches.
    expect(selectPermissionBodyKind("Monitor")).toBe("dispatch");
    expect(selectPermissionBodyKind("Skill")).toBe("dispatch");
    expect(selectPermissionBodyKind("Glob")).toBe("dispatch");
    expect(selectPermissionBodyKind("Grep")).toBe("dispatch");
  });

  it("resolves dispatch routing through tool-name aliases", () => {
    // `enterworktree` / `exitworktree` → `worktree` alias.
    // `multiedit` stays on the `"edit"` dialog branch.
    expect(selectPermissionBodyKind("EnterWorktree")).toBe("dispatch");
    expect(selectPermissionBodyKind("ExitWorktree")).toBe("dispatch");
    // Cron + TaskMgmt + Task* aliases all resolve to bespoke wrappers.
    expect(selectPermissionBodyKind("CronCreate")).toBe("dispatch");
    expect(selectPermissionBodyKind("TaskList")).toBe("dispatch");
    expect(selectPermissionBodyKind("TaskOutput")).toBe("dispatch");
  });

  it("dispatch-routed tools resolve to the same factory the transcript uses", () => {
    // Body composition for the `"dispatch"` branch: the picked
    // Component MUST equal the wrapper the transcript uses (per
    // `BESPOKE_FACTORY_BY_NAME`). This guarantees the dialog
    // preview and the transcript row render the same wrapper.
    for (const wireName of [
      "Bash",
      "Monitor",
      "Skill",
      "EnterWorktree",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "NotebookEdit",
    ]) {
      // `selectPermissionBodyKind` should pick "dispatch" for each.
      expect(selectPermissionBodyKind(wireName)).toBe("dispatch");
      // And `hasBespokeWrapper` agrees (the helper the picker
      // consults under the hood). Aliases resolve through the
      // dispatch's TOOL_ALIASES map.
      expect(hasBespokeWrapper(wireName)).toBe(true);
    }
  });

  it("routes an unknown tool through dispatch (DefaultToolBlock fallback)", () => {
    // A genuinely unknown tool (a future Claude Code addition before
    // the policy table is updated) and the empty-name edge both route
    // through `"dispatch"`. The dispatch resolves them to
    // `DefaultToolBlock` (input JSON tree, collapsed) — no separate
    // "json" branch in the dialog anymore.
    expect(selectPermissionBodyKind("ZzzUnknownTool")).toBe("dispatch");
    expect(selectPermissionBodyKind("")).toBe("dispatch");
  });
});

// ---------------------------------------------------------------------------
// narrowPermissionSuggestion
// ---------------------------------------------------------------------------

describe("composePermissionSuggestionLabel", () => {
  it("renders allow + each known destination", () => {
    expect(composePermissionSuggestionLabel("allow", "session")).toBe(
      "Allow for this session",
    );
    expect(composePermissionSuggestionLabel("allow", "project")).toBe(
      "Allow for this project",
    );
    expect(composePermissionSuggestionLabel("allow", "localSettings")).toBe(
      "Allow for this project",
    );
    expect(composePermissionSuggestionLabel("allow", "projectSettings")).toBe(
      "Allow for this project",
    );
    expect(composePermissionSuggestionLabel("allow", "userSettings")).toBe(
      "Always allow",
    );
  });

  it("renders deny + each known destination", () => {
    expect(composePermissionSuggestionLabel("deny", "session")).toBe(
      "Deny for this session",
    );
    expect(composePermissionSuggestionLabel("deny", "project")).toBe(
      "Deny for this project",
    );
    expect(composePermissionSuggestionLabel("deny", "userSettings")).toBe(
      "Always deny",
    );
  });

  it("falls back to '{Verb} this action' when destination is omitted", () => {
    expect(composePermissionSuggestionLabel("allow", undefined)).toBe(
      "Allow this action",
    );
    expect(composePermissionSuggestionLabel("deny", undefined)).toBe(
      "Deny this action",
    );
  });

  it("passes an unknown destination through verbatim (forward-compat scope)", () => {
    expect(composePermissionSuggestionLabel("allow", "branch")).toBe(
      "Allow (branch)",
    );
    expect(composePermissionSuggestionLabel("deny", "global")).toBe(
      "Deny (global)",
    );
  });
});

describe("narrowPermissionSuggestion", () => {
  it("narrows the v2.1.x catalog allow + session shape", () => {
    // Verbatim from test-11-permission-deny-roundtrip.jsonl. The
    // wire's verbose `rules` content is dropped from the visible
    // *label* — the dialog's description already names the specific
    // tool + command — but the structured entry is retained as
    // `update` so the Allow round-trip can echo it back verbatim.
    const suggestion = {
      behavior: "allow",
      destination: "session",
      rules: [{ ruleContent: "//nonexistent/**", toolName: "Read" }],
      type: "addRules",
    };
    expect(narrowPermissionSuggestion(suggestion)).toEqual({
      behavior: "allow",
      label: "Allow for this session",
      update: {
        behavior: "allow",
        destination: "session",
        rules: [{ ruleContent: "//nonexistent/**", toolName: "Read" }],
        type: "addRules",
      },
    });
  });

  it("retains the structured update for an allow + project addRules", () => {
    // "Allow for this project" rides back as `updatedPermissions` so
    // the CLI writes a durable rule at its destination.
    const suggestion = {
      behavior: "allow" as const,
      destination: "localSettings",
      rules: [{ ruleContent: "tokei:*", toolName: "Bash" }],
      type: "addRules",
    };
    const narrowed = narrowPermissionSuggestion(suggestion);
    expect(narrowed?.label).toBe("Allow for this project");
    expect(narrowed?.update).toEqual(suggestion);
  });

  it("captures no `update` when the suggestion names no scope (type/destination)", () => {
    // A degenerate allow with no structured shape carries nothing to
    // echo — Allow on it behaves like a one-shot allow.
    expect(
      narrowPermissionSuggestion({ behavior: "allow" })?.update,
    ).toBeUndefined();
    expect(
      narrowPermissionSuggestion({ behavior: "allow", destination: "session" })
        ?.update,
    ).toBeUndefined();
  });

  it("narrows a deny + userSettings suggestion", () => {
    const suggestion = {
      behavior: "deny",
      destination: "userSettings",
      rules: [{ ruleContent: "rm -rf *", toolName: "Bash" }],
    };
    expect(narrowPermissionSuggestion(suggestion)).toEqual({
      behavior: "deny",
      label: "Always deny",
    });
  });

  it("drops a suggestion whose behavior is not actionable", () => {
    // `ask` has no `tool_approval` wire representation — drop it.
    expect(
      narrowPermissionSuggestion({ behavior: "ask", rules: [] }),
    ).toBeNull();
    expect(narrowPermissionSuggestion({ rules: [] })).toBeNull();
  });

  it("drops non-object input", () => {
    expect(narrowPermissionSuggestion(null)).toBeNull();
    expect(narrowPermissionSuggestion("allow")).toBeNull();
    expect(narrowPermissionSuggestion(undefined)).toBeNull();
  });

  it("falls back to a destination-less label when destination is omitted", () => {
    expect(narrowPermissionSuggestion({ behavior: "allow" })).toEqual({
      behavior: "allow",
      label: "Allow this action",
    });
  });

  it("ignores rule content entirely (label keys off behavior + destination)", () => {
    // The wire `rules` array used to drive the label; it no longer
    // does. A suggestion with rules but no destination still falls
    // back to the destination-less label.
    expect(
      narrowPermissionSuggestion({
        behavior: "allow",
        rules: [{ ruleContent: "//x/**" }, { toolName: "Grep" }, null, 7],
      }),
    ).toEqual({
      behavior: "allow",
      label: "Allow this action",
    });
  });
});

// ---------------------------------------------------------------------------
// buildPermissionOptions — radio-group scope picker
// ---------------------------------------------------------------------------

describe("buildPermissionOptions", () => {
  it("returns an empty array when there are no suggestions", () => {
    // No suggestions → no scope picker; the dialog renders without
    // an options block and Allow defaults to one-shot scope.
    expect(buildPermissionOptions([])).toEqual([]);
  });

  it("returns an empty array when every suggestion is deny-scoped", () => {
    // Deny-scoped suggestions are not surfaced as scope choices —
    // Deny in this dialog is always the off-ramp button. A list
    // containing only deny-scoped entries collapses to no options.
    const denyOnly: ReadonlyArray<PermissionSuggestionAction> = [
      { behavior: "deny", label: "Always deny" },
      { behavior: "deny", label: "Deny for this project" },
    ];
    expect(buildPermissionOptions(denyOnly)).toEqual([]);
  });

  it("prepends the implicit 'Allow once' head when allow-scopes exist", () => {
    const allows: ReadonlyArray<PermissionSuggestionAction> = [
      { behavior: "allow", label: "Allow for this session" },
      { behavior: "allow", label: "Allow for this project" },
      { behavior: "allow", label: "Always allow" },
    ];
    expect(buildPermissionOptions(allows)).toEqual([
      {
        value: ALLOW_ONCE_OPTION_VALUE,
        label: ALLOW_ONCE_OPTION_LABEL,
        description: ALLOW_ONCE_OPTION_DESCRIPTION,
      },
      { value: "allow:Allow for this session", label: "Allow for this session" },
      { value: "allow:Allow for this project", label: "Allow for this project" },
      { value: "allow:Always allow",            label: "Always allow" },
    ]);
  });

  it("filters deny-scoped suggestions out of a mixed list", () => {
    const mixed: ReadonlyArray<PermissionSuggestionAction> = [
      { behavior: "allow", label: "Allow for this session" },
      { behavior: "deny",  label: "Deny for this project" },
      { behavior: "allow", label: "Always allow" },
    ];
    expect(buildPermissionOptions(mixed)).toEqual([
      {
        value: ALLOW_ONCE_OPTION_VALUE,
        label: ALLOW_ONCE_OPTION_LABEL,
        description: ALLOW_ONCE_OPTION_DESCRIPTION,
      },
      { value: "allow:Allow for this session", label: "Allow for this session" },
      { value: "allow:Always allow",            label: "Always allow" },
    ]);
  });

  it("'Allow once' is always the first option when present (radio default)", () => {
    const allows: ReadonlyArray<PermissionSuggestionAction> = [
      { behavior: "allow", label: "Always allow" },
    ];
    const options = buildPermissionOptions(allows);
    // Pinning the default ordering protects the radio-group's initial
    // selection: TugInlineDialog picks options[0] as the default,
    // and we want "Allow once" (the no-rule scope) to be that
    // default — never a persistent rule.
    expect(options[0].value).toBe(ALLOW_ONCE_OPTION_VALUE);
  });
});

// ---------------------------------------------------------------------------
// permissionScopeOptionValue — option-value ↔ suggestion linkage
// ---------------------------------------------------------------------------

describe("permissionScopeOptionValue", () => {
  it("derives the `allow:<label>` value the option and the Allow handler share", () => {
    expect(permissionScopeOptionValue("Allow for this project")).toBe(
      "allow:Allow for this project",
    );
  });

  it("matches the value buildPermissionOptions stamps onto each scope option", () => {
    // Drift guard: the dialog's Allow handler maps the selected value
    // back to a suggestion via this helper, so the value the builder
    // emits must equal the value the helper derives from the label.
    const allows: ReadonlyArray<PermissionSuggestionAction> = [
      { behavior: "allow", label: "Allow for this project" },
    ];
    const options = buildPermissionOptions(allows);
    expect(options[1].value).toBe(
      permissionScopeOptionValue("Allow for this project"),
    );
  });
});

// ---------------------------------------------------------------------------
// isBoilerplateApprovalReason — wire-noise filter for decision_reason
// ---------------------------------------------------------------------------

describe("isBoilerplateApprovalReason", () => {
  it("flags the wire's bare 'This command requires approval' as boilerplate", () => {
    // The exact string that doubled up in the live dialog before the
    // filter landed — pinned here so a regression on the matcher
    // surfaces immediately.
    expect(isBoilerplateApprovalReason("This command requires approval")).toBe(
      true,
    );
  });

  it("flags case + punctuation variants of the same sentence", () => {
    expect(isBoilerplateApprovalReason("THIS COMMAND REQUIRES APPROVAL")).toBe(
      true,
    );
    expect(isBoilerplateApprovalReason("This command requires approval.")).toBe(
      true,
    );
    expect(isBoilerplateApprovalReason("  this command requires approval  ")).toBe(
      true,
    );
  });

  it("flags the related boilerplate variants", () => {
    expect(isBoilerplateApprovalReason("This tool requires approval")).toBe(true);
    expect(isBoilerplateApprovalReason("This action requires approval")).toBe(
      true,
    );
    expect(isBoilerplateApprovalReason("Approval required")).toBe(true);
    expect(isBoilerplateApprovalReason("Requires approval")).toBe(true);
    expect(isBoilerplateApprovalReason("Permission requested")).toBe(true);
    expect(isBoilerplateApprovalReason("Permission required")).toBe(true);
  });

  it("flags the empty-string case (whitespace-only after trim)", () => {
    expect(isBoilerplateApprovalReason("")).toBe(true);
    expect(isBoilerplateApprovalReason("   ")).toBe(true);
  });

  it("preserves substantive reasons that add real context", () => {
    // The reasons we WANT to render — each names a constraint the
    // dialog's synthesized prose cannot have already conveyed.
    expect(
      isBoilerplateApprovalReason(
        "Path is outside allowed working directories",
      ),
    ).toBe(false);
    expect(
      isBoilerplateApprovalReason("File is outside the workspace root"),
    ).toBe(false);
    expect(
      isBoilerplateApprovalReason("Command matches a blocked pattern"),
    ).toBe(false);
    expect(
      isBoilerplateApprovalReason(
        "This command requires approval because the path escapes the project root",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// composePermissionLineRange
// ---------------------------------------------------------------------------

describe("composePermissionLineRange", () => {
  it("composes a closed range from offset + limit", () => {
    expect(composePermissionLineRange({ offset: 10, limit: 20 })).toBe(
      "lines 10–29",
    );
  });

  it("composes an open-ended range from offset alone", () => {
    expect(composePermissionLineRange({ offset: 10 })).toBe("from line 10");
  });

  it("composes a head range from limit alone", () => {
    expect(composePermissionLineRange({ limit: 20 })).toBe("first 20 lines");
  });

  it("returns undefined when neither field is set", () => {
    expect(composePermissionLineRange({ file_path: "/x.ts" })).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(composePermissionLineRange(null)).toBeUndefined();
    expect(composePermissionLineRange("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dispatch routing
// ---------------------------------------------------------------------------

describe("dispatch — permission routing", () => {
  it("routes a permission RenderInput to the real PermissionDialog", () => {
    const input: RenderInput = {
      kind: "permission",
      request: {
        request_id: "req-1",
        is_question: false,
        tool_name: "Read",
        input: { file_path: "/nonexistent/file.txt" },
        decision_reason: "Path is outside allowed working directories",
      },
    };
    const result = dispatch(input, {} as DispatchContext);
    // The stable contract is "routes via `KIND_RENDERERS.permission`."
    // The slot now holds a lazy indirection (per
    // [#step-24-3-7]'s module-cycle fix) — asserting `=== PermissionDialog`
    // directly would falsely fail; the indirection still renders the
    // real dialog when invoked. Asserting against the slot is the
    // right level of coupling: the dispatch promises the slot, not
    // the slot's internal shape.
    expect(result.Component).toBe(KIND_RENDERERS.permission);
    expect(result.caution).toBeUndefined();
    // The dispatch threads the input + context through as the prop bag.
    expect((result.props as { input: RenderInput }).input).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// [L23] A9 preservation — key derivation + seed/capture round-trip
// ---------------------------------------------------------------------------

describe("permissionDialogPreservationKey", () => {
  it("namespaces the request id under the permission-dialog prefix", () => {
    expect(permissionDialogPreservationKey("req-42")).toBe(
      "permission-dialog/req-42",
    );
  });

  it("uses the exported prefix constant", () => {
    expect(PERMISSION_DIALOG_PRESERVATION_KEY_PREFIX).toBe(
      "permission-dialog/",
    );
    expect(permissionDialogPreservationKey("x")).toBe(
      `${PERMISSION_DIALOG_PRESERVATION_KEY_PREFIX}x`,
    );
  });

  it("uses a distinct prefix from the question dialog's", () => {
    // Defensive: the two dialogs must not collide in `bag.components`
    // even if a future change reuses request_ids across types.
    expect(PERMISSION_DIALOG_PRESERVATION_KEY_PREFIX).not.toBe(
      "question-dialog/",
    );
  });
});

describe("seedPermissionDialogSelectedOption", () => {
  // Mirrors the options shape `buildPermissionOptions` produces when at
  // least one allow-scoped suggestion is present: the implicit
  // "Allow once" head plus the persistent scope rows.
  const allowOptionsWithScopes = [
    {
      value: ALLOW_ONCE_OPTION_VALUE,
      label: ALLOW_ONCE_OPTION_LABEL,
      description: ALLOW_ONCE_OPTION_DESCRIPTION,
    },
    { value: "allow:Allow for this session", label: "Allow for this session" },
    { value: "allow:Allow for this project", label: "Allow for this project" },
  ];

  it("returns the default (first option) when no saved state is present", () => {
    expect(seedPermissionDialogSelectedOption(undefined, allowOptionsWithScopes)).toBe(
      ALLOW_ONCE_OPTION_VALUE,
    );
  });

  it("returns the saved value when it matches a current option", () => {
    const saved: PermissionDialogPreservedState = {
      selectedOption: "allow:Allow for this project",
    };
    expect(seedPermissionDialogSelectedOption(saved, allowOptionsWithScopes)).toBe(
      "allow:Allow for this project",
    );
  });

  it("falls back to the default when the saved option is no longer present", () => {
    // A wire shape change (or a new request with a different
    // suggestion set under the same request_id — shouldn't happen in
    // practice, but defensive) leaves a stale saved value. Don't
    // silently select nothing; revert to the default.
    const saved: PermissionDialogPreservedState = {
      selectedOption: "allow:gone-away",
    };
    expect(seedPermissionDialogSelectedOption(saved, allowOptionsWithScopes)).toBe(
      ALLOW_ONCE_OPTION_VALUE,
    );
  });

  it("accepts the implicit Allow-once value even when no options are offered", () => {
    // No allow-scoped suggestions → empty options list. The dialog
    // falls back to ALLOW_ONCE_OPTION_VALUE; a saved value of
    // ALLOW_ONCE_OPTION_VALUE is consistent with that fallback and
    // should round-trip.
    expect(
      seedPermissionDialogSelectedOption(
        { selectedOption: ALLOW_ONCE_OPTION_VALUE },
        [],
      ),
    ).toBe(ALLOW_ONCE_OPTION_VALUE);
  });

  it("falls back to ALLOW_ONCE_OPTION_VALUE when no options offered and no saved state", () => {
    expect(seedPermissionDialogSelectedOption(undefined, [])).toBe(
      ALLOW_ONCE_OPTION_VALUE,
    );
  });

  it("rejects a malformed envelope and returns the default", () => {
    // `selectedOption` non-string: the envelope is rejected.
    expect(
      seedPermissionDialogSelectedOption(
        { selectedOption: 42 },
        allowOptionsWithScopes,
      ),
    ).toBe(ALLOW_ONCE_OPTION_VALUE);
    expect(
      seedPermissionDialogSelectedOption(null, allowOptionsWithScopes),
    ).toBe(ALLOW_ONCE_OPTION_VALUE);
    expect(
      seedPermissionDialogSelectedOption("not-an-object", allowOptionsWithScopes),
    ).toBe(ALLOW_ONCE_OPTION_VALUE);
  });

  it("round-trips a captured value through the seed path (encode-then-decode identity)", () => {
    // Simulate the framework's save/restore boundary: the capture
    // closure serializes the live `selectedOption`;
    // `useSavedComponentState` hands the same envelope back to
    // `seedPermissionDialogSelectedOption`. The result is the input.
    const captured: PermissionDialogPreservedState = {
      selectedOption: "allow:Allow for this session",
    };
    const roundTripped = JSON.parse(JSON.stringify(captured)) as unknown;
    expect(
      seedPermissionDialogSelectedOption(roundTripped, allowOptionsWithScopes),
    ).toBe(captured.selectedOption);
  });
});
