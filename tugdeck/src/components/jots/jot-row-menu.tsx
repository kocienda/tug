/**
 * `useJotRowMenu` — the menu a jot row answers a right-click with.
 *
 * A jot is a passage of text the user parked somewhere, and until this the one
 * surface in the suite made entirely of kept text was the one surface with no
 * text verbs on it: a press on a row fell through to the app's "No Actions"
 * ([D132] — the same hole `useFileIdentityMenu` and `useSessionIdentityMenu`
 * closed on their mastheads). The row carries a Copy accessory, but it is a
 * hover reveal and it is one verb; a reader who wants the text out, or a
 * different text in, had to open the editor to get at the clipboard.
 *
 *   Edit Jot
 *   ─────
 *   Cut / Copy / Copy as Plain Text / Paste
 *   ─────
 *   New Jot / Delete Jot
 *
 * **Every item acts on the whole jot**, because a display row holds no
 * selection to act on part of one — the incipit is rendered markdown, the rest
 * of the text is not on screen at all. So there is no `hasSelection` sample
 * here and no {@link buildTextEditingMenuItems}: that builder's items mean
 * "the selection", and four of them (Look Up in Dictionary, Paste as Quote,
 * Paste as Plain Text, Select All) name acts a row cannot perform. The four
 * that survive keep their standard labels, their standard order, and their
 * live chords read off the binding ([P11]), so the words mean here what they
 * mean everywhere else — they simply name the jot rather than a range inside
 * it.
 *
 * What each one does to the jot:
 *  - **Copy** is the accessory's copy exactly — text, atoms, and the jot's own
 *    origins, so a chip copied out of a row pastes back into a Tug editor as
 *    that chip and a citation keeps the project it was read against.
 *  - **Copy as Plain Text** strips the markdown, as it does on every other
 *    surface. The origins still ride: they are provenance, not atoms, and
 *    dropping them would break links that worked a moment ago.
 *  - **Cut** is Copy and then the delete, and it raises no confirm — the row's
 *    ✕ asks because the words would be gone, and after a Cut they are on the
 *    clipboard and ⌘Z is still there. **Delete Jot** raises the same confirm
 *    the ✕ does, because it is the same act.
 *  - **Paste** REPLACES this jot's text with the clipboard's, atoms and all,
 *    and folds the clipboard's origins into the jot's own. A jot is a slot the
 *    user keeps something in, so a paste onto one is a re-fill.
 *
 * `TugEditorContextMenu` rather than the Radix-backed `TugContextMenu`, for the
 * reason every menu that writes the clipboard takes it: its items run inside
 * the mousedown and it moves no focus, so a copy from a row cannot take the key
 * view away from the list the reader is arrowing through.
 *
 * ONE menu serves every row, held by the card beside the one delete confirm
 * that already does — the target is the jot the press landed on, so a menu per
 * row would be as many idle portals as there are jots.
 *
 * Laws: [L07] the open target is read from a ref at dispatch time, never
 *       closed over; [L11] items are typed actions dispatched to this hook's
 *       own responder, never callbacks reaching around the chain;
 *       [L22] the open point is view-scope local state.
 *
 * @module components/jots/jot-row-menu
 */

import React from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { commandShortcut } from "@/components/tugways/keymap-registry";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { parseClipboardSidecar } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { copyAtomTextWithOrigins, formatAtomTextForCopy } from "@/lib/atom-text";
import { jotAtomSegments, type Jot, type JotAtom } from "@/lib/jots-doc";
import { stripMarkdown } from "@/lib/paste-transforms";
import {
  hasNativeClipboardBridge,
  readClipboardViaNative,
} from "@/lib/tug-native-clipboard";

/** What a Paste puts into the jot it landed on. */
export interface JotRowMenuPaste {
  /** The clipboard's text, with `U+FFFC` at each atom position. */
  text: string;
  /** The atoms standing in it, in the jot document's own shape. */
  atoms: JotAtom[];
  /** The roots the pasted text was read against, to fold into the jot's. */
  origins: readonly string[];
}

/** The verbs the card performs on the hook's behalf — everything that needs
 *  the store, the list cursor, or the delete confirm, none of which a menu
 *  should reach for itself. */
