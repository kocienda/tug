/**
 * keymap-registry.ts — funnel #2: the one place a chord becomes a command.
 *
 * The command registry says what a command's default bindings are; this
 * module answers the questions a keyboard raises about them. Two of those
 * questions are cheap and one is the reason the module exists:
 *
 * - `matchChord` — the global layer's O(1) lookup, what the key pipeline runs
 *   on every keydown.
 * - `menuChords` — which chord each menu item should carry, for the push.
 * - `resolveChord` — **who actually gets this chord**, as an ordered stack
 *   with a winner and a shadower per loser.
 *
 * ## Why shadowing is the point
 *
 * A chord in Tug can be claimed at four layers, and they are not peers. In
 * the shipped app AppKit resolves an `NSMenuItem` key equivalent *before the
 * web view sees a keydown at all*, so a menu-eligible chord preempts every
 * scoped binding regardless of focus ([P15]). Below that, the JS pipeline
 * resolves focus mode first, then the responder walk innermost-first, then
 * global ([P08]).
 *
 * The codebase already knows this and reasons about it by hand: `pdf-view.tsx`
 * declines ⌘1–⌘3 because the deck wants them, and declines the zoom chords
 * outright because "they belong to the host's View menu and never reach the
 * web view at all." That comment is a hand-maintained shadowing analysis.
 * `resolveChord` is what answers it instead.
 *
 * ## What this module cannot see, and takes as input
 *
 * Two of the four layers are runtime facts owned elsewhere: scoped bindings
 * live in the components that declare them (read through the responder
 * chain), and a menu item's live enablement lives in the menu-state mirror.
 * A registry that imported either would be a cycle, and one that cached
 * either would be stale. So they arrive through a {@link KeymapEnvironment}
 * the registry is handed — which is also what lets every resolution case be
 * unit-tested against a constructed multi-layer world.
 */

import { Subscribable } from "@/lib/subscribable";
import type { Chord, CommandBinding, CommandEntry, BindingScope } from "./command-registry";
import { COMMANDS } from "./command-registry";
import { TUG_ACTIONS } from "./action-vocabulary";
import {
  chordHasKeyEquivalent,
  chordKey,
  chordMatchesEvent,
  codeToKeyEquivalent,
  eventChordKey,
  formatChord,
  type ChordEventFields,
  type ChordSpec,
} from "./chord-format";

/* ---------------------------------------------------------------------------
 * What resolveChord answers (Spec S02)
 * ------------------------------------------------------------------------- */

/** Which layer a claim on a chord lives at. */
export type ResolutionLayer =
  /**
   * An `NSMenuItem` carries this chord. AppKit resolves it before the web
   * view sees a keydown, so this layer sits above all three JS layers.
   */
  | {
      readonly kind: "native";
      readonly menuItemId: string;
      /**
       * The item validates enabled. `false` means the chord is eaten at the
       * menu bar with a beep and reaches nothing at all — it does **not**
       * fall through.
       */
      readonly enabled: boolean;
      /**
       * The enclosing menu is visible, or carries
       * `allowsKeyEquivalentWhenHidden`. `false` means the chord falls
       * through to the JS layers — the Maker menu's state when maker mode
       * is off.
       */
      readonly claims: boolean;
    }
  | { readonly kind: "js"; readonly scope: BindingScope };

export interface ChordResolution {
  readonly commandId: string;
  readonly layer: ResolutionLayer;
  /** This claim is the one that fires. */
  readonly active: boolean;
  /** The claim that took the chord instead. Absent on the winner. */
  readonly shadowedBy?: {
    readonly commandId: string;
    readonly layer: ResolutionLayer;
  };
}

/* ---------------------------------------------------------------------------
 * The environment: the two layers the registry cannot see for itself
 * ------------------------------------------------------------------------- */

/** A binding the responder chain currently has registered under a scope. */
export interface ScopedBinding {
  readonly commandId: string;
  readonly chord: Chord;
  readonly scope: BindingScope;
  /**
   * Resolution distance: 0 is the innermost claimant. A focus mode is
   * innermost of all, then the responder walk from the first responder up.
   * The pipeline resolves smallest-first, so this is the sort key.
   */
  readonly depth: number;
}

/** A menu item's live claim on a chord. */
export interface NativeChordClaim {
  readonly menuItemId: string;
  readonly commandId: string;
  readonly chord: Chord;
  readonly enabled: boolean;
  readonly claims: boolean;
}

/**
 * The runtime world a resolution is answered against. Both halves are read
 * fresh on every call — a cached answer here is a keymap pane confidently
 * showing what was true when the card opened.
 */
