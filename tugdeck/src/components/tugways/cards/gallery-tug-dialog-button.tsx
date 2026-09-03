/**
 * gallery-tug-dialog-button.tsx — TugDialogButton demo tab for the
 * Component Gallery.
 *
 * Seven sections, each demonstrating one knob of the primitive's
 * surface — see [#step-18-6](arc/session-assistant-rendering.md#step-18-6):
 *
 *   1. Bare label — single button, label-only, action mode.
 *   2. Label + description — same as 1, plus a multi-line description.
 *   3. Stacked list (4 buttons) — vertical column with varying
 *      description lengths (none / short / medium / wraps multiple
 *      lines). Demonstrates the one-per-row pattern that replaces
 *      `partitionDialogActions`'s row-grid.
 *   4. Choice mode (check style) — three buttons; multi-select; one
 *      pre-selected; click toggles each independently.
 *   5. Choice mode (radio style) — three buttons; single-select;
 *      first pre-selected; click selects one.
 *   6. Danger variant — `role="danger"` with descriptive label.
 *   7. Composed inside `TugInlineDialog` — design preview for the
 *      eventual `extraActions` refactor; uses the dialog's `children`
 *      slot rather than `extraActions` (the existing `extraActions`
 *      rendering is unchanged in this step).
 *
 * Each section reports the user's last click via a result indicator,
 * mirroring the `gallery-tug-inline-dialog.tsx` pattern.
 *
 * @module components/tugways/cards/gallery-tug-dialog-button
 */

import React from "react";
import { ChevronRight, ShieldAlert, Shell } from "lucide-react";

import { TugDialogButton } from "@/components/tugways/tug-dialog-button";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

const resultStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginTop: "8px",
};

const stackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  width: "100%",
  maxWidth: "32.5rem",
};

// ---------------------------------------------------------------------------
// Stacked-list demo data
// ---------------------------------------------------------------------------

interface StackedDemoEntry {
  label: string;
  description?: React.ReactNode;
}

const STACKED_ENTRIES: ReadonlyArray<StackedDemoEntry> = [
  // Entry with no description — the bare row case.
  { label: "Allow once" },
  // Short single-line description.
  {
    label: "Allow for this session",
    description: "Permits this command for the current Dev session only.",
  },
  // Medium description.
  {
    label: "Allow for this project",
    description:
      "Adds a project-scoped rule. The setting persists for this project across Dev restarts but does not apply to other projects on this machine.",
  },
  // Long description that wraps multiple lines.
  {
    label: "Always allow",
    description: (
      <>
        Adds the rule to your <code>userSettings</code> scope, so every project on
        this machine inherits it. Choose this only when you are confident the
        command is universally safe — there is no per-project override layered
        on top of <code>userSettings</code>.
      </>
    ),
  },
];

// ---------------------------------------------------------------------------
// Choice-mode demo data
// ---------------------------------------------------------------------------

interface ChoiceEntry {
  id: string;
  label: string;
  description?: React.ReactNode;
}

const CHECK_CHOICES: ReadonlyArray<ChoiceEntry> = [
  {
    id: "logging",
    label: "Verbose logging",
    description: "Stream every tool invocation's stdout into the transcript.",
  },
  {
    id: "telemetry",
    label: "Anonymous telemetry",
    description: "Send anonymized usage metrics back to the Dev team.",
  },
  {
    id: "autosave",
    label: "Auto-save edits",
    description: "Persist editor changes to disk automatically every 30 seconds.",
  },
];

const RADIO_CHOICES: ReadonlyArray<ChoiceEntry> = [
  {
    id: "allow-session",
    label: "Allow for this session",
    description: "The rule lives in memory and clears when Dev quits.",
  },
  {
    id: "allow-project",
    label: "Allow for this project",
    description: "Persisted to the project's local settings file.",
  },
  {
    id: "allow-always",
    label: "Always allow",
    description: "Persisted to your user-level settings; applies everywhere.",
  },
];

// ---------------------------------------------------------------------------
// GalleryTugDialogButton
// ---------------------------------------------------------------------------

