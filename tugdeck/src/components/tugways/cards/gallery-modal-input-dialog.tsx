/**
 * gallery-modal-input-dialog.tsx — ModalInputDialog demo tab for the
 * Component Gallery.
 *
 * Opens the dialog over a static in-memory provider, with a `TugFileChooser`
 * in the header slot. The chooser is the point: it is the one control here
 * whose own dropdown portals, and a modal Radix content leaves anything
 * portalled outside it pointer-dead. This card keeps that interaction — a
 * mouse pick in the chooser's dropdown — reachable by hand, in any theme, so
 * the arrangement can be checked without standing up Open Quickly.
 *
 * @module components/tugways/cards/gallery-modal-input-dialog
 */

import React from "react";

import {
  ModalInputDialog,
  MODAL_INPUT_DIALOG_FOCUS_GROUP,
  useModalInputDialogPanel,
} from "@/components/chrome/modal-input-dialog";
import { TugFileChooser, useFileChooserHost } from "@/components/tugways/tug-file-chooser";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import type { TugComboBoxItem } from "@/components/tugways/tug-combo-box";

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

/** A handful of plausible paths to search — this card has no file backend. */
const FIXTURE_PATHS = [
  "src/components/chrome/modal-input-dialog.tsx",
  "src/components/tugways/tug-file-chooser.tsx",
  "src/components/tugways/tug-combo-box.tsx",
  "src/components/chrome/open-quickly-overlay.tsx",
  "src/lib/open-quickly-store.ts",
  "src/lib/filetree-store.ts",
  "tuglaws/focus-language.md",
  "tuglaws/component-authoring.md",
];

/** Directories the header chooser offers, the way recents seed the real one. */
const FIXTURE_DIRS = [
  "/Users/example/src/tugtool",
  "/Users/example/src/tugtool/tugdeck",
  "/Users/example/Documents/notes",
];

/**
 * Substring match over the fixture paths, with the matched run reported so the
 * dialog's own emphasis renderer has something to emphasize.
 */
const fixtureProvider = ((query: string): CompletionItem[] => {
  const needle = query.trim().toLowerCase();
  return FIXTURE_PATHS.filter(
    (path) => needle === "" || path.toLowerCase().includes(needle),
  ).map((path) => {
    const at = needle === "" ? -1 : path.toLowerCase().indexOf(needle);
    const item: CompletionItem = {
      label: path,
      atom: {
        kind: "atom",
        type: "file",
        label: path.split("/").pop() ?? path,
        value: path,
      },
    };
    if (at >= 0) item.matches = [[at, at + needle.length]];
    return item;
  });
}) as CompletionProvider;

/** The header row: the chooser, portalled into the dialog's own panel. */
function ChooserHeader({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  // The dialog's panel. A modal Radix content makes every node outside itself
  // pointer-dead, so the dropdown portals in here instead of the canvas
  // overlay root — inside the jail it is not outside anything.
  const panel = useModalInputDialogPanel();
  const seed = React.useCallback((query: string): TugComboBoxItem[] => {
    const needle = query.trim().toLowerCase();
    return FIXTURE_DIRS.filter(
      (dir) => needle === "" || dir.toLowerCase().includes(needle),
    ).map((dir) => ({ value: dir, label: dir }));
  }, []);

  const ChooserHost = useFileChooserHost({ onChange });
  return (
    <ChooserHost>
    <TugFileChooser size="sm"
      value={value}
      base={value !== "" ? value : "/"}
      kind="directory"
      menuMode
      seed={seed}
      aria-label="Search directory"
      focusGroup={MODAL_INPUT_DIALOG_FOCUS_GROUP}
      focusOrder={2}
      browseFocusOrder={1}
      chevronFocusOrder={3}
      portalContainer={panel}
      overlaySlot="tug-modal-input-dialog-chooser-overlay"
    />
    </ChooserHost>
  );
}

export function GalleryModalInputDialog(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [committed, setCommitted] = React.useState("none");
  const [scope, setScope] = React.useState(FIXTURE_DIRS[0]);

  return (
    <div className="cg-content" data-testid="gallery-modal-input-dialog">
      <div className="cg-section">
        <TugLabel className="cg-section-title">App-Modal Input Dialog</TugLabel>
        <div style={labelStyle}>
          Typing-first HUD input over a static provider, with a TugFileChooser
          scope row in the header. Escape or ⌘. dismisses; a click outside
          dismisses (launcher posture) without activating what it lands on.
        </div>
        <div style={{ display: "flex" }}>
          <TugPushButton
            emphasis="outlined"
            size="sm"
            data-testid="gallery-open-modal-input-dialog"
            onClick={() => setOpen(true)}
          >
            Open Dialog
          </TugPushButton>
        </div>
        <div style={resultStyle} data-testid="gallery-modal-input-dialog-result">
          Committed: <strong>{committed}</strong>
        </div>
        <div style={resultStyle} data-testid="gallery-modal-input-dialog-scope">
          Scope: <strong>{scope}</strong>
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">What to check</TugLabel>
        <div style={labelStyle}>
          A mouse pick in the chooser's dropdown lands and leaves the dialog up
          — that is the interaction Radix's modal treatment most nearly breaks.
          ⌥⇥ engages keyboard focus mode over the dialog's own stops (input,
          chooser field, Browse…), never the card behind it.
        </div>
      </div>

      {open && (
        <ModalInputDialog
          placeholder="Open Quickly (gallery fixture)"
          provider={fixtureProvider}
          header={<ChooserHeader value={scope} onChange={setScope} />}
          dismissOnOutsideClick
          onCommit={(item) => {
            setCommitted(item.label);
            setOpen(false);
          }}
          onDismiss={() => setOpen(false)}
        />
      )}
    </div>
  );
}
