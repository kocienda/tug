/**
 * The annotation kind registry — what each entity kind *does*.
 *
 * This is the library's central promise: the transcript owns one
 * delegated click listener and one context-menu provider, and both ask
 * the registry what to do with whatever annotation the gesture landed on.
 * Adding an entity kind is therefore a detector plus an entry here, with
 * no edit to any transcript, cell, or menu surface.
 *
 * Three things a kind declares:
 *
 *  - `primaryClick` — what a plain click does, or nothing at all. URLs
 *    and email addresses deliberately have none: they are real anchors,
 *    and native navigation (routed to the system browser by the host's
 *    navigation delegate) is already the correct behavior. Intercepting
 *    it in JS would be regression risk for no gain.
 *  - `menuEntries` + `suppressStandardItems` — what a right-click offers,
 *    and whether those items *replace* the standard text-menu block or
 *    sit below it. Commands replace it: a selection-scoped Copy beside
 *    Copy-the-command would copy whatever sub-word the browser
 *    smart-selected, which is never what the user meant. Kinds whose
 *    entries don't collide with Copy append instead, so right-clicking an
 *    annotation inside a selection keeps Copy and Select All.
 *  - `wholeEntitySelection` — whether a secondary click may leave a
 *    sub-word highlighted inside the annotation. Commands say no: the
 *    browser's smart-select would paint a word the menu has no item for.
 *
 * @see module:components/tugways/use-text-surface-context-menu for where
 * the last of those is honored.
 *
 * @module lib/annotator/registry
 */

import type { TugAction } from "@/components/tugways/action-vocabulary";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";
import { openUrlInOS, revealDirectoryInFinder } from "@/lib/os-open";
import { openAttachmentPreview } from "@/lib/attachment-preview-open";
import { atomSegmentFor } from "./atom-segment";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type { AnnotationPayload } from "./payloads";
import type { AnnotationKind } from "./types";

/**
 * One context-menu item a kind contributes. Structurally the action-item
 * shape `TugEditorContextMenu` renders; the action stays typed against
 * the vocabulary so a misspelling is a compile error at the entry
 * definition rather than a dead dispatch at runtime ([L11]).
 */
export interface AnnotationMenuEntry {
  action: TugAction;
  label: string;
  /**
   * The `ActionEvent.value` the item's dispatch carries. An entry that
   * names what it acts on fills this in from the payload it was built
   * for, so the action reaches whichever responder implements it
   * instead of stopping at a host that only knows how to re-send it.
   */
  value?: unknown;
  /**
   * Present but non-interactive. An item a surface cannot perform *right
   * now* is dimmed rather than dropped: a menu whose height changes with
   * the entity's state is a menu whose items move under the pointer
   * between one right-click and the next. An item a surface can never
   * perform is absent instead, which is a different thing — what stays
   * constant per surface is the menu, and a permanently dead row is not
   * information.
   */
  disabled?: boolean;
  /** Rule above this item. Separators carry no action and no label. */
  separatorBefore?: boolean;
}

/**
 * The live facts a surface knows that an annotation payload cannot carry.
 *
 * A payload is what survived a trip through the DOM: a sha, a session id, a
 * path. Whether a card already holds that session, whether another process
 * has it, whether this row's detail is folded — none of that is a property
 * of the entity, and all of it decides what the menu may offer. So the
 * surface supplies it, and the registry stays the only place the item list
 * and its order are stated.
 *
 * Discriminated by kind so a kind reads only its own facts, and narrows
 * them without a cast. `{ kind: "none" }` is what the annotation path
 * passes: transcript ink and a composer atom know the entity and nothing
 * else about it, and every kind answers that with the items it can stand
 * behind knowing only the payload.
 */
export type AnnotationMenuFacts =
  | { kind: "none" }
  | {
      kind: "session";
      /** The card already showing this session, when one is. */
      openCardId: string | null;
      /** This menu is mounted in the session's own card — nothing to raise. */
      isOwnCard: boolean;
      /** Another process holds it; a resume would be a second claim. */
      heldElsewhere: boolean;
      /** The project a resume needs; empty until the ledger answers. */
      projectDir: string;
      /** The full description, `undefined` on a surface that carries none. */
      description?: string | null;
      /** The newest beat, `undefined` on a surface with no activity feed. */
      activity?: string | null;
    }
  | {
      kind: "commit-sha";
      /** The row folds, and the item states which way it would move. */
      expanded?: boolean;
      /** The surface holds the subject and the whole record, not just a sha. */
      hasRecord: boolean;
      /** The surface can open a diff scoped to this commit. */
      canOpenDiff: boolean;
    };

