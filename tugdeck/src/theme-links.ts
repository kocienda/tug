/**
 * The production theme stylesheets: one `<link>` per theme in use, all loaded,
 * exactly one applying.
 *
 * A workspace switch changes the theme in the same commit as the cut, so
 * showing a theme has to be synchronous. Swapping one link's `href` cannot be
 * — it waits on a fetch. So every theme some workspace wears gets its own
 * link, loaded ahead of time, and showing one is a flip between sheets that
 * are already in the document.
 *
 * **The flip is the loaded sheet's own `disabled`, and nothing on the link
 * element.** Two things about WebKit decide the shape:
 *
 * - A link that is `disabled` before it loads is never fetched, and one
 *   inserted enabled and disabled on `load` applies until that event runs —
 *   the wrong theme on screen while a sheet is fetched for later. So a link
 *   goes in with `media="not all"`: fetched and parsed, applying to nothing.
 * - Changing the link's `media` ATTRIBUTE afterwards re-requests the
 *   stylesheet, which is asynchronous and drops the old sheet in the
 *   meantime — the base theme shows through for a frame or more. So the
 *   attribute is never touched again. On `load` the sheet is disabled and
 *   its media list — the CSSOM object, not the attribute — is opened to
 *   `all`. From then on the sheet's `disabled` is the one switch, and
 *   flipping it is a synchronous style invalidation with no fetch behind it.
 *
 * The base theme has no link. Its tokens are the app's own CSS, so showing it
 * means no override applies.
 *
 * Production only: the dev server serves the active theme as one HMR'd
 * virtual module and has no per-theme assets.
 */

import { BASE_THEME_NAME } from "./theme-constants";

/** Names the theme a link carries; the selector tests and tools find it by. */
export const THEME_LINK_ATTRIBUTE = "data-tug-theme";

const MEDIA_HELD = "not all";

interface ThemeLink {
  link: HTMLLinkElement;
  /** The loaded sheet, which is when a flip to it is synchronous. */
  sheet: CSSStyleSheet | null;
  loaded: Promise<boolean>;
}

const links = new Map<string, ThemeLink>();

/**
 * Load `themeName`'s stylesheet without showing it. Resolves true once a
 * flip to the theme is synchronous, false when the sheet could not be loaded.
 * Idempotent: a theme already loaded or loading returns the same promise.
 */
export function loadThemeLink(themeName: string): Promise<boolean> {
  if (themeName === BASE_THEME_NAME) return Promise.resolve(true);
  const existing = links.get(themeName);
  if (existing !== undefined) return existing.loaded;

  const href = `/assets/themes/${themeName}.css`;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.media = MEDIA_HELD;
  link.setAttribute(THEME_LINK_ATTRIBUTE, themeName);

  const entry: ThemeLink = { link, sheet: null, loaded: Promise.resolve(false) };
  entry.loaded = new Promise<boolean>((resolve) => {
    link.addEventListener(
      "load",
      () => {
        const sheet = link.sheet;
        if (sheet === null) {
          resolve(false);
          return;
        }
        // Disabled before the media list opens, so it never applies between.
        sheet.disabled = true;
        sheet.media.mediaText = "all";
        entry.sheet = sheet;
        resolve(true);
      },
      { once: true },
    );
    link.addEventListener(
      "error",
      () => {
        console.warn(`Failed to load production theme CSS: ${href}`);
        // Forgotten rather than kept, so a later use tries the fetch again.
        link.remove();
        links.delete(themeName);
        resolve(false);
      },
      { once: true },
    );
  });
  links.set(themeName, entry);
  link.href = href;
  document.head.appendChild(link);
  return entry.loaded;
}

/** True when {@link showThemeLink} would succeed for `themeName`. */
export function isThemeLinkReady(themeName: string): boolean {
  return themeName === BASE_THEME_NAME || links.get(themeName)?.sheet != null;
}

/**
 * Make `themeName` the one theme that applies, synchronously. Returns false,
 * having changed nothing, when its sheet has not loaded.
 */
export function showThemeLink(themeName: string): boolean {
  if (!isThemeLinkReady(themeName)) return false;
  for (const [name, entry] of links) {
    if (entry.sheet === null) continue;
    const disabled = name !== themeName;
    if (entry.sheet.disabled !== disabled) entry.sheet.disabled = disabled;
  }
  return true;
}
