/**
 * gallery-tug-text-card-editor.tsx — `TugTextCardEditor` demo tab for the
 * Component Gallery.
 *
 * The editor is driven by a `TextCardStore`. The demo's store is never
 * bound to a file, so it saves nothing: edits are the buffer's alone. A
 * sample document is put into each view once it mounts. Shown with the
 * default settings, with the gutters and wrap off and invisibles on, and
 * read-only.
 *
 * @module components/tugways/cards/gallery-tug-text-card-editor
 */

import React, { useLayoutEffect, useRef, useState } from "react";

import {
  TugTextCardEditor,
  type TugTextCardEditorDelegate,
} from "@/components/tugways/tug-text-card-editor";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TextCardStore } from "@/lib/text-card-store";
import { DEFAULT_TEXT_CARD_SETTINGS, type TextCardSettings } from "@/lib/text-card-settings";

const SAMPLE = [
  "export function clamp(value: number, min: number, max: number): number {",
  "\t// A tab-indented comment, long enough that soft-wrap has something to do with it.",
  "  return Math.min(max, Math.max(min, value));",
  "}",
  "",
].join("\n");

const PLAIN: TextCardSettings = {
  ...DEFAULT_TEXT_CARD_SETTINGS,
  lineNumbers: false,
  foldGutter: false,
  lineWrap: false,
  showSpaces: true,
  showTabs: true,
};

/** One editor over its own unbound store, seeded once at mount. */
function SampleEditor({ settings, readOnly }: { settings?: TextCardSettings; readOnly?: boolean }) {
  const [store] = useState(() => new TextCardStore());
  const editorRef = useRef<TugTextCardEditorDelegate | null>(null);
  useLayoutEffect(() => {
    const view = editorRef.current?.view();
    if (view && view.state.doc.length === 0) view.dispatch({ changes: { from: 0, insert: SAMPLE } });
    return () => store.dispose();
  }, [store]);
  return (
    <div style={{ height: "140px", maxWidth: "560px", display: "flex" }}>
      <TugTextCardEditor ref={editorRef} store={store} settings={settings} readOnly={readOnly} languageExt="ts" />
    </div>
  );
}

export function GalleryTugTextCardEditor() {
  return (
    <div className="cg-content" data-testid="gallery-tug-text-card-editor">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Default settings</TugLabel>
        <SampleEditor />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">No gutters, no wrap, invisibles shown</TugLabel>
        <SampleEditor settings={PLAIN} />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">readOnly</TugLabel>
        <SampleEditor readOnly />
      </div>
    </div>
  );
}