/**
 * What a registry handler is allowed to reach. Deliberately narrow: the
 * card-activation gesture as a thunk (the caller already knows which card
 * it is) and the session store a command seeds into. A kind that needs
 * more says so by widening this, which keeps the blast radius of a new
 * capability visible.
 */
export interface AnnotationDispatchContext {
  /** Bring the annotation's own card forward before acting on it. */
  activateCard: () => void;
  /** The prompt/transcript store a command or snippet is seeded into.
   *  Absent on a surface with no live session (the Overview): such a surface
   *  can't seed a prompt, so a command's click is a no-op there — the same
   *  rule its menu already follows by dropping Insert into Prompt. */
  codeSessionStore?: CodeSessionStore;
}

/** The behavior registered for one annotation kind. */
export interface AnnotationKindEntry {
  /**
   * What a plain primary click does. Omitted when the DOM's own default
   * is already correct (anchors).
   */
  primaryClick?: (payload: AnnotationPayload, ctx: AnnotationDispatchContext) => void;
  /**
   * Context-menu items offered for an annotation of this kind, in the order
   * they are shown. `facts` carries what the surface knows and the payload
   * cannot; a kind that varies on nothing ignores it.
   */
  menuEntries: (
    payload: AnnotationPayload,
    facts: AnnotationMenuFacts,
  ) => AnnotationMenuEntry[];
  /**
   * Whether a menu hit on this kind replaces the standard text-menu block
   * rather than appending below it.
   */
  suppressStandardItems: boolean;
  /**
   * Whether a secondary click treats this annotation as one indivisible
   * thing. When true the surface stops the browser's smart-select on the
   * click, so a right-click on a command never leaves a sub-word
   * highlighted under a menu whose every item acts on the whole command.
   */
  wholeEntitySelection?: boolean;
}

const REGISTRY = new Map<AnnotationKind, AnnotationKindEntry>();

/** Register (or replace) the behavior for one annotation kind. */
export function registerAnnotationKind(
  kind: AnnotationKind,
  entry: AnnotationKindEntry,
): void {
  REGISTRY.set(kind, entry);
}

/** The behavior registered for `kind`, or `null` when none is. */
export function annotationEntryFor(
  kind: AnnotationKind,
): AnnotationKindEntry | null {
  return REGISTRY.get(kind) ?? null;
}

/**
 * Seed a command into the prompt as a ready-to-run draft: bring the
 * card forward, then park the draft. A slash command seeds itself; a
 * shell command seeds into the Code route as a one-shot `/shell <cmd>`.
 */
function seedCommand(
  payload: AnnotationPayload,
  ctx: AnnotationDispatchContext,
): void {
  const store = ctx.codeSessionStore;
  if (store === undefined) return;
  if (payload.kind === "slash-command") {
    ctx.activateCard();
    store.insertCommandDraft(payload.name, payload.args);
    return;
  }
  if (payload.kind === "shell-command") {
    ctx.activateCard();
    store.insertCommandDraft("shell", payload.command);
  }
}

/**
 * Send this annotation back into the conversation. Every kind offers it —
 * that is the point of having one vocabulary: whatever the transcript
 * mentions, the user can pick it up and talk about it. What lands in the
 * prompt is the handler's call, not a second menu item's: a file arrives
 * as the chip an `@` mention mints, everything else as its text.
 *
 * **The label says which of the two it will be.** An entity whose insert
 * mints an atom names it — `Insert Atom into Prompt` — and one that inserts
 * as text keeps the plain word, because a label that promised an atom over a
 * command line or an email address would be a lie the menu tells. The
 * predicate is `atomSegmentFor`, the same one the atom copy reads, so the two
 * items cannot disagree about what this entity is.
 */
function insertEntry(payload: AnnotationPayload): AnnotationMenuEntry {
  return {
    action: TUG_ACTIONS.INSERT_INTO_PROMPT,
    label:
      atomSegmentFor(payload) === null
        ? "Insert into Prompt"
        : "Insert Atom into Prompt",
  };
}