export function GalleryTugDialogButton(): React.ReactElement {
  // Per-section result strings + selection state.
  const [bareResult, setBareResult] = React.useState<string>("—");
  const [labelDescResult, setLabelDescResult] = React.useState<string>("—");
  const [stackedResult, setStackedResult] = React.useState<string>("—");
  const [dangerResult, setDangerResult] = React.useState<string>("—");
  const [composedResult, setComposedResult] = React.useState<string>("—");

  // Multi-select toggle set for the check-style demo. Pre-selects "telemetry"
  // so the demo opens with one row already checked.
  const [checkSelected, setCheckSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(["telemetry"]),
  );
  const toggleCheck = React.useCallback((id: string) => {
    setCheckSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Single-select for the radio-style demo. Pre-selects the first entry.
  const [radioSelected, setRadioSelected] = React.useState<string>(
    RADIO_CHOICES[0].id,
  );

  // Single-select for the composed-inside-dialog design preview.
  // Pre-selected to the first option, and the click handler in the
  // dialog only ever *sets* a new selection — it never clears it,
  // matching radio semantics ("there is always exactly one chosen
  // option"). The user's escape from the choice is the dialog's Deny
  // button, not a toggle-off on the option itself.
  const [composedScope, setComposedScope] = React.useState<string>(
    RADIO_CHOICES[0].id,
  );

  return (
    <div className="cg-content" data-testid="gallery-tug-dialog-button">
      {/* ---- 1. Bare label ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Bare label</TugLabel>
        <div style={labelStyle}>
          Single <code>TugDialogButton</code>, label-only, action mode (no{" "}
          <code>selected</code> prop).
        </div>
        <div style={stackStyle}>
          <TugDialogButton
            label="Open settings"
            onClick={() => setBareResult("Open settings clicked")}
          />
        </div>
        <div style={resultStyle}>
          Result: <strong>{bareResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Label + description ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Label + description</TugLabel>
        <div style={labelStyle}>
          A multi-line description renders below the title row, muted
          and wrapped. <code>trailing</code> shows a chevron leading
          to another surface.
        </div>
        <div style={stackStyle}>
          <TugDialogButton
            label="Configure permissions"
            description={
              <>
                Review the per-tool allow/deny rules currently in effect for
                this project, including any scoped to{" "}
                <code>session</code> only.
              </>
            }
            trailing={<ChevronRight aria-hidden="true" />}
            onClick={() => setLabelDescResult("Configure permissions clicked")}
          />
        </div>
        <div style={resultStyle}>
          Result: <strong>{labelDescResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. Stacked list ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Stacked list (4 buttons; one-per-row pattern)
        </TugLabel>
        <div style={labelStyle}>
          Four <code>TugDialogButton</code>s stacked vertically. Varying
          description lengths show how the row height grows independently —
          the dialog frame absorbs the variation without a row-grid.
        </div>
        <div style={stackStyle}>
          {STACKED_ENTRIES.map((entry) => (
            <TugDialogButton
              key={entry.label}
              label={entry.label}
              description={entry.description}
              onClick={() => setStackedResult(entry.label)}
            />
          ))}
        </div>
        <div style={resultStyle}>
          Last clicked: <strong>{stackedResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. Choice mode (check style) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Choice mode — check style (multi-select)
        </TugLabel>
        <div style={labelStyle}>
          Three independent toggles. Each button carries{" "}
          <code>aria-checked</code> (<code>role="checkbox"</code>); click
          toggles its row in isolation.
        </div>
        <div style={stackStyle}>
          {CHECK_CHOICES.map((choice) => (
            <TugDialogButton
              key={choice.id}
              label={choice.label}
              description={choice.description}
              selected={checkSelected.has(choice.id)}
              selectionStyle="check"
              onClick={() => toggleCheck(choice.id)}
            />
          ))}
        </div>
        <div style={resultStyle}>
          Selected:{" "}
          <strong>
            {checkSelected.size === 0
              ? "(none)"
              : Array.from(checkSelected).join(", ")}
          </strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. Choice mode (radio style) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Choice mode — radio style (single-select)
        </TugLabel>
        <div style={labelStyle}>
          Three options, exactly one selected. Each button carries{" "}
          <code>aria-checked</code> (<code>role="radio"</code>); the
          host wraps the stack in <code>role="radiogroup"</code> for
          screen-reader semantics.
        </div>
        <div
          style={stackStyle}
          role="radiogroup"
          aria-label="Permission scope"
        >
          {RADIO_CHOICES.map((choice) => (
            <TugDialogButton
              key={choice.id}
              label={choice.label}
              description={choice.description}
              selected={radioSelected === choice.id}
              selectionStyle="radio"
              onClick={() => setRadioSelected(choice.id)}
            />
          ))}
        </div>
        <div style={resultStyle}>
          Selected: <strong>{radioSelected}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 6. Danger variant ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Danger variant</TugLabel>
        <div style={labelStyle}>
          <code>role="danger"</code>. The destructive cascade reads
          firmly distinct from action — same outline shape, red
          surface tokens.
        </div>
        <div style={stackStyle}>
          <TugDialogButton
            label="Delete this project"
            description={
              <>
                Removes <code>~/Projects/tugtool</code> and all of its history
                from Dev. The directory on disk is untouched, but you will
                lose every Dev-side annotation, watch, and saved layout.
              </>
            }
            role="danger"
            onClick={() => setDangerResult("Delete clicked")}
          />
        </div>
        <div style={resultStyle}>
          Result: <strong>{dangerResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 7. Composed inside TugInlineDialog ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Composed inside TugInlineDialog
        </TugLabel>
        <div style={labelStyle}>
          The dialog's <code>options</code> prop renders this primitive
          as a mandatory single-select radio group. Clicking a row
          picks it; Allow commits the chosen scope. To reject every
          option, the user clicks Deny — the dialog is the off-ramp.
        </div>
        <TugInlineDialog
          icon={<ShieldAlert />}
          iconRole="caution"
          title="Permission requested"
          description={
            <>
              This command requires approval ·{" "}
              <span style={{ verticalAlign: "middle" }}>
                <Shell size={12} aria-hidden="true" />
              </span>{" "}
              Bash · <code>tokei</code>
            </>
          }
          actions={
            <>
              <TugPushButton
                emphasis="outlined"
                role="danger"
                size="xs"
                onClick={() => setComposedResult("Denied")}
              >
                Deny
              </TugPushButton>
              <TugPushButton
                emphasis="filled"
                role="action"
                size="xs"
                onClick={() =>
                  setComposedResult(`Allowed — scope: ${composedScope}`)
                }
              >
                Allow
              </TugPushButton>
            </>
          }
          options={RADIO_CHOICES.map((choice) => ({
            value: choice.id,
            label: choice.label,
            description: choice.description,
          }))}
          selectedOption={composedScope}
          onSelectOption={setComposedScope}
          optionsAriaLabel="Permission scope"
        />
        <div style={resultStyle}>
          Result: <strong>{composedResult}</strong>
        </div>
      </div>

    </div>
  );
}