export interface KeymapEnvironment {
  scopedBindings(): readonly ScopedBinding[];
  nativeChords(): readonly NativeChordClaim[];
}

/** The world before anything has registered: JS global bindings only. */
export const EMPTY_KEYMAP_ENVIRONMENT: KeymapEnvironment = {
  scopedBindings: () => [],
  nativeChords: () => [],
};

/* ---------------------------------------------------------------------------
 * The registry
 * ------------------------------------------------------------------------- */

/** A command's binding, with the command it belongs to. */
export interface KeymapBinding {
  readonly commandId: string;
  readonly binding: CommandBinding;
}

/** A binding plus whether it is the one that actually fires right now. */
export interface ResolvedBinding {
  readonly binding: CommandBinding;
  readonly active: boolean;
  readonly shadowedBy?: { readonly commandId: string; readonly layer: ResolutionLayer };
}

export class KeymapRegistry extends Subscribable {
  private entries: readonly CommandEntry[];
  /** Merged default + override binding lists, keyed by command id. */
  private bindings: Map<string, readonly CommandBinding[]>;
  /** Global-layer chord → binding. First writer wins, matching the old scan. */
  private globalIndex: Map<string, KeymapBinding>;
  /**
   * Menu items whose key equivalent the registry has taken responsibility
   * for. Seeded from the table's own menu-eligible defaults and grown as
   * bindings are written, never shrunk: releasing a chord is a thing the
   * registry has to say out loud, and it can only say it about an item it
   * remembers claiming.
   */
  private readonly claimedMenuItems = new Set<string>();
  private environment: KeymapEnvironment = EMPTY_KEYMAP_ENVIRONMENT;
  private version = 0;

  constructor(entries: readonly CommandEntry[] = COMMANDS) {
    super();
    this.entries = entries;
    this.bindings = new Map();
    this.globalIndex = new Map();
    this.rebuild();
  }

  /**
   * Point the registry at the live scoped-binding and native-chord sources.
   *
   * A partial merge because the two halves have two owners with two
   * lifetimes: the responder-chain provider supplies `scopedBindings` at
   * mount, and the menu-state publisher supplies `nativeChords` at boot —
   * each hands over only its half, so neither install erases the other's.
   */
  setEnvironment(environment: Partial<KeymapEnvironment>): void {
    this.environment = { ...this.environment, ...environment };
  }

  /**
   * Replace a command's bindings — the seam a user override writes through.
   * An empty list is "explicitly unbound", which is a different fact from
   * having no override at all ([P14]); `null` restores the table's default.
   */
  setBindings(commandId: string, bindings: readonly CommandBinding[] | null): void {
    if (bindings === null) {
      const entry = this.entries.find((e) => e.id === commandId);
      if (entry?.bindings === undefined) this.bindings.delete(commandId);
      else this.bindings.set(commandId, entry.bindings);
    } else {
      this.bindings.set(commandId, bindings);
    }
    this.claimMenuItem(commandId);
    this.reindex();
    this.notify();
  }

  // ---- Subscription ([L02]) ----

  // Bound properties, not prototype methods: `useSyncExternalStore` takes
  // these as bare function references, and a prototype method handed over
  // that way arrives with no `this` at all.

  /** Bumps on every binding change, so React readers can `useSyncExternalStore`. */
  getSnapshot = (): number => this.version;

  // ---- Reads ----

  /**
   * The global-layer command for an event, or `null`.
   *
   * Only the global layer: the mode and responder layers are resolved by the
   * chain, ahead of this call, because they need the live focus walk. That
   * split is what stage 1 already does, and formalizing it here changes no
   * order.
   */
  matchChord(event: KeyboardEvent): KeymapBinding | null {
    return this.globalIndex.get(eventChordKey(event)) ?? null;
  }

  /** Every binding on a command, defaults merged with any override. */
  bindingsOf(commandId: string): readonly CommandBinding[] {
    return this.bindings.get(commandId) ?? [];
  }

