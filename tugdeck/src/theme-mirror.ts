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
 *
 * A push can also be STALE. The domain is pushed whole whenever any key in it
 * moves, and a theme change moves a second key by another road: the host
 * writes `window-background` when it is sent the new canvas color. When that
 * write beats this client's own PUT to the store, its push still carries the
 * theme the key held BEFORE the write — and read as an outside write it puts
 * the old theme back on screen, whose own canvas-color write then pushes the
 * new theme and flips it forward again. So while a write is owed its echo, a
 * push carrying the value the key held before it is a snapshot from before
 * the write, and changes nothing.
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
  /** What the key held before the oldest pending write; null when none is. */
  private before: string | null = null;

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
    if (this.pending.length === 0) this.before = this.known;
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
      if (this.pending.length === 0) this.before = null;
      return false;
    }
    if (value === this.known) return false;
    // A snapshot taken before this client's write reached the store.
    if (this.pending.length > 0 && value === this.before) return false;
    // Anything else is past every write still owed an echo.
    this.pending = [];
    this.before = null;
    this.known = value;
    return true;
  }
}

/** The one mirror, over the real key. */
export const themeMirror = new ThemeMirror((theme) => {
  try { localStorage.setItem("td-theme", theme); } catch { /* unavailable */ }
  putTheme(theme);
});
