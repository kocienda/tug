/**
 * gallery-tug-editor-context-menu.tsx — `TugEditorContextMenu` demo tab for
 * the Component Gallery.
 *
 * Right-click the target to open the menu at the pointer. The entries show
 * the three kinds — items (with icons, shortcuts and a disabled one),
 * separators and section labels. Items dispatch to the parent responder;
 * this card handles none, so a choice only closes the menu.
 *
 * @module components/tugways/cards/gallery-tug-editor-context-menu
 */

import React, { useCallback, useState } from "react";
import { Clipboard, Copy, Scissors } from "lucide-react";

import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { TugLabel } from "@/components/tugways/tug-label";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { commandShortcut } from "@/components/tugways/keymap-registry";

const ITEMS: TugEditorContextMenuEntry[] = [
  { type: "label", label: "Edit" },
  { action: TUG_ACTIONS.CUT, label: "Cut", icon: <Scissors size={14} aria-hidden="true" />, shortcut: commandShortcut(TUG_ACTIONS.CUT) },
  { action: TUG_ACTIONS.COPY, label: "Copy", icon: <Copy size={14} aria-hidden="true" />, shortcut: commandShortcut(TUG_ACTIONS.COPY) },
  { action: TUG_ACTIONS.PASTE, label: "Paste", icon: <Clipboard size={14} aria-hidden="true" />, disabled: true },
  { type: "separator" },
  { action: TUG_ACTIONS.SELECT_ALL, label: "Select All" },
];

const targetStyle: React.CSSProperties = {
  width: "320px",
  height: "120px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px dashed var(--tug7-element-global-border-normal-default-rest)",
  borderRadius: "6px",
};

export function GalleryTugEditorContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  const onClose = useCallback(() => setAt(null), []);

  return (
    <div className="cg-content" data-testid="gallery-tug-editor-context-menu">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Items, separator, section label</TugLabel>
        <div style={targetStyle} onContextMenu={onContextMenu}>
          <TugLabel size="2xs" emphasis="calm">Right-click here</TugLabel>
        </div>
        <TugEditorContextMenu open={at !== null} x={at?.x ?? 0} y={at?.y ?? 0} items={ITEMS} onClose={onClose} />
      </div>
    </div>
  );
}
