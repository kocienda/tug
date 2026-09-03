/**
 * keymap-override-store.ts — the user's own keyboard, persisted.
 *
 * The command registry states a default binding list per command. This store
 * holds the *overrides*: one tugbank key per command id, whose value is the
 * binding list that command should have instead. The keymap registry is where
 * the two meet — an override wins for its command and nothing else changes.
 *
 * Three states, and the middle one is the reason this is a store rather than
 * a blob ([P14]):
 *
 * - **Absent** — the command uses the table's default.
 * - **A list** — the command uses this list.
 * - **An empty list** — the command is *deliberately unbound*. Distinct from
 *   absent, and the distinction is durable: "I do not want a chord for this"
 *   is an answer, and reset-to-default has to be able to take it back.
 *
 * A write that matches the command's shipped bindings collapses to the first
 * state rather than becoming the second. Setting a chord back to the default
 * is not a change to remember — it is the undoing of one — and a store that
 * remembered it would leave the command flagged as overridden with nothing to
 * revert to.
 *
 * Per-command keys are what make reset a deletion rather than a rewrite, and
 * keep one command's change from racing another's — a single blob value would
 * make every rebind a read-modify-write of the whole keymap.
 *
 * Persistence rides tugbank defaults (`dev.tugapp.keymap`), the same feed as
 * the theme; there is no `localStorage`. Boot seeds from
 * the DEFAULTS snapshot before `initHostMenuState`, because the host reads
 * chords off the first menu-state push. A remote write arrives through the
 * DEFAULTS push and is applied with `persist: false` to avoid an echo loop.
 *
 * Laws: [L02] subscribable store; [L24] structure-zone state, read by
 * non-rendering code (the keymap registry, the menu-state publisher) as well
 * as by the Settings pane.
 *
 * @module keymap-override-store
 */

import type { CommandBinding, Chord, BindingScope } from "./components/tugways/command-registry";
import { COMMANDS_BY_ID, isCommandLocked } from "./components/tugways/command-registry";
import { chordKey } from "./components/tugways/chord-format";
import { keymapRegistry } from "./components/tugways/keymap-registry";
import { deleteDefault, putKeymapOverride } from "./settings-api";
import type { TaggedValue } from "./lib/tugbank-client";
import { tugDevLogStore } from "./lib/tug-dev-log-store/tug-dev-log-store";

/** The tugbank domain overrides live in ([P14], Spec S04). */
export const KEYMAP_DOMAIN = "dev.tugapp.keymap";

/* ---------------------------------------------------------------------------
 * Parsing
 *
 * Everything here is defensive, and deliberately so: this is persisted user
 * data that a person can also write by hand with `tugbank write`. A malformed
 * value reads as absent, so a corrupt entry degrades to the registry default
 * rather than stranding a command with no way to invoke it and no way to see
 * why (Spec S04).
 * ------------------------------------------------------------------------- */

function parseChord(raw: unknown): Chord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key === "") return null;
  const flag = (v: unknown): true | undefined => (v === true ? true : undefined);
  return {
    key: o.key,
    ...(flag(o.ctrl) !== undefined ? { ctrl: true } : {}),
    ...(flag(o.meta) !== undefined ? { meta: true } : {}),
    ...(flag(o.shift) !== undefined ? { shift: true } : {}),
    ...(flag(o.alt) !== undefined ? { alt: true } : {}),
    ...(typeof o.label === "string" ? { label: o.label } : {}),
  };
}

function parseScope(raw: unknown): BindingScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "global") return { kind: "global" };
  if (o.kind === "responder" && typeof o.responderId === "string") {
    return { kind: "responder", responderId: o.responderId };
  }
  if (o.kind === "mode" && typeof o.modeId === "string") {
    return { kind: "mode", modeId: o.modeId };
  }
  return null;
}

/**
 * Parse one command's persisted binding list.
 *
 * `source` is not persisted and is not read: a binding that came out of
 * tugbank is by definition the user's, so it is stamped rather than trusted.
 * Returns `null` for anything unreadable — including a single bad element,
 * because a half-applied keymap is harder to reason about than a defaulted
 * one.
 */