export interface JotRowMenuOptions {
  /** Open the row's in-place editor on this jot. */
  onEdit: (jot: Jot) => void;
  /** Make a jot directly after this one and open it. */
  onCreateBelow: (jot: Jot) => void;
  /** Raise the delete confirm over this jot's row — the ✕'s own route. */
  onRequestDelete: (jot: Jot) => void;
  /** Delete outright, with no confirm: Cut's second half. */
  onDelete: (jot: Jot) => void;
  /** Replace this jot's text with what the clipboard held. */
  onReplace: (jot: Jot, paste: JotRowMenuPaste) => void;
  /** The menu dismissed, however it dismissed — for the row's paint. */
  onClose?: () => void;
}

export interface JotRowMenuResult {
  /** Render inside the card; holds the menu portal. Null with no chain. */
  menu: React.ReactNode;
  /** Open over `jot` at a viewport point — the right-click path. */
  openAt: (jot: Jot, x: number, y: number) => void;
}

/**
 * The clipboard as a jot would keep it, or null when it holds nothing this
 * card can take.
 *
 * The native bridge first, for the reason every read in the suite prefers it:
 * it is the one popup-free path inside Tug.app, and it is the only one that
 * can carry the Tug-private atom sidecar past WebKit's pasteboard
 * normalization. Outside the app, `readText` — a browser paste is plain text
 * and honestly so.
 */
async function readClipboardForJot(): Promise<JotRowMenuPaste | null> {
  if (hasNativeClipboardBridge()) {
    const { text, atoms } = await readClipboardViaNative();
    const sidecar = atoms !== "" ? parseClipboardSidecar(atoms) : null;
    if (sidecar !== null) {
      return {
        text: sidecar.text,
        // The sidecar's positioned entries, in the jot document's own atom
        // shape (`tugcast/src/jots.rs`'s `JotAtom`): the same five fields,
        // with the segment flattened out of its envelope.
        atoms: sidecar.atoms.map((entry) => ({
          position: entry.position,
          type: entry.segment.type,
          label: entry.segment.label,
          value: entry.segment.value,
          ...(entry.segment.id !== undefined ? { id: entry.segment.id } : {}),
        })),
        origins: sidecar.origins ?? [],
      };
    }
    return text === "" ? null : { text, atoms: [], origins: [] };
  }
  const readText = navigator.clipboard?.readText;
  if (readText === undefined) return null;
  const text = await readText.call(navigator.clipboard).catch(() => "");
  return text === "" ? null : { text, atoms: [], origins: [] };
}

/** The jot's text as the clipboard's `text/plain` flavor — atoms spelled the
 *  way {@link formatAtomTextForCopy} spells them everywhere else. */
function jotPlainText(jot: Jot): string {
  return formatAtomTextForCopy(jot.text, jotAtomSegments(jot));
}