  /**
   * A command's bindings, each marked with whether it is the one that fires.
   *
   * A command can hold a chord and still never see it — that is the whole
   * point of asking. The keymap row that says "⌘1" without saying "the
   * Window menu takes this first" is the lie [P11] retires.
   */
  bindingsFor(commandId: string): ResolvedBinding[] {
    return this.bindingsOf(commandId).map((binding) => {
      const stack = this.resolveChord(binding.chord);
      const winner = stack.find((r) => r.active);
      // The question is "does pressing this fire this command", not "does
      // this particular row win" — a promoted command's chord fires through
      // its menu item, and reporting that as shadowed would be backwards.
      if (winner !== undefined && winner.commandId === commandId) {
        return { binding, active: true };
      }
      // No winner and a native claim in the stack means the chord is eaten
      // at the menu bar. If the eater is this command's own item, the chord
      // is not shadowed — it is disabled, which is a different sentence.
      const blocker =
        winner ??
        stack.find(
          (r) => r.layer.kind === "native" && r.layer.claims && !r.layer.enabled,
        );
      return {
        binding,
        active: false,
        ...(blocker !== undefined && blocker.commandId !== commandId
          ? { shadowedBy: { commandId: blocker.commandId, layer: blocker.layer } }
          : {}),
      };
    });
  }

  /**
   * The full claim stack for a chord, outermost layer first ([P15]).
   *
   * Order: the native menu, then focus mode, then the responder walk
   * innermost-first, then global. The first claim that can take the chord
   * is `active`; every claim after it names that winner as its `shadowedBy`.
   *
   * Three native states, and all three are different answers:
   *
   * - `claims: false` — the item's menu is hidden without
   *   `allowsKeyEquivalentWhenHidden`, so it neither fires nor blocks. It is
   *   listed (the pane should say the chord changes meaning in maker mode)
   *   but wins nothing and shadows nothing.
   * - `claims: true, enabled: false` — the chord is eaten at the menu bar
   *   with a beep. Nothing below is reachable, and nothing is active: the
   *   chord is dead in the app. Attributing it to the first JS binding
   *   would be a lie in the one surface whose job is to be believed.
   * - `claims: true, enabled: true` — it fires, and shadows everything.
   */
  resolveChord(chord: Chord): ChordResolution[] {
    const key = chordKey(chord);
    const stack: Array<{ commandId: string; layer: ResolutionLayer }> = [];

    for (const claim of this.environment.nativeChords()) {
      if (chordKey(claim.chord) !== key) continue;
      stack.push({
        commandId: claim.commandId,
        layer: {
          kind: "native",
          menuItemId: claim.menuItemId,
          enabled: claim.enabled,
          claims: claim.claims,
        },
      });
    }

    const scoped = this.environment
      .scopedBindings()
      .filter((b) => chordKey(b.chord) === key)
      .slice()
      .sort((a, b) => a.depth - b.depth);
    for (const b of scoped) {
      stack.push({ commandId: b.commandId, layer: { kind: "js", scope: b.scope } });
    }

    for (const [id, list] of this.bindings) {
      for (const binding of list) {
        if (binding.scope.kind !== "global") continue;
        if (chordKey(binding.chord) !== key) continue;
        stack.push({ commandId: id, layer: { kind: "js", scope: binding.scope } });
      }
    }

    // One pass: the first claim that can take the chord wins, and a native
    // item that eats it without firing blocks everything below without
    // winning either.
    let winner: { commandId: string; layer: ResolutionLayer } | null = null;
    let eater: { commandId: string; layer: ResolutionLayer } | null = null;
    const resolved: ChordResolution[] = [];
    for (const claim of stack) {
      const blocker = winner ?? eater;
      if (blocker !== null) {
        resolved.push({
          commandId: claim.commandId,
          layer: claim.layer,
          active: false,
          shadowedBy: { commandId: blocker.commandId, layer: blocker.layer },
        });
        continue;
      }
      if (claim.layer.kind === "native" && !claim.layer.claims) {
        // Present, but its menu is hidden: it takes nothing and blocks
        // nothing, so the JS layers below resolve as [P08] states.
        resolved.push({ commandId: claim.commandId, layer: claim.layer, active: false });
        continue;
      }
      if (claim.layer.kind === "native" && !claim.layer.enabled) {
        eater = claim;
        resolved.push({ commandId: claim.commandId, layer: claim.layer, active: false });
        continue;
      }
      winner = claim;
      resolved.push({ commandId: claim.commandId, layer: claim.layer, active: true });
    }
    return resolved;
  }