export function parseOverride(raw: unknown): CommandBinding[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CommandBinding[] = [];
  for (const element of raw) {
    if (typeof element !== "object" || element === null) return null;
    const o = element as Record<string, unknown>;
    const chord = parseChord(o.chord);
    const scope = parseScope(o.scope);
    if (chord === null || scope === null) return null;
    out.push({
      chord,
      scope,
      source: "user",
      ...(o.preventDefault === true ? { preventDefault: true } : {}),
      ...(o.menuEligible === true ? { menuEligible: true } : {}),
    });
  }
  return out;
}

/** Read one tugbank entry as a binding list, or `null` if it is not one. */
function parseEntry(entry: TaggedValue | undefined): CommandBinding[] | null {
  if (entry === undefined) return null;
  if (entry.kind !== "string" || typeof entry.value !== "string") return null;
  try {
    return parseOverride(JSON.parse(entry.value));
  } catch {
    return null;
  }
}

/**
 * Does this binding list say the same thing as the command's shipped one?
 *
 * Compared on chord and scope, which is what a binding MEANS; `source` and
 * the dispatch flags are how it got here. Order matters — a command's
 * bindings are an ordered list ([P08]) — and a command with no default
 * bindings matches only the empty list.
 */
function matchesDefault(
  commandId: string,
  bindings: readonly CommandBinding[],
): boolean {
  const defaults = COMMANDS_BY_ID.get(commandId)?.bindings ?? [];
  if (defaults.length !== bindings.length) return false;
  return defaults.every((def, i) => {
    const b = bindings[i];
    return chordKey(def.chord) === chordKey(b.chord) && sameScope(def.scope, b.scope);
  });
}

function sameScope(a: BindingScope, b: BindingScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "responder" && b.kind === "responder") {
    return a.responderId === b.responderId;
  }
  if (a.kind === "mode" && b.kind === "mode") return a.modeId === b.modeId;
  return true;
}

/** The wire form: `source` is dropped, since a persisted binding is the user's. */
function serialize(bindings: readonly CommandBinding[]): string {
  return JSON.stringify(
    bindings.map((b) => ({
      chord: b.chord,
      scope: b.scope,
      ...(b.preventDefault === true ? { preventDefault: true } : {}),
      ...(b.menuEligible === true ? { menuEligible: true } : {}),
    })),
  );
}

/* ---------------------------------------------------------------------------
 * The store
 * ------------------------------------------------------------------------- */

class KeymapOverrideStore {
  private overrides = new Map<string, CommandBinding[]>();
  private readonly subscribers = new Set<() => void>();
  private version = 0;

  /**
   * Seed from the boot-time DEFAULTS snapshot and push every override into
   * the keymap registry.
   *
   * Runs before `initHostMenuState`, because the host takes its key
   * equivalents from the first menu-state push and a seed that landed after
   * it would show the user the defaults they had already changed.
   */
  initialize(entries: Record<string, TaggedValue> | undefined): void {
    this.overrides = new Map();
    if (entries !== undefined) {
      for (const [commandId, entry] of Object.entries(entries)) {
        const bindings = parseEntry(entry);
        if (bindings === null) {
          tugDevLogStore.warn(
            "keymap",
            `override for "${commandId}" is unreadable; using the default`,
          );
          continue;
        }
        if (isCommandLocked(commandId)) {
          // Policy is enforced on read as well as on write: a hand-written
          // tugbank value must not be able to unbind ⌘Q ([P12]).
          tugDevLogStore.warn(
            "keymap",
            `override for locked command "${commandId}" ignored`,
          );
          continue;
        }
        this.overrides.set(commandId, bindings);
      }
    }
    this.applyAll();
  }

  /** Every command that currently carries an override. */
  overriddenCommands(): string[] {
    return [...this.overrides.keys()];
  }

  /** This command's override, or `undefined` when it is on the default. */
  overrideFor(commandId: string): readonly CommandBinding[] | undefined {
    return this.overrides.get(commandId);
  }