/**
 * The atom copy, offered exactly where the insert mints one — spread into a
 * kind's copy block so a kind promoted to atom-insert later picks the row up
 * with no menu edit of its own ([L31]: an item is offered only where it can
 * be performed). `Copy as <Format>` is the sanctioned shape for a different
 * serialization of one entity, which is what an atom is beside a path.
 */
function atomCopyEntries(payload: AnnotationPayload): AnnotationMenuEntry[] {
  return atomSegmentFor(payload) === null
    ? []
    : [{ action: TUG_ACTIONS.COPY_ANNOTATION_ATOM, label: "Copy as Atom" }];
}

/**
 * The pair both command families offer, and they name the noun like every
 * other kind's copy. A bare `Copy` is the standard editing block's word for
 * "the selection", and a command's menu replaces that block rather than
 * sitting beside it — so the two never appear together, but naming the noun
 * is what keeps one rule instead of one rule and an exception.
 */
const COMMAND_MENU_ENTRIES: AnnotationMenuEntry[] = [
  { action: TUG_ACTIONS.COPY_COMMAND, label: "Copy Command" },
  {
    action: TUG_ACTIONS.COPY_COMMAND_AS_PLAIN_TEXT,
    label: "Copy Command as Plain Text",
  },
];

const commandMenuEntries = (
  payload: AnnotationPayload,
): AnnotationMenuEntry[] => [...COMMAND_MENU_ENTRIES, insertEntry(payload)];

registerAnnotationKind("slash-command", {
  primaryClick: seedCommand,
  menuEntries: commandMenuEntries,
  suppressStandardItems: true,
  wholeEntitySelection: true,
});

registerAnnotationKind("shell-command", {
  primaryClick: seedCommand,
  menuEntries: commandMenuEntries,
  suppressStandardItems: true,
  wholeEntitySelection: true,
});

