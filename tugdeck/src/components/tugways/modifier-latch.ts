/**
 * `modifier-latch` — the held-modifier bit, projected onto `<html>` as
 * `data-mods`.
 *
 * One consumer today: the **chord ring**. A default button whose activation is
 * `Shift+Return` rather than a plain `Return` wears the double ring dashed, and
 * the arc resolves to solid exactly while Shift is physically down ALONE — the
 * instant at which a `Return` really would fire it. So the ring never states
 * something false at any moment, and holding Shift becomes the gesture that
 * *shows you* what Return is about to do.
 *
 * "Alone" is why all four modifiers are latched rather than just the one that
 * is read. `Shift+Return` is an exclusive chord: `Cmd+Shift+Return` and
 * `Opt+Shift+Return` do NOT submit (`resolveEnterAction`'s caller disqualifies
 * every other modifier combination), so a ring that went solid on Shift held
 * with Cmd would be promising a keystroke that does nothing. The attribute
 * therefore carries the WHOLE held set and the ring matches it exactly
 * (`[data-mods="shift"]`), not as a member (`~="shift"`), which would match
 * every superset.
 *
 * Appearance, so it travels as a DOM attribute and never as React state
 * ([L06]) — the same shape as `data-app-active` (`deck-manager`) and `data-kbf`
 * (`focus-manager`).
 *
 * The latch reads `event.shiftKey` off EVERY key event rather than watching for
 * `key === "Shift"`. A modifier press and release are ordinary keydown/keyup
 * pairs that can be missed — a chord swallowed by a native menu, a keyup
 * delivered while another window is key — and a latch that only counts those
 * two events would then stay stuck down. Reading the flag off whatever key
 * event arrives next makes every keystroke a resync, so the worst case is one
 * stale frame rather than a permanently lit ring.
 *
 * Window `blur` clears it for the case no key event can correct: Shift held
 * while the user Cmd-Tabs away, whose keyup lands in the other app entirely.
 * (A background window paints no ring at all — `[data-app-active="false"]`
 * drops the outline on both paint paths — but the attribute would still be
 * wrong when the window came back, and a wrong attribute is a wrong test.)
 *
 * @module components/tugways/modifier-latch
 */

/**
 * Root attribute carrying the modifiers currently held down, space-separated,
 * absent when none are. Space-separated (rather than one attribute per
 * modifier) so the set can grow without growing the projection.
 *
 * Tokens are emitted in the fixed order given by {@link MOD_TOKENS}, so an
 * exclusive read is a plain string match: `[data-mods="shift"]` is "Shift and
 * nothing else", with no ordering permutations to enumerate.
 */
export const MODS_ATTRIBUTE = "data-mods";

/** Shift's token within {@link MODS_ATTRIBUTE} — the one the chord ring reads. */
export const MOD_SHIFT = "shift";

/**
 * Every latched modifier, in the canonical order they are written. The three
 * besides `shift` are latched because the chord ring's read is EXCLUSIVE: it
 * needs to know they are absent, which is not something a Shift-only latch can
 * say.
 */
export const MOD_TOKENS = [MOD_SHIFT, "alt", "ctrl", "meta"] as const;

/**
 * Install the latch's listeners on `document` / `window` and return the
 * teardown. Idempotent per call site; the responder chain provider owns the
 * single installation, alongside the rest of the key pipeline.
 */
export function installModifierLatch(): () => void {
  if (typeof document === "undefined") return () => {};

  const root = document.documentElement;
  // Mirrors the attribute so the common case — a keystroke that does not
  // change the held set — costs one string compare and no DOM touch. The
  // composer's typing path runs through here on every key up and down.
  let held = "";

  const apply = (next: string): void => {
    if (next === held) return;
    held = next;
    if (next === "") {
      root.removeAttribute(MODS_ATTRIBUTE);
    } else {
      root.setAttribute(MODS_ATTRIBUTE, next);
    }
  };

  const onKey = (event: KeyboardEvent): void => {
    const flags = [event.shiftKey, event.altKey, event.ctrlKey, event.metaKey];
    apply(MOD_TOKENS.filter((_token, i) => flags[i]).join(" "));
  };
  const onBlur = (): void => {
    apply("");
  };

  // Capture phase: a chord consumed by the engine's own capture stages
  // (`stopImmediatePropagation` at the window-capture keybinding stage) must
  // still resync the latch, and a bubble-phase listener would never see it.
  document.addEventListener("keydown", onKey, { capture: true });
  document.addEventListener("keyup", onKey, { capture: true });
  window.addEventListener("blur", onBlur);

  return () => {
    document.removeEventListener("keydown", onKey, { capture: true });
    document.removeEventListener("keyup", onKey, { capture: true });
    window.removeEventListener("blur", onBlur);
    apply("");
  };
}
