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
 *
 * What a secondary click *selects* is not among them: every annotation is one
 * indivisible thing to a right-click, so the surface selects the whole of it
 * rather than the sub-word WebKit picked. That rule needs no per-kind opinion
 * — see `components/tugways/use-text-surface-context-menu`, where it lives.
 *
 * @module lib/annotator/registry
 */

import type { TugAction } from "@/components/tugways/action-vocabulary";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";
import { openUrlInOS, revealDirectoryInFinder } from "@/lib/os-open";
import { openAttachmentPreview } from "@/lib/attachment-preview-open";
import { atomSegmentFor } from "./atom-segment";

import type { PromptInsertTarget } from "@/lib/prompt-insert-target";
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
      /**
       * Whether a resume can actually be performed — `isSessionResumable`'s
       * answer, computed by the surface that holds the facts.
       *
       * The predicate rather than its inputs, so the rule lives in one place
       * (`lib/session-resume.ts`) and the surfaces that offer this gesture
       * cannot drift: a pill offering a resume the menu on that same pill
       * greys out is the failure this shape prevents.
       */
      resumable: boolean;
      /** The project a resume opens in; empty until the ledger answers. */
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
      /**
       * The surface can raise the commit's own card. False where there is no
       * repository behind the mention — the same drop `canOpenDiff` makes,
       * and for the same reason: a card with no root to read cannot resolve
       * the sha. Unset reads as TRUE, so a prose mention offers the item
       * without every caller having to say so.
       */
      canOpenCommit?: boolean;
    }
  | {
      kind: "slash-command";
      /**
       * A composer this surface could run the command in. False on a surface
       * showing commands with nowhere to send one, and the two runs are then
       * not offered at all.
       */
      hasComposer: boolean;
    };

/**
 * What a registry handler is allowed to reach. Deliberately narrow: the
 * composer a click sends the entity into, and nothing else. A kind that
 * needs more says so by widening this, which keeps the blast radius of a
 * new capability visible.
 */
