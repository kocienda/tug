/**
 * SessionChangesNotesEditor — the release notes, edited where they are listed.
 *
 * A release's notes are the one file in a release round whose content is the
 * user's to write, and before this the only way to write them was to open a
 * Text card beside the shade that was already showing the file's diff. So the
 * row itself becomes the editor: the Changes shade hands `TugChangesList` a
 * `fileEditor` for `release-notes/*.md`, and when the row's pencil is pressed
 * this component takes the expanded body in the diff's place ([P08]).
 *
 * It owns exactly one `TextCardStore` in **automatic** mode — the same engine
 * the Text card runs — so autosave, the disk watcher's external-change revert,
 * and the conflict verdict all arrive without a second implementation. The
 * store is the external state and it enters React through
 * `useSyncExternalStore` ([L02]); CM6 owns the buffer text and nothing about it
 * is ever React state ([L24]).
 *
 * Unmount flushes before disposing, with `keepalive`, so folding the row shut
 * mid-debounce writes the last keystrokes rather than dropping them.
 *
 * **The conflict notice is a `TugInlineAlert`, not a `TugPaneBanner`.** The
 * banner portals into the card and sets `inert` on `.tug-pane-body` with no
 * refcount, and the Session card already renders exactly one derived banner —
 * a second one would reproduce the interference that card's comment documents,
 * and would inert its own footer besides, since this body lives *inside* the
 * pane body. A row-scoped verdict wants a row-scoped notice.
 *
 * Laws: [L02] store state via `useSyncExternalStore`, [L06] appearance via CSS,
 *       [L24] state zones, [L26] mount-on-expand.
 */

import "./session-changes-notes-editor.css";

import React, { useLayoutEffect, useState, useSyncExternalStore } from "react";

import { TextCardStore } from "@/lib/text-card-store";
import { describeFileReadError } from "@/lib/file-read-error-copy";
import { DEFAULT_TEXT_CARD_SETTINGS } from "@/lib/text-card-settings";
import { TugTextCardEditor } from "@/components/tugways/tug-text-card-editor";
import { TugInlineAlert } from "@/components/tugways/tug-inline-alert";
import { TugPushButton } from "@/components/tugways/tug-push-button";

/** What the status footer says for each autosave sub-state. */
const SAVE_WORD = {
  clean: "Saved",
  editing: "Editing…",
  writing: "Writing…",
} as const;

export function SessionChangesNotesEditor({
  path,
}: {
  /** Absolute path of the notes file — `<project_dir>/<row path>`. */
  path: string;
}): React.ReactElement {
  // One engine per mounted editor. Disk is authoritative, so a remount simply
  // re-reads the file — there is nothing to carry across.
  const [store] = useState(() => new TextCardStore({ saveMode: "automatic" }));
  // The open is a registration the editor's mount depends on, so it runs in a
  // layout effect ([L03]); the cleanup flushes before disposing so a fold shut
  // mid-debounce still writes.
  useLayoutEffect(() => {
    void store.openPath(path);
    return () => {
      void store.flush({ keepalive: true });
      store.dispose();
    };
  }, [store, path]);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <div
      className="session-changes-notes-editor"
      data-slot="session-changes-notes-editor"
      data-save-state={snap.saveState}
      data-testid="session-changes-notes-editor"
    >
      {snap.conflict !== null ? (
        <TugInlineAlert
          className="session-changes-notes-editor-conflict"
          tone="caution"
          title={
            snap.conflict.reason === "missing" ? "File deleted" : "File changed"
          }
          message={
            snap.conflict.reason === "missing"
              ? "These notes were deleted on disk. Your edits are held here until you close the row."
              : "These notes changed on disk while you were editing."
          }
          actions={
            <>
              <TugPushButton
                size="xs"
                data-testid="session-changes-notes-reload"
                onClick={() => {
                  void store.resolveConflict("reload");
                }}
              >
                Reload from disk
              </TugPushButton>
              <TugPushButton
                size="xs"
                role="danger"
                data-testid="session-changes-notes-overwrite"
                onClick={() => {
                  void store.resolveConflict("overwrite");
                }}
              >
                Keep mine
              </TugPushButton>
            </>
          }
        />
      ) : null}
      {snap.phase === "ready" ? (
        <TugTextCardEditor
          className="session-changes-notes-editor-editor"
          store={store}
          languageExt="md"
          readOnly={snap.readOnly}
          settings={{
            ...DEFAULT_TEXT_CARD_SETTINGS,
            lineNumbers: false,
            lineWrap: true,
          }}
        />
      ) : snap.phase === "error" ? (
        <div
          className="session-changes-notes-editor-message"
          data-testid="session-changes-notes-editor-error"
        >
          {describeFileReadError(snap.error?.kind ?? "internal", snap.error?.size)}
        </div>
      ) : (
        <div className="session-changes-notes-editor-message">Opening…</div>
      )}
      <div
        className="session-changes-notes-editor-status"
        data-testid="session-changes-notes-editor-status"
      >
        {SAVE_WORD[snap.saveState]}
      </div>
    </div>
  );
}
