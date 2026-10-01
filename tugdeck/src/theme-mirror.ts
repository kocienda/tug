/**
 * The global theme key as a mirror of the theme on screen.
 *
 * Each workspace carries its own theme, and the theme on screen is the active
 * workspace's. The `dev.tugapp.app` / `theme` tugbank key is kept equal to it,
 * so every reader that knows nothing about workspaces — the host canvas color,
 * the `td-theme` localStorage copy, a `tugbank read` from a shell — goes on
 * being right. The key is rewritten whenever the on-screen theme changes,
 * whether a theme was picked or a workspace was switched to.
 *
 * Every write comes back as a DEFAULTS push, and a push is also how a write
 * from OUTSIDE arrives (`tugbank write … theme sloop`), which means "set the
 * current workspace's theme". The two have to be told apart, and comparing
 * the pushed value against the theme on screen is not enough: two switches in
 * quick succession write `b` then `a`, and the echo of `b` lands while `a` is
 * on screen. Read as an outside write it would stamp `b` onto the workspace
 * the user just arrived in. So the mirror remembers its own writes in order
 * and an echo of one is recognised as such, however late it lands.
 */

import { putTheme } from "./settings-api";

export class ThemeMirror {
  /**
   * The key's value as far as this client knows: last written or last seen.
   * Null until {@link seed}, when any theme is news.
   */
  private known: string | null = null;
  /** Own writes whose echo has not come back, oldest first. */
  private pending: string[] = [];

  constructor(private readonly put: (theme: string) => void) {}

  /**
   * Record the key's value as read at boot — the base theme's name when the
   * key is unset, which is what an unset key means. Writes nothing.
   */
  seed(value: string): void {
    this.known = value;
  }

  /**
   * The theme on screen is now `theme`: bring the key in line. A no-op when
   * the key already holds it, so applying an outside write does not write the
   * same value back.
   */
  write(theme: string): void {
    if (theme === this.known) return;
    this.known = theme;
    this.pending.push(theme);
    this.put(theme);
  }

  /**
   * A value pushed for the key. Returns true when it is an outside write the
   * caller must apply, and false when it is already applied — the echo of one
   * of this client's own writes, or a push that changed nothing (the domain
   * is pushed whole whenever any key in it moves).
   */
  observe(value: string): boolean {
    const echoed = this.pending.indexOf(value);
    if (echoed !== -1) {
      // Pushes can coalesce, so an echo also settles every write before it.
      this.pending.splice(0, echoed + 1);
      return false;
    }
    if (value === this.known) return false;
    this.known = value;
    return true;
  }
}

/** The one mirror, over the real key. */
export const themeMirror = new ThemeMirror((theme) => {
  try { localStorage.setItem("td-theme", theme); } catch { /* unavailable */ }
  putTheme(theme);
});