  /** Bumps on every override change, for `useSyncExternalStore` readers. */
  getSnapshot = (): number => this.version;

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  /**
   * Give a command a binding list of its own. An empty list is "explicitly
   * unbound", which is a state the user can hold on purpose.
   *
   * Refused for a locked command ([P12]) — the mechanism could do it, the
   * policy says no — and refusal is silent to the caller by design: the pane
   * never offers the affordance, so a refused write means something reached
   * past the UI, and the dev log is where that belongs.
   */
  set(
    commandId: string,
    bindings: readonly CommandBinding[],
    opts?: { persist?: boolean },
  ): void {
    if (isCommandLocked(commandId)) {
      tugDevLogStore.warn("keymap", `refused to rebind locked command "${commandId}"`);
      return;
    }
    // Setting a command back to what it ships with is not an override, it is
    // the absence of one. Storing it anyway would leave the command flagged
    // as changed with nothing to change back to, and would freeze today's
    // default against a future one — which is the same reason `reset` is a
    // deletion rather than a write.
    if (matchesDefault(commandId, bindings)) {
      this.reset(commandId, opts);
      return;
    }
    const stamped = bindings.map((b) => ({ ...b, source: "user" as const }));
    this.overrides.set(commandId, stamped);
    if (opts?.persist !== false) putKeymapOverride(commandId, serialize(stamped));
    this.apply(commandId);
    this.notify();
  }

  /**
   * Drop a command's override, so it goes back to the table's default.
   *
   * A deletion rather than a write of the default: persisting the default
   * would freeze it, and a command whose shipped chord later changes should
   * follow it unless the user has said otherwise.
   */
  reset(commandId: string, opts?: { persist?: boolean }): void {
    if (!this.overrides.delete(commandId)) return;
    if (opts?.persist !== false) void deleteDefault(KEYMAP_DOMAIN, commandId);
    this.apply(commandId);
    this.notify();
  }

  /** Drop every override — the pane's global reset. */
  resetAll(): void {
    const ids = [...this.overrides.keys()];
    this.overrides.clear();
    for (const id of ids) {
      void deleteDefault(KEYMAP_DOMAIN, id);
      this.apply(id);
    }
    if (ids.length > 0) this.notify();
  }

  /**
   * Apply a remote DEFAULTS push for the whole domain.
   *
   * The push carries the domain's full entry set, so a key that has vanished
   * from it is an override somebody deleted — reset it rather than leaving
   * this process on a value tugbank no longer holds.
   */
  applyRemote(entries: Record<string, TaggedValue>): void {
    let changed = false;
    /** What each command should be on after this push; absent → the default. */
    const next = new Map<string, CommandBinding[]>();
    for (const [commandId, entry] of Object.entries(entries)) {
      const bindings = parseEntry(entry);
      // Unreadable or locked reads as *absent* rather than as "leave it as it
      // was" (Spec S04, [P12]): a corrupt value must degrade to the default,
      // and a locked command must not be rebindable from a shell.
      if (bindings === null || isCommandLocked(commandId)) continue;
      next.set(
        commandId,
        bindings.map((b) => ({ ...b, source: "user" as const })),
      );
    }
    for (const commandId of new Set([...this.overrides.keys(), ...next.keys()])) {
      const want = next.get(commandId);
      const have = this.overrides.get(commandId);
      if (want === undefined) {
        if (have === undefined) continue;
        this.overrides.delete(commandId);
      } else {
        if (have !== undefined && serialize(have) === serialize(want)) continue;
        this.overrides.set(commandId, want);
      }
      this.apply(commandId);
      changed = true;
    }
    if (changed) this.notify();
  }

  // ---- Internals ----

  /** Push one command's current answer into the registry. */
  private apply(commandId: string): void {
    keymapRegistry.setBindings(commandId, this.overrides.get(commandId) ?? null);
  }

  private applyAll(): void {
    for (const commandId of this.overrides.keys()) this.apply(commandId);
  }

  private notify(): void {
    this.version += 1;
    for (const callback of this.subscribers) callback();
  }
}

/** App-wide singleton. */
export const keymapOverrideStore = new KeymapOverrideStore();