export interface AnnotationDispatchContext {
  /**
   * The composer a command or snippet is seeded into — the same target the
   * surface's menu sends `Insert into Prompt` to, so a click and a menu pick
   * land in one place. It carries its own `raise`, which is why the card
   * activation this used to take separately is gone: bringing the receiving
   * composer forward is the target's business, and the Overview's answer to
   * it is a caret rather than a card.
   *
   * Absent on a surface with no composer to send to, and a click is then a
   * no-op there — the same rule its menu already follows by dropping Insert
   * into Prompt.
   */
  insertTarget?: PromptInsertTarget;
  /**
   * The card the clicked ink stands in, read off the DOM by whoever services
   * the click (`hostCardIdOf`). A kind that opens a card names it as the
   * open's origin, so the new card is placed from the card the reader clicked
   * in rather than from whichever card holds first responder. The responder
   * chain cannot answer this: `dispatchCommand` walks from the first
   * responder and its event carries no sender. Absent where the click has no
   * card around it.
   */
  hostCardId?: string;
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
  // A ready-to-run command draft is a session semantic — the Overview has no
  // commands to run — so a target that does not offer `insertCommand` is one
  // this click has nothing to do on.
  const target = ctx.insertTarget;
  if (target === undefined || target.insertCommand === undefined) return;
  if (payload.kind === "slash-command") {
    target.raise();
    target.insertCommand(payload.name, payload.args);
    return;
  }
  if (payload.kind === "shell-command") {
    target.raise();
    target.insertCommand("shell", payload.command);
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
 * One declared row, or nothing at all.
 *
 * A block states the rows a kind offers and lets the surface's facts turn one
 * off in place, so the declaration reads as the menu rather than as the
 * assembly of one: a row that is `null` or `false` is one this surface cannot
 * stand behind, and it takes its rule with it.
 */
type MenuRow = AnnotationMenuEntry | null | false | undefined;

/**
 * A block's contents: rows, and a nested array for a sub-group that takes a
 * rule of its own INSIDE the block. A session's Description and Activity Line
 * beneath its copies are the one live case — they are copies, and they are
 * fields of the surface's record rather than serializations of the entity.
 */
type MenuBlockDecl = ReadonlyArray<MenuRow | ReadonlyArray<MenuRow>>;

/**
 * A menu, declared as the blocks `tuglaws/menus.md` fixes the order of:
 * reach the thing, act on it, take it, say something about it.
 *
 * **No kind writes a `separatorBefore`.** A rule falls between two blocks that
 * both have rows, and whether an earlier block survived the surface's facts is
 * exactly what a kind cannot know when it declares its own. Hand-placing them
 * is how the grammar became a habit reviewers kept rather than an invariant
 * the code held — six kinds drew different rules for the same shape of menu,
 * and the atom seat drifted the same way.
 */
export interface EntityMenuBlocks {
  /** Reach it — Open in Editor, Open Commit, Show in Finder, Show Session. */
  goTo?: MenuBlockDecl;
  /** Act on it — Show / Hide Detail, a command's two runs. */
  act?: MenuBlockDecl;
  /** Take it. The atom row is prepended here; a kind never writes one. */
  copy?: MenuBlockDecl;
  /** Send it — the insert, whichever of the two labels it carries. */
  send?: MenuBlockDecl;
  /**
   * The action that writes this menu's atom, for a surface holding an
   * identity RECORD the payload cannot carry: a session row knows its
   * callsign and its project, so it writes an atom `atomSegmentFor` would
   * answer `null` for. Omitted everywhere else, where the payload decides
   * through that one predicate.
   */
  surfaceAtom?: TugAction;
}

/** `Copy as <Format>`, where the format is the entity itself. */
const ATOM_COPY_LABEL = "Copy as Atom";

const isRow = (row: MenuRow): row is AnnotationMenuEntry =>
  row !== null && row !== undefined && row !== false;

/** A block's surviving rows, split into the runs a rule falls between. */
function groupsOf(decl: MenuBlockDecl | undefined): AnnotationMenuEntry[][] {
  if (decl === undefined) return [];
  const groups: AnnotationMenuEntry[][] = [];
  let run: AnnotationMenuEntry[] = [];
  for (const item of decl) {
    if (Array.isArray(item)) {
      if (run.length > 0) groups.push(run);
      run = [];
      const sub = (item as ReadonlyArray<MenuRow>).filter(isRow);
      if (sub.length > 0) groups.push(sub);
      continue;
    }
    if (isRow(item as MenuRow)) run.push(item as AnnotationMenuEntry);
  }
  if (run.length > 0) groups.push(run);
  return groups;
}

/**
 * The atom copy, at the one seat it has on every kind that offers it: the
 * FIRST row of the copy block.
 *
 * The atom is the entity; every other copy is a projection of one of its
 * fields, so the object leads and the fields follow. It is the assembler's row
 * rather than a kind's, which is what makes the seat an invariant — a kind
 * promoted to atom-insert later inherits the row already in its place, and no
 * kind can seat it anywhere else ([L31]: an item is offered only where it can
 * be performed, which is what the predicate below still decides).
 */
function atomRowFor(
  payload: AnnotationPayload,
  surfaceAtom: TugAction | undefined,
): AnnotationMenuEntry | null {
  if (surfaceAtom !== undefined) {
    return { action: surfaceAtom, label: ATOM_COPY_LABEL };
  }
  return atomSegmentFor(payload) === null
    ? null
    : { action: TUG_ACTIONS.COPY_ANNOTATION_ATOM, label: ATOM_COPY_LABEL };
}

/**
 * Assemble one kind's menu from its blocks: the atom row prepended to the
 * copies, the blocks in the fixed order, and a rule between every two of them
 * that both survived.
 *
 * A menu never opens with a rule, because the first surviving group takes
 * none — the same case `entity-menu-items` guards one layer down, where it
 * still holds for the rows a consumer drops.
 */
export function buildEntityMenu(
  payload: AnnotationPayload,
  blocks: EntityMenuBlocks,
): AnnotationMenuEntry[] {
  const copy = groupsOf(blocks.copy);
  const atom = atomRowFor(payload, blocks.surfaceAtom);
  if (atom !== null) {
    const first = copy[0];
    if (first === undefined) copy.push([atom]);
    else copy[0] = [atom, ...first];
  }
  const groups = [
    ...groupsOf(blocks.goTo),
    ...groupsOf(blocks.act),
    ...copy,
    ...groupsOf(blocks.send),
  ];
  return groups.flatMap((group, block) =>
    group.map((entry, row) =>
      block > 0 && row === 0 ? { ...entry, separatorBefore: true } : entry,
    ),
  );
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
): AnnotationMenuEntry[] =>
  buildEntityMenu(payload, {
    copy: COMMAND_MENU_ENTRIES,
    send: [insertEntry(payload)],
  });

/**
 * A slash command's menu — the two ways to RUN it, then the ways to take it.
 *
 * A command line in the transcript is a thing to do, and until these rows
 * existed the only way to do it was to seed the composer and press send, or
 * to copy the line and rebuild it wherever you wanted it. So the runs lead:
 * Run in This Session sends it as this card's next turn, Run in New Session opens a card
 * beside this one on the same project and sends it there. The copy block is
 * unchanged and sits below a rule, which is the order every other kind's menu
 * takes — reach it, take it, send it.
 *
 * **An offered run is always live.** A surface with no composer cannot run
 * anything, so it does not offer the rows at all; every surface that offers
 * them can run them. Nothing about the command's arguments dims a row: the
 * reader asked for the run, and an argument the run cannot use is the run's
 * to report, not a reason to refuse the click. A surface that knows only the
 * payload (`{ kind: "none" }`) offers them, which is the can-stand-behind
 * form: it has been told nothing that would stop the run.
 *
 * The rows are general to every slash command rather than special-cased to
 * any one of them. `/arc` on a brief is the first customer, not the only one.
 */
const slashCommandMenuEntries = (
  payload: AnnotationPayload,
  facts: AnnotationMenuFacts,
): AnnotationMenuEntry[] => {
  const known = facts.kind === "slash-command" ? facts : null;
  const canRun = known === null || known.hasComposer;
  return buildEntityMenu(payload, {
    act: canRun
      ? [
          { action: TUG_ACTIONS.RUN_COMMAND_HERE, label: "Run in This Session" },
          {
            action: TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION,
            label: "Run in New Session",
          },
        ]
      : [],
    copy: COMMAND_MENU_ENTRIES,
    send: [insertEntry(payload)],
  });
};

registerAnnotationKind("slash-command", {
  primaryClick: seedCommand,
  menuEntries: slashCommandMenuEntries,
  suppressStandardItems: true,
});

registerAnnotationKind("shell-command", {
  primaryClick: seedCommand,
  menuEntries: commandMenuEntries,
  suppressStandardItems: true,
});

const urlMenuEntries = (payload: AnnotationPayload): AnnotationMenuEntry[] =>
  buildEntityMenu(payload, {
    copy: [{ action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Link" }],
    send: [insertEntry(payload)],
  });

const emailMenuEntries = (
  payload: AnnotationPayload,
): AnnotationMenuEntry[] =>
  buildEntityMenu(payload, {
    copy: [
      { action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Address" },
    ],
    send: [insertEntry(payload)],
  });

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
  primaryClick: (payload, ctx) => {
    const target = openTargetFor(payload);
    if (target === null) return;
    dispatchCommand(TUG_ACTIONS.OPEN_FILE, {
      ...target,
      ...(ctx.hostCardId !== undefined ? { originCardId: ctx.hostCardId } : {}),
    });
  },
  // "Open in Editor" carries the same target the click sends, so both
  // gestures reach the deck-level open handler by the same route.
  //
  // A file is the kind the atom copy lands on first, and a second copy is
  // what makes this menu's block boundaries worth drawing: reach it, take
  // it, send it, with a rule between each. The assembler draws those rules
  // from the blocks below; `menus.md` fixes their order.
  menuEntries: (payload) =>
    buildEntityMenu(payload, {
      goTo: [
        {
          action: TUG_ACTIONS.OPEN_FILE,
          label: "Open in Editor",
          value: openTargetFor(payload) ?? undefined,
        },
        { action: TUG_ACTIONS.REVEAL_IN_FINDER, label: "Show in Finder" },
      ],
      copy: [{ action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Path" }],
      send: [insertEntry(payload)],
    }),
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
): AnnotationMenuEntry[] =>
  buildEntityMenu(payload, {
    goTo: [{ action: TUG_ACTIONS.REVEAL_IN_FINDER, label: "Show in Finder" }],
    copy: [{ action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Path" }],
    send: [insertEntry(payload)],
  });

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

const imageMenuEntries = (payload: AnnotationPayload): AnnotationMenuEntry[] =>
  buildEntityMenu(payload, {
    goTo: [{ action: TUG_ACTIONS.OPEN_IMAGE_PREVIEW, label: "Open Image" }],
    copy: [{ action: TUG_ACTIONS.COPY_ANNOTATION_VALUE, label: "Copy Name" }],
    send: [insertEntry(payload)],
  });

/**
 * A commit's menu — the same list wherever a commit is shown, with the rows
 * a surface cannot fill left out rather than dimmed forever.
 *
 * **The commit itself leads the copies.** `Copy as Atom` writes the commit as
 * the object it is — the sidecar the composer re-materializes a chip from, and
 * `commit:<8>` as the plain text a reader outside Tug can place — and every
 * other row copies one of its FIELDS: the short hash, the bare full hash for a
 * git argument, the header for a sentence, the record for a paste. The object
 * leads its projections, which is the seat the assembler gives it on every
 * kind rather than a reading this menu takes on its own.
 *
 * That overturns an earlier argument — that `commit:<8>` leads because it is
 * the form the app writes commits as. It is still the form the app writes, and
 * still the first of the TEXT forms; it was never an argument about the object.
 *
 * Transcript ink and a receipt header know a sha and nothing else, so they get
 * the forms a sha alone can stand behind. A History row holds the subject and
 * the whole record, and its facts say so — it offers the header and the record
 * and no insert at all, and it offers the atom exactly as a prose mention does,
 * because a pill in a receipt is the same commit a sentence mentions.
 *
 * The fold is an act on the row, so it sits in the act block under the opens,
 * named in the direction it will move — the menu never asks the reader to
 * recall the row's state.
 */
function commitMenuEntries(
  payload: AnnotationPayload,
  facts: AnnotationMenuFacts,
): AnnotationMenuEntry[] {
  const known = facts.kind === "commit-sha" ? facts : null;
  const hasRecord = known?.hasRecord === true;
  return buildEntityMenu(payload, {
    goTo: [
      // The commit's own card leads the open group: a commit atom's primary
      // act is the commit itself, and its diff is the narrower question of
      // what it changed. A History row offers this and still offers no Open
      // Diff — the row's diff is the shade beneath it, and the card is
      // somewhere else.
      (known === null || known.canOpenCommit !== false) && {
        action: TUG_ACTIONS.OPEN_COMMIT,
        label: "Open Commit",
      },
      // A sha alone can always open its diff; a surface that says it cannot —
      // a commit with no repository behind it — drops the row.
      (known === null || known.canOpenDiff) && {
        action: TUG_ACTIONS.OPEN_DIFF,
        label: "Open Diff",
      },
    ],
    act: [
      known?.expanded !== undefined && {
        action: TUG_ACTIONS.TOGGLE_COMMIT_DETAIL,
        label: known.expanded ? "Hide Detail" : "Show Detail",
      },
    ],
    copy: [
      { action: TUG_ACTIONS.COPY_COMMIT_SHORT_HASH, label: "Copy Short Hash" },
      { action: TUG_ACTIONS.COPY_COMMIT_HASH, label: "Copy Full Hash" },
      hasRecord && {
        action: TUG_ACTIONS.COPY_COMMIT_HEADER,
        label: "Copy Commit Header",
      },
      hasRecord && {
        action: TUG_ACTIONS.COPY_COMMIT_RECORD,
        label: "Copy Commit Record",
      },
    ],
    // A History row sends nothing into a prompt — there is no composer beside
    // it — so it declares no send block and takes no rule for one.
    send: hasRecord ? [] : [insertEntry(payload)],
  });
}

registerAnnotationKind("commit-sha", {
  // A commit atom's primary act is the COMMIT — its own card, showing the
  // whole record the History shade's expansion shows. It used to be the diff,
  // which answered the narrower question of what the commit changed before a
  // commit had a surface of its own; the menu still offers that one step down.
  // The confirmed `paths` stay on the payload for it.
  primaryClick: (payload, ctx) => {
    if (payload.kind !== "commit-sha") return;
    dispatchCommand(TUG_ACTIONS.OPEN_COMMIT, {
      root: payload.root,
      sha: payload.sha,
      ...(ctx.hostCardId !== undefined ? { originCardId: ctx.hostCardId } : {}),
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
  // The atom and the citation are written from the session's identity RECORD
  // — its callsign, its project, the sidecar a paste back into Tug rebuilds
  // the chip from. A surface holding the record writes both from its own
  // facts, which is what `surfaceAtom` says. A surface holding only the id
  // writes neither from the payload, so it is offered the citation not at all
  // and the atom only through `atomSegmentFor`, which resolves the identity
  // for itself and answers `null` when the ledger cannot — the assembler's
  // default, and the reason the transcript's session ink is not stuck at the
  // id its payload carries. Without that row the ink would say `Insert Atom
  // into Prompt` and offer no way to take the atom, which the rule forbids.
  // The id it can always write.
  return buildEntityMenu(payload, {
    ...(known !== null
      ? { surfaceAtom: TUG_ACTIONS.COPY_SESSION_ATOM }
      : {}),
    goTo: [
      known !== null && !known.isOwnCard
        ? known.openCardId !== null
          ? { action: TUG_ACTIONS.SHOW_SESSION, label: "Show Session" }
          : {
              action: TUG_ACTIONS.RESUME_SESSION,
              label: "Resume Session",
              disabled: !known.resumable,
            }
        : null,
    ],
    copy: [
      known !== null && {
        action: TUG_ACTIONS.COPY_SESSION_CITATION,
        label: "Copy as Citation",
      },
      { action: TUG_ACTIONS.COPY_SESSION_ID, label: "Copy Session ID" },
      // The surface's own fields, not the entity's serializations, so they
      // take a rule of their own inside the copy block.
      [
        known?.description !== undefined && {
          action: TUG_ACTIONS.COPY_SESSION_DESCRIPTION,
          label: "Copy Description",
          disabled: (known.description ?? "").trim().length === 0,
        },
        known?.activity !== undefined && {
          action: TUG_ACTIONS.COPY_SESSION_ACTIVITY,
          label: "Copy Activity Line",
          disabled: (known.activity ?? "").trim().length === 0,
        },
      ],
    ],
    send: [insertEntry(payload)],
  });
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
