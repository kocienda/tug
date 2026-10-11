/**
 * The two keymap readings `lib` needs, without importing the keymap registry.
 *
 * The registry is component-layer — it reads the command table, which reads
 * React — so `lib` cannot import it. Two `lib` modules still have to ask it
 * something: the shell's interactive-staging steer names the Changes shade's
 * chord in its copy, and the markdown image overlay dismisses on Cancel's
 * rebindable chords as well as on Escape. Both are reached from other `lib`
 * modules, so there is no component caller to hand them the answer.
 *
 * So the registry installs itself here when it loads, the way the gesture
 * recorder takes its origin from whoever has the store. Before it is
 * installed — a unit test that never loads the registry — the answers are the
 * ones a keymap with nothing bound would give: no chord, and no Cancel chord
 * but Escape, which callers check for themselves.
 *
 * @module lib/keymap-source
 */

/** What the keymap registry answers for `lib`. */
export interface KeymapSource {
  /** The first chord bound to a command, rendered, or `undefined` when none is. */
  commandShortcut(commandId: string): string | undefined;
  /** Whether a key event is one of Cancel's chords other than Escape. */
  isCancelChordEvent(event: KeyboardEvent): boolean;
}

let source: KeymapSource | null = null;

/** Install the keymap registry's answers. Called by the registry as it loads. */
export function setKeymapSource(next: KeymapSource): void {
  source = next;
}

/** {@link KeymapSource.commandShortcut}, or `undefined` before installation. */
export function commandShortcut(commandId: string): string | undefined {
  return source?.commandShortcut(commandId);
}

/** {@link KeymapSource.isCancelChordEvent}, or `false` before installation. */
export function isCancelChordEvent(event: KeyboardEvent): boolean {
  return source?.isCancelChordEvent(event) ?? false;
}