  /**
   * Which chord each menu item should carry — what the mirror publishes.
   *
   * An item appears here only once the registry has claimed it — because
   * absence on the wire means "leave the constructed key equivalent alone"
   * (Spec S03), and the host's construction-time literal is the right answer
   * for every item whose chord the table does not state. Claiming is
   * sticky: an item whose command has held a menu-eligible binding at any
   * point publishes `null` once it holds none, which detaches. That is how a
   * rebound-away command releases its chord, and it is why the claim is
   * remembered rather than recomputed — a command that loses its last chord
   * would otherwise go silent and leave the old key equivalent standing.
   *
   * Enablement is not consulted here. A `disabledChord: "detach"` command
   * releases its chord while it validates disabled, and only the publisher
   * knows what validated — so it applies that rule over this answer.
   */
  menuChords(): Record<string, ChordSpec | null> {
    const out: Record<string, ChordSpec | null> = {};
    for (const entry of this.entries) {
      if (entry.menuItemId === undefined) continue;
      const live = this.menuBindingOf(entry.id);
      if (live !== undefined) {
        // An `NSMenuItem` carries exactly one key equivalent, so the first
        // eligible binding is the menu's and the rest live in the JS funnel.
        this.claimedMenuItems.add(entry.menuItemId);
        // A user-captured code with no menu representation (`IntlBackslash`,
        // a numpad digit) is a legitimate binding for the JS funnel; it
        // detaches the menu chord rather than reaching the conversion's
        // untabled-code throw, which is for authored defaults only.
        out[entry.menuItemId] =
          live.source === "user" && !chordHasKeyEquivalent(live.chord)
            ? null
            : codeToKeyEquivalent(live.chord);
      } else if (this.claimedMenuItems.has(entry.menuItemId)) {
        out[entry.menuItemId] = null;
      }
    }
    return out;
  }

  /**
   * Every menu item's live chord claim, in source form.
   *
   * `menuChords` answers in the converted wire shape for the push; this
   * answers in `Chord` form for the resolution model — the menu-state
   * publisher maps these into the `nativeChords` half of the environment,
   * joining each claim to the enablement its own mirror computed, so
   * `resolveChord`'s native layer describes the same menu bar the push
   * built.
   */
  menuClaims(): readonly { commandId: string; menuItemId: string; chord: Chord }[] {
    const out: Array<{ commandId: string; menuItemId: string; chord: Chord }> = [];
    for (const entry of this.entries) {
      if (entry.menuItemId === undefined) continue;
      const live = this.menuBindingOf(entry.id);
      if (live === undefined) continue;
      out.push({ commandId: entry.id, menuItemId: entry.menuItemId, chord: live.chord });
    }
    return out;
  }

  // ---- Lints ----

  /**
   * The collision lint ([P15]): a `menuEligible` binding that shares a chord
   * with a scoped binding.
   *
   * This is the one collision the shadowing model cannot soften. A scoped
   * binding loses to a menu item unconditionally and from anywhere — not
   * "when the menu is open", not "when focus is outside the card" — so the
   * scoped binding is not shadowed, it is dead. Promoting a command to the
   * menu bar is therefore a decision about every surface that wanted that
   * chord, and this is what makes that decision visible instead of silent.
   */
  lintChordCollisions(scoped: readonly ScopedBinding[] = this.environment.scopedBindings()): string[] {
    const eligible = new Map<string, string>();
    for (const [id, list] of this.bindings) {
      for (const binding of list) {
        if (binding.menuEligible !== true) continue;
        eligible.set(chordKey(binding.chord), id);
      }
    }
    // The table declares scoped bindings of its own (a responder-scoped
    // default like the commit surface's ⌃⌘M). Those are the registry's to
    // know, so the lint folds them in itself rather than trusting the
    // caller's transcription to remember them.
    const scopedInTable: ScopedBinding[] = [];
    for (const [id, list] of this.bindings) {
      for (const binding of list) {
        if (binding.scope.kind === "global") continue;
        scopedInTable.push({ commandId: id, chord: binding.chord, scope: binding.scope, depth: 0 });
      }
    }
    const problems: string[] = [];
    for (const b of [...scoped, ...scopedInTable]) {
      const owner = eligible.get(chordKey(b.chord));
      if (owner === undefined || owner === b.commandId) continue;
      problems.push(
        `${b.commandId}'s scoped binding on ${chordKey(b.chord)} is dead: the menu item for ${owner} takes that chord before the web view sees it`,
      );
    }
    return problems;
  }

  // ---- Internals ----

  private rebuild(): void {
    this.bindings = new Map();
    for (const entry of this.entries) {
      if (entry.bindings !== undefined && entry.bindings.length > 0) {
        this.bindings.set(entry.id, entry.bindings);
      }
      this.claimMenuItem(entry.id);
    }
    this.reindex();
  }

