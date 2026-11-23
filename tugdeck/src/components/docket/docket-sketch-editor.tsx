/**
 * docket-sketch-editor.tsx — the Docket card's sketch editor and its reader.
 *
 * **The editor** shows a sketch's latest text in a textarea, says which
 * version it is and who wrote it, and keeps what the user types as a new
 * version written by them. Save sends `sketch_edit` with the version the
 * draft was opened on; when the sketch has moved since, the refusal's
 * sentence is shown and the draft is kept, so nothing typed is lost. Older
 * versions open in the reader from the versions popup.
 *
 * **The reader** shows one kept text — an older sketch version, or a brief
 * version's snapshot — read-only, with a way back to the threads.
 *
 * Both are views of the card: the card owns which one is showing and the
 * sender the asks go through; the draft and the save's line are this
 * component's local data ([L24]). The versions popup's items are vocabulary
 * actions the card's responder carries out ([L30]).
 *
 * @module components/docket/docket-sketch-editor
 */

import React, { useCallback, useState } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugPopupButton, type TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTextarea } from "@/components/tugways/tug-textarea";
import { keptVersionRef } from "@/lib/docket-authoring";
import type { DocketVerbs } from "@/lib/docket-verbs";
import type { SketchVersionRow } from "@/protocol";

/** The line said when a save goes unanswered. */
export const UNANSWERED_SAVE_LINE = "Tug did not answer — the sketch was not saved";

/** "written by you" or "written by the model". */
export function authorWords(author: SketchVersionRow["author"] | undefined): string {
  return author === "user" ? "written by you" : "written by the model";
}

export interface DocketSketchEditorProps {
  projectDir: string;
  sketchId: string;
  /** The version the draft was opened on; Save is refused when it is no longer the latest. */
  baseVersion: number;
  /** The text of that version. */
  text: string;
  /** Every kept version, as `sketch_read` listed them. */
  versions: readonly SketchVersionRow[];
  /** The card's sender, or null when it has none. */
  verbs: DocketVerbs | null;
  /** Back to the threads: after a save, or on Cancel. */
  onDone: () => void;
}

export function DocketSketchEditor({
  projectDir,
  sketchId,
  baseVersion,
  text,
  versions,
  verbs,
  onDone,
}: DocketSketchEditorProps): React.ReactElement {
  const [draft, setDraft] = useState(text);
  const [line, setLine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const author = versions.find((v) => v.n === baseVersion)?.author;
  const older = versions.filter((v) => v.n !== baseVersion).sort((a, b) => b.n - a.n);
  const versionItems: TugPopupButtonItem<string>[] = older.map((v) => ({
    action: TUG_ACTIONS.READ_SKETCH_VERSION,
    value: keptVersionRef(sketchId, v.n),
    label: `v${v.n} · ${authorWords(v.author)}`,
  }));

  const save = useCallback((): void => {
    if (saving) return;
    if (verbs === null) {
      setLine(UNANSWERED_SAVE_LINE);
      return;
    }
    setSaving(true);
    setLine(null);
    void verbs
      .sketchEdit({ projectDir, id: sketchId, text: draft, baseVersion })
      .then((result) => {
        setSaving(false);
        if (result.kind === "ok") onDone();
        else if (result.kind === "refused") setLine(result.message);
        else setLine(UNANSWERED_SAVE_LINE);
      });
  }, [saving, verbs, projectDir, sketchId, draft, baseVersion, onDone]);

  return (
    <div className="docket-sketch-editor" data-slot="docket-sketch-editor">
      <div className="docket-sketch-editor-head">
        <span className="docket-sketch-version" data-slot="docket-sketch-version">
          {`v${baseVersion} · ${authorWords(author)}`}
        </span>
        {versionItems.length > 0 ? (
          <TugPopupButton
            size="sm"
            label="Versions"
            items={versionItems}
            data-testid="docket-sketch-versions"
          />
        ) : null}
      </div>
      <TugTextarea
        className="docket-sketch-text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={14}
        aria-label="Sketch text"
        data-testid="docket-sketch-text"
      />
      {line !== null ? (
        <div className="docket-filing-line" data-slot="docket-sketch-line" role="status">
          {line}
        </div>
      ) : null}
      <div className="docket-sketch-editor-actions">
        <TugPushButton
          size="sm"
          emphasis="ghost"
          data-testid="docket-sketch-cancel"
          onClick={() => onDone()}
        >
          Cancel
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="outlined"
          disabled={saving || draft === text}
          data-testid="docket-sketch-save"
          onClick={save}
        >
          Save
        </TugPushButton>
      </div>
    </div>
  );
}

export interface DocketReaderProps {
  /** What is being read: "Sketch v2 · written by the model", "Brief v1". */
  title: string;
  text: string;
  onDone: () => void;
}

/** One kept text, read-only. */
export function DocketReader({ title, text, onDone }: DocketReaderProps): React.ReactElement {
  return (
    <div className="docket-reader" data-slot="docket-reader">
      <div className="docket-sketch-editor-head">
        <span className="docket-sketch-version" data-slot="docket-reader-title">
          {title}
        </span>
        <TugPushButton size="sm" emphasis="ghost" data-testid="docket-reader-back" onClick={() => onDone()}>
          Back
        </TugPushButton>
      </div>
      <pre className="docket-reader-text" data-slot="docket-reader-text">
        {text}
      </pre>
    </div>
  );
}