const urlMenuEntries = (payload: AnnotationPayload): AnnotationMenuEntry[] => [
  { action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Link" },
  ...atomCopyEntries(payload),
  insertEntry(payload),
];

const emailMenuEntries = (
  payload: AnnotationPayload,
): AnnotationMenuEntry[] => [
  { action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Address" },
  ...atomCopyEntries(payload),
  insertEntry(payload),
];

/**
 * The `{ path, line?, endLine? }` an open carries. A cited range wins
 * over a bare line, so both the click and the menu item land on (and
 * flash) exactly the lines the reference names.
 */
function openTargetFor(payload: AnnotationPayload): Record<string, unknown> | null {
  if (payload.kind !== "file-path") return null;
  const target: Record<string, unknown> = { path: payload.path };
  if (payload.line !== undefined) target.line = payload.line;
  if (payload.endLine !== undefined) target.endLine = payload.endLine;
  if (payload.columns !== undefined) target.columns = payload.columns;
  return target;
}

registerAnnotationKind("file-path", {
  primaryClick: (payload) => {
    const target = openTargetFor(payload);
    if (target === null) return;
    dispatchCommand(TUG_ACTIONS.OPEN_FILE, target);
  },
  // "Open in Editor" carries the same target the click sends, so both
  // gestures reach the deck-level open handler by the same route.
  //
  // A file is the kind the atom copy lands on first, and a second copy is
  // what makes this menu's block boundaries worth drawing: reach it, take
  // it, send it, with a rule between each. `menus.md` fixes that order.
  menuEntries: (payload) => [
    {
      action: TUG_ACTIONS.OPEN_FILE,
      label: "Open in Editor",
      value: openTargetFor(payload) ?? undefined,
    },
    { action: TUG_ACTIONS.REVEAL_IN_FINDER, label: "Show in Finder" },
    {
      action: TUG_ACTIONS.COPY_ANNOTATION_VALUE,
      label: "Copy Path",
      separatorBefore: true,
    },
    ...atomCopyEntries(payload),
    { ...insertEntry(payload), separatorBefore: true },
  ],
  suppressStandardItems: false,
});

registerAnnotationKind("url", {
  // Only reached for a url annotation that is NOT an anchor — a link chip
  // the user attached. A real anchor navigates itself, and the host's
  // navigation delegate routes it to the browser; the delegated listener
  // leaves those alone rather than opening them twice.
  primaryClick: (payload) => {
    if (payload.kind !== "url") return;
    openUrlInOS(payload.url);
  },
  menuEntries: urlMenuEntries,
  suppressStandardItems: false,
});

registerAnnotationKind("email", {
  menuEntries: emailMenuEntries,
  suppressStandardItems: false,
});

const directoryMenuEntries = (
  payload: AnnotationPayload,
): AnnotationMenuEntry[] => [
  { action: TUG_ACTIONS.REVEAL_IN_FINDER, label: "Show in Finder" },
  { action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Path" },
  ...atomCopyEntries(payload),
  insertEntry(payload),
];

registerAnnotationKind("directory", {
  // A directory has no editor to open into, so the click does what the
  // menu's first item does — the gesture and the menu agree, which is the
  // rule every other kind follows.
  primaryClick: (payload) => {
    if (payload.kind !== "directory") return;
    revealDirectoryInFinder(payload.path);
  },
  menuEntries: directoryMenuEntries,
  suppressStandardItems: false,
});

const imageMenuEntries = (payload: AnnotationPayload): AnnotationMenuEntry[] => [
  { action: TUG_ACTIONS.OPEN_IMAGE_PREVIEW, label: "Open Image" },
  { action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Name" },
  ...atomCopyEntries(payload),
  insertEntry(payload),
];

/**
 * A commit's menu — the same list wherever a commit is shown, with the rows
 * a surface cannot fill left out rather than dimmed forever.
 *
 * **The first copy is the one the app writes commits as.** `commit:<8>` is
 * what an atom, a receipt, and a line of transcript ink all say, so it leads
 * the copies and every other form is measured from it: the bare full hash for
 * a git argument, the header for a sentence, the record for a paste.
 *
 * Transcript ink and a receipt header know a sha and nothing else, so they
 * get the two forms a sha alone can stand behind. A History row holds the
 * subject and the whole record, and its facts say so. The fold leads when the
 * row has one, named in the direction it will move, so the menu never asks
 * the reader to recall the row's state.
 */
function commitMenuEntries(
  payload: AnnotationPayload,
  facts: AnnotationMenuFacts,
): AnnotationMenuEntry[] {
  const known = facts.kind === "commit-sha" ? facts : null;
  const entries: AnnotationMenuEntry[] = [];
  if (known?.expanded !== undefined) {
    entries.push({
      action: TUG_ACTIONS.TOGGLE_COMMIT_DETAIL,
      label: known.expanded ? "Hide Detail" : "Show Detail",
    });
  }
  // A sha alone can always open its diff; a surface that says it cannot —
  // a commit with no repository behind it — drops the row.
  if (known === null || known.canOpenDiff) {
    entries.push({
      action: TUG_ACTIONS.OPEN_DIFF,
      label: "Open Diff",
      ...(entries.length > 0 ? { separatorBefore: true } : {}),
    });
  }
  entries.push({
    action: TUG_ACTIONS.COPY_COMMIT_SHORT_HASH,
    label: "Copy Short Hash",
    ...(entries.length > 0 ? { separatorBefore: true } : {}),
  });
  entries.push({ action: TUG_ACTIONS.COPY_COMMIT_HASH, label: "Copy Full Hash" });
  if (known?.hasRecord === true) {
    entries.push(
      { action: TUG_ACTIONS.COPY_COMMIT_HEADER, label: "Copy Commit Header" },
      { action: TUG_ACTIONS.COPY_COMMIT_RECORD, label: "Copy Commit Record" },
    );
    return entries;
  }
  entries.push(insertEntry(payload));
  return entries;
}

registerAnnotationKind("commit-sha", {
  // The sha was verified by asking the repository which files the commit
  // touched, so the descriptor is already scoped to exactly those files —
  // the diff opens showing the commit, not the whole tree.
  primaryClick: (payload) => {
    if (payload.kind !== "commit-sha") return;
    dispatchCommand(TUG_ACTIONS.OPEN_DIFF, {
      descriptor: {
        kind: "commit",
        root: payload.root,
        sha: payload.sha,
        paths: payload.paths,
      },
    });
  },
  menuEntries: commitMenuEntries,
  suppressStandardItems: false,
});

/**
 * A session's menu — how to GET to the session, then the forms it can be
 * copied as, then the two runs only a row carries.
 *
 * **The first item is one item, not two.** A reader right-clicking a session
 * wants to reach it; whether that costs a raise or a resume is the app's
 * problem. So the row says which of the two it will be — Show Session when a
 * card already holds it, Resume Session when none does — and is absent only
 * where it could say nothing useful: on the session's own card, and on a
 * citation the ledger cannot resolve. Held by another process is DISABLED
 * rather than dropped: it is a real session, unresumable for a reason a
 * reader can act on.
 *
 * Description and Activity are dimmed when empty and absent when the surface
 * carries no such feed at all — a citation chip has no activity behind it,
 * and a permanently dead row is not information.
 */
function sessionMenuEntries(
  payload: AnnotationPayload,
  facts: AnnotationMenuFacts,
): AnnotationMenuEntry[] {
  const known = facts.kind === "session" ? facts : null;
  const entries: AnnotationMenuEntry[] = [];
  if (known !== null && !known.isOwnCard) {
    entries.push(
      known.openCardId !== null
        ? { action: TUG_ACTIONS.SHOW_SESSION, label: "Show Session" }
        : {
            action: TUG_ACTIONS.RESUME_SESSION,
            label: "Resume Session",
            disabled: known.heldElsewhere || known.projectDir.length === 0,
          },
    );
  }
  // The atom and the citation are written from the session's identity RECORD
  // — its callsign, its project, the sidecar a paste back into Tug rebuilds
  // the chip from. A surface holding the record writes both from its own
  // facts. A surface holding only the id writes neither from the payload, so
  // it is offered the citation not at all and the atom only through
  // `atomSegmentFor`, which resolves the identity for itself and answers
  // `null` when the ledger cannot. The id it can always write.
  if (known !== null) {
    entries.push({
      action: TUG_ACTIONS.COPY_SESSION_ATOM,
      label: "Copy as Atom",
      ...(entries.length > 0 ? { separatorBefore: true } : {}),
    });
    entries.push({
      action: TUG_ACTIONS.COPY_SESSION_CITATION,
      label: "Copy as Citation",
    });
  } else {
    // A surface holding only the id still offers the atom WHEN THE LEDGER CAN
    // ANSWER FOR IT: `atomSegmentFor` resolves the identity itself, so the
    // transcript's session ink is not stuck at the id the payload carries.
    // Without this row the ink would say `Insert Atom into Prompt` and offer
    // no way to take that atom, which is the one thing the rule forbids.
    entries.push(...atomCopyEntries(payload));
  }
  entries.push({
    action: TUG_ACTIONS.COPY_SESSION_ID,
    label: "Copy Session ID",
  });
  if (known?.description !== undefined) {
    entries.push({
      action: TUG_ACTIONS.COPY_SESSION_DESCRIPTION,
      label: "Copy Description",
      separatorBefore: true,
      disabled: (known.description ?? "").trim().length === 0,
    });
  }
  if (known?.activity !== undefined) {
    entries.push({
      action: TUG_ACTIONS.COPY_SESSION_ACTIVITY,
      label: "Copy Activity Line",
      ...(known.description === undefined ? { separatorBefore: true } : {}),
      disabled: (known.activity ?? "").trim().length === 0,
    });
  }
  entries.push({ ...insertEntry(payload), separatorBefore: true });
  return entries;
}

registerAnnotationKind("session", {
  // **No `primaryClick`, deliberately.** A confirmed session run is where the
  // live `TugSessionCitation` chip is portaled, and the chip owns its whole
  // gesture — the press, the hover, whether to offer one at all. A click
  // handler here would fire alongside it.
  //
  // The entry exists anyway so `annotationFromEvent` and the cell menu's
  // sampling see a HIT rather than a miss: a right-click on the run still
  // offers the session's own items, and an unregistered kind would offer
  // nothing while looking annotated.
  menuEntries: sessionMenuEntries,
  suppressStandardItems: false,
});

registerAnnotationKind("image", {
  // A pasted image is bytes under an id, with no file to open — the strip
  // that holds those bytes owns the only full-size view of it.
  primaryClick: (payload) => {
    if (payload.kind !== "image") return;
    openAttachmentPreview(payload.atomId);
  },
  menuEntries: imageMenuEntries,
  suppressStandardItems: false,
});