export function useJotRowMenu({
  onEdit,
  onCreateBelow,
  onRequestDelete,
  onDelete,
  onReplace,
  onClose,
}: JotRowMenuOptions): JotRowMenuResult {
  const manager = useResponderChain();
  const [target, setTarget] = React.useState<{
    jot: Jot;
    x: number;
    y: number;
  } | null>(null);

  // The open target, read at dispatch time rather than closed over ([L07]):
  // the menu's items are built once and the handlers outlive the render that
  // opened them.
  const targetRef = React.useRef<Jot | null>(null);
  targetRef.current = target?.jot ?? null;

  const closeMenu = React.useCallback((): void => {
    setTarget(null);
    onClose?.();
  }, [onClose]);

  const openAt = React.useCallback(
    (jot: Jot, x: number, y: number): void => {
      if (manager === null) return;
      setTarget({ jot, x, y });
    },
    [manager],
  );

  const responderId = React.useId();
  // The handlers are two-phase where the act is visible ([TugEditorContextMenu]
  // runs the sync body inside the gesture and the continuation after the item's
  // blink): the clipboard WRITE has to happen in the gesture, and the read has
  // to be STARTED in it, but the row appearing, opening, or vanishing is what
  // the reader should see second.
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.EDIT_JOT]: () => {
        const jot = targetRef.current;
        if (jot === null) return;
        return () => onEdit(jot);
      },
      [TUG_ACTIONS.NEW_JOT_BELOW]: () => {
        const jot = targetRef.current;
        if (jot === null) return;
        return () => onCreateBelow(jot);
      },
      [TUG_ACTIONS.DELETE_JOT]: () => {
        const jot = targetRef.current;
        if (jot === null) return;
        return () => onRequestDelete(jot);
      },
      [TUG_ACTIONS.COPY]: () => {
        const jot = targetRef.current;
        if (jot === null || jot.text === "") return;
        void copyAtomTextWithOrigins(
          jot.text,
          jotAtomSegments(jot),
          jotPlainText(jot),
          jot.origins ?? [],
        );
      },
      [TUG_ACTIONS.COPY_AS_PLAIN_TEXT]: () => {
        const jot = targetRef.current;
        if (jot === null || jot.text === "") return;
        // No atoms on the write — the plain variant carries none, by the
        // action's own definition. The ORIGINS still ride: they say which
        // project the sentence was read against, which is as true of stripped
        // text as of marked-up text.
        const plain = stripMarkdown(jotPlainText(jot));
        void copyAtomTextWithOrigins(plain, [], plain, jot.origins ?? []);
      },
      [TUG_ACTIONS.CUT]: () => {
        const jot = targetRef.current;
        if (jot === null || jot.text === "") return;
        // Write inside the gesture, delete after the blink — the shape every
        // Cut in the suite takes, so the reader sees the item flash before the
        // row it names goes away.
        void copyAtomTextWithOrigins(
          jot.text,
          jotAtomSegments(jot),
          jotPlainText(jot),
          jot.origins ?? [],
        );
        return () => onDelete(jot);
      },
      [TUG_ACTIONS.PASTE]: () => {
        const jot = targetRef.current;
        if (jot === null) return;
        // Started in the gesture, resolved after it: a read begun later has no
        // transient activation to spend and the browser path would refuse.
        const read = readClipboardForJot();
        return () => {
          void read.then((paste) => {
            if (paste !== null) onReplace(jot, paste);
          });
        };
      },
    },
  });

  const items = React.useMemo<TugEditorContextMenuEntry[]>(() => {
    const jot = target?.jot;
    if (jot === undefined) return [];
    // A jot with nothing written in it has nothing to take out of it. The item
    // stays and dims rather than vanishing, so the menu is the same height over
    // every row and the reader learns the verb exists.
    const blank = jot.text === "";
    const row = (
      action: (typeof TUG_ACTIONS)[keyof typeof TUG_ACTIONS],
      label: string,
      disabled = false,
    ): TugEditorContextMenuEntry => {
      // The chord the command is actually bound to, never an authored string
      // ([P11]) — the row verbs below name no chord because none is a binding:
      // ⏎, Space and ⌫ are the list's key-view keys, which the keymap does not
      // hold and the user cannot rebind.
      const shortcut = commandShortcut(action);
      return {
        action,
        label,
        ...(shortcut !== undefined ? { shortcut } : {}),
        ...(disabled ? { disabled: true } : {}),
      };
    };
    return [
      { action: TUG_ACTIONS.EDIT_JOT, label: "Edit Jot" },
      { type: "separator" },
      row(TUG_ACTIONS.CUT, "Cut", blank),
      row(TUG_ACTIONS.COPY, "Copy", blank),
      row(TUG_ACTIONS.COPY_AS_PLAIN_TEXT, "Copy as Plain Text", blank),
      row(TUG_ACTIONS.PASTE, "Paste"),
      { type: "separator" },
      { action: TUG_ACTIONS.NEW_JOT_BELOW, label: "New Jot" },
      { action: TUG_ACTIONS.DELETE_JOT, label: "Delete Jot" },
    ];
  }, [target]);

  // Inside this hook's own scope, so the menu's targeted dispatch lands on the
  // responder above rather than on the card around it. The responder's element
  // is the menu's own host — a leaf nothing focuses, which is what keeps ⌘C in
  // the jots list from resolving to "copy whatever the pointer last touched".
  const menu =
    manager !== null ? (
      <ResponderScope>
        <span ref={responderRef} data-slot="jot-row-menu">
          <TugEditorContextMenu
            open={target !== null}
            x={target?.x ?? 0}
            y={target?.y ?? 0}
            items={items}
            onClose={closeMenu}
          />
        </span>
      </ResponderScope>
    ) : null;

  return { menu, openAt };
}