  /**
   * The binding that should carry this command's menu key equivalent, or
   * `undefined` when none should.
   *
   * A default says so explicitly with `menuEligible` — that flag is how the
   * table distinguishes Zoom In's ⌘+ (the menu's) from its ⌘= alias (the JS
   * funnel's). A *user* binding does not: someone rebinding Zoom Out has said
   * what the chord is, not which layer should carry it, and expecting them to
   * know about menu eligibility would be asking them to understand AppKit's
   * key-equivalent scan in order to change a shortcut. So a user's first
   * global binding takes the item, and their empty list releases it.
   */
  private menuBindingOf(commandId: string): CommandBinding | undefined {
    const bindings = this.bindingsOf(commandId);
    return (
      bindings.find((b) => b.menuEligible === true) ??
      bindings.find((b) => b.source === "user" && b.scope.kind === "global")
    );
  }

  /**
   * Note that the registry now speaks for this command's menu item, if it
   * currently holds a binding that belongs on it.
   *
   * Recorded when the binding is *written*, not when it is next published:
   * two rebinds landing between one flush and the next would otherwise leave
   * the intervening claim unrecorded, and the item would keep a key
   * equivalent the registry no longer states.
   */
  private claimMenuItem(commandId: string): void {
    const entry = this.entries.find((e) => e.id === commandId);
    if (entry?.menuItemId === undefined) return;
    if (this.menuBindingOf(commandId) === undefined) return;
    this.claimedMenuItems.add(entry.menuItemId);
  }

  private reindex(): void {
    const index = new Map<string, KeymapBinding>();
    for (const [commandId, list] of this.bindings) {
      for (const binding of list) {
        if (binding.scope.kind !== "global") continue;
        const key = chordKey(binding.chord);
        if (!index.has(key)) index.set(key, { commandId, binding });
      }
    }
    this.globalIndex = index;
  }

  override notify(): void {
    this.version += 1;
    super.notify();
  }
}

/** The app's registry. Tests construct their own over a fixture table. */
export const keymapRegistry = new KeymapRegistry();

/**
 * The chord string to show beside a command, or `undefined` when it has
 * none.
 *
 * The single renderer for every displayed shortcut ([P11]). No surface
 * authors one of its own: an authored string has nothing to disagree with
 * until someone reads it — which is how a context menu advertised ⇧⌘C for
 * Copy as Plain Text while the real chord was ⌥⇧⌘C — and once chords are the
 * user's to rebind, an authored string is guaranteed wrong for anyone who
 * rebinds.
 *
 * A command with several bindings shows the first, the same rule the host's
 * menu sweep applies, so an in-page menu and the menu bar name the same
 * gesture.
 */
export function commandShortcut(
  commandId: string,
  registry: KeymapRegistry = keymapRegistry,
): string | undefined {
  const binding = registry.bindingsOf(commandId)[0];
  return binding === undefined ? undefined : formatChord(binding.chord);
}

/**
 * Whether an event is a Cancel chord OTHER than Escape.
 *
 * The one predicate for ⌘. parity ([D126]): a surface that dismisses on ⎋
 * dismisses on ⌘. too, and it decides that by asking the registry rather than
 * by authoring `metaKey && key === "."` — which is both a second spelling of a
 * chord the table already holds and a match on the `event.key` *label* instead
 * of `code` identity, so it breaks on any layout where `.` is not where a US
 * keyboard puts it.
 *
 * Escape is excluded deliberately, and the exclusion is the load-bearing part.
 * Escape ownership is per-surface: the engine walks its own ladder for alerts,
 * sheets, and context menus, while a placard outside any focus mode keeps a
 * local handler. A helper that matched ⎋ would let every conversion silently
 * take it away from whichever owner it already had.
 *
 * Reads the singleton registry, so a user rebind of Cancel reaches every
 * surface at once — which is the entire point of the funnel.
 */
export function isCancelChordEvent(
  event: ChordEventFields,
  registry: KeymapRegistry = keymapRegistry,
): boolean {
  return registry
    .bindingsOf(TUG_ACTIONS.CANCEL_DIALOG)
    .some((b) => b.chord.key !== "Escape" && chordMatchesEvent(event, b.chord));
}

/**
 * Every chord bound to a command, rendered and joined — for the surfaces
 * that have room to name them all. A help sheet that shows only ⌘. for
 * Cancel is telling half the truth to a reader who is there to learn.
 */
export function commandShortcuts(
  commandId: string,
  registry: KeymapRegistry = keymapRegistry,
): string | undefined {
  const bindings = registry.bindingsOf(commandId);
  if (bindings.length === 0) return undefined;
  return bindings.map((b) => formatChord(b.chord)).join(" / ");
}

