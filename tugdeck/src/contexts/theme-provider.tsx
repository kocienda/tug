/**
 * TugThemeProvider — React context provider for the Tugways theme system.
 *
 * Architecture: direct file load (not base+override cascade).
 *
 * Dev mode: Theme switching posts to POST /__themes/activate, which records the
 * selected theme as the dev server's in-memory active theme and re-renders the
 * `virtual:tug-active-theme.css` module through Vite's CSS pipeline (PostCSS
 * expands all --tug-color() tokens). The module's source is the theme's own
 * styles/themes/<name>.css; it is always complete and never empty. The active
 * theme lives only in this dev server process, so build variants (release /
 * debug / each worktree) sharing one working tree no longer bleed themes into
 * each other.
 *
 * Production mode: every theme in use has its own pre-loaded <link> to the
 * pre-built per-theme CSS asset (`theme-links.ts`), and switching is a
 * synchronous flip between them — which is what lets a workspace switch
 * change the theme in the same commit as the cut. Host canvas color is read
 * from CSS metadata token --tugx-host-canvas-color after the flip. [D08]
 *
 * The theme on screen is module state here rather than React state, because
 * the workspace switch that changes it runs outside React. The provider reads
 * it through `useSyncExternalStore` [L02].
 *
 * (#settheme-flow), [D03] Direct load, [D04] Dual persistence,
 * (#s03-theme-provider), [D08] Production theme links
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { themeMirror } from "../theme-mirror";
import { loadThemeLink, showThemeLink } from "../theme-links";
import { registerThemeSetter, registerThemeGetter } from "../action-dispatch";
import { publishActiveTheme } from "../lib/host-menu-state";
import { notifyThemeChange } from "../theme-tokens";
import { BASE_THEME_NAME } from "../theme-constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Theme name — widened to string to support dynamically-loaded themes. */
export type ThemeName = string;

interface ThemeContextValue {
  theme: string;
  setTheme: (theme: string) => void;
}

function normalizeColorToHex(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex6 = value.match(/^#([0-9a-f]{6})$/i);
  if (hex6) return `#${hex6[1]}`;
  const hex3 = value.match(/^#([0-9a-f]{3})$/i);
  if (hex3) {
    const [r, g, b] = hex3[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const rgb = value.match(/^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/);
  if (!rgb) return null;
  const nums = [rgb[1], rgb[2], rgb[3]].map((n) => Number(n));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return `#${nums.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function readHostCanvasColorFromAppliedCss(): string | null {
  const fromBody = getComputedStyle(document.body).getPropertyValue("--tugx-host-canvas-color");
  const normalizedBody = normalizeColorToHex(fromBody);
  if (normalizedBody) return normalizedBody;
  const fromRoot = getComputedStyle(document.documentElement).getPropertyValue("--tugx-host-canvas-color");
  return normalizeColorToHex(fromRoot);
}

/** Post a normalized canvas background hex string to the Swift bridge. */
export function sendCanvasColor(hex: string): void {
  const normalized = normalizeColorToHex(hex);
  if (!normalized) return;
  (window as unknown as { webkit?: { messageHandlers?: { setTheme?: { postMessage: (v: unknown) => void } } } })
    .webkit?.messageHandlers?.setTheme?.postMessage({ color: normalized });
}

// ---------------------------------------------------------------------------
// The theme on screen
// ---------------------------------------------------------------------------

let onScreenTheme: string = BASE_THEME_NAME;
const onScreenThemeListeners = new Set<() => void>();

/** The name of the theme on screen. */
export function getOnScreenTheme(): string {
  return onScreenTheme;
}

/**
 * Record the theme the boot applied, before the first render. Notifies
 * nobody: there is no reader yet.
 */
export function seedOnScreenTheme(theme: string): void {
  onScreenTheme = theme;
}

function subscribeOnScreenTheme(listener: () => void): () => void {
  onScreenThemeListeners.add(listener);
  return () => {
    onScreenThemeListeners.delete(listener);
  };
}

/**
 * Everything that follows a theme's CSS being applied, in one place so a
 * menu pick and a workspace switch cannot differ in what they leave behind:
 * the host window's canvas color, the provider's readers, the token
 * subscribers that bake colors, and the global key.
 */
function finishThemeChange(theme: string, hostCanvasColor: string | null): void {
  if (hostCanvasColor !== null) sendCanvasColor(hostCanvasColor);
  if (theme !== onScreenTheme) {
    onScreenTheme = theme;
    for (const listener of Array.from(onScreenThemeListeners)) listener();
  }
  notifyThemeChange();
  themeMirror.write(theme);
}

/**
 * Every request to put a theme on screen takes the next number, and the
 * theme it asked for becomes the one wanted. An asynchronous apply that
 * resolves after a later request was made does nothing — the later one
 * decides. Without this, switching A → B → A while B's theme is still on its
 * way (always in dev; in production when B's sheet had not loaded) lands B's
 * theme on screen in workspace A after the switch back, because A's own
 * request was a no-op: A's theme was still the one on screen.
 */
let themeRequest = 0;
let wantedTheme: string = BASE_THEME_NAME;

function beginThemeRequest(theme: string): number {
  themeRequest += 1;
  wantedTheme = theme;
  return themeRequest;
}

/** The production flip to a loaded sheet, and what follows it. */
function flipToLoadedTheme(theme: string): boolean {
  if (theme === onScreenTheme) return true;
  if (!showThemeLink(theme)) return false;
  finishThemeChange(theme, readHostCanvasColorFromAppliedCss());
  return true;
}

/**
 * Put `theme` on screen synchronously. Returns true when it is on screen on
 * return, and false — having changed nothing — when that cannot be done
 * synchronously: in production because the theme's stylesheet has not
 * loaded, and in dev always, because the dev server's one HMR'd theme module
 * cannot flip synchronously — unless `theme` is already on screen. A false
 * is answered with {@link applyTheme}. Either way it supersedes any apply
 * still in flight.
 */
export function applyLoadedTheme(theme: string): boolean {
  beginThemeRequest(theme);
  if (theme === onScreenTheme) return true;
  if (!import.meta.env.PROD) return false;
  return flipToLoadedTheme(theme);
}

/**
 * Put `theme` on screen, waiting for its CSS if need be. Resolves true once
 * it is on screen. In production this loads the theme's stylesheet and ends
 * in the same flip as {@link applyLoadedTheme}; in dev it POSTs to
 * /__themes/activate, which re-renders the active-theme virtual module via
 * HMR. [D03] Resolves false when a later request superseded it.
 */
export async function applyTheme(theme: string): Promise<boolean> {
  const request = beginThemeRequest(theme);
  if (import.meta.env.PROD) {
    if (!(await loadThemeLink(theme))) return false;
    if (request !== themeRequest) return false;
    return flipToLoadedTheme(theme);
  }
  try {
    const res = await fetch("/__themes/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    });
    if (!res.ok) {
      console.warn(`applyTheme: activate failed for "${theme}" (${res.status})`);
      return false;
    }
    const result = (await res.json()) as { hostCanvasColor?: string };
    if (request !== themeRequest) {
      // The dev server now serves `theme`, which nobody wants any more. When
      // the request that superseded this one posted nothing — it asked for
      // the theme already on screen — put that theme back on the server.
      if (wantedTheme !== theme && wantedTheme === onScreenTheme) {
        void applyTheme(wantedTheme);
      }
      return false;
    }
    finishThemeChange(
      theme,
      typeof result.hostCanvasColor === "string" ? result.hostCanvasColor : null,
    );
    return true;
  } catch (err: unknown) {
    console.warn(`applyTheme: activate request failed for "${theme}"`, err);
    return false;
  }
}

/**
 * Load `theme`'s stylesheet ahead of use, so a later switch to a workspace
 * wearing it is synchronous. A no-op in dev, which has no per-theme assets.
 */
export function preloadTheme(theme: string): void {
  if (!import.meta.env.PROD) return;
  void loadThemeLink(theme);
}

// ---------------------------------------------------------------------------
// syncDevActiveTheme — dev startup reconciliation
// ---------------------------------------------------------------------------

/**
 * Dev-only: bring the dev server's in-memory active theme in line with the
 * theme this client actually wants, on startup.
 *
 * In dev the active stylesheet is the `virtual:tug-active-theme.css` module,
 * seeded at boot from a best-effort `tugbank read` in the Vite server's OWN
 * environment — which resolves a different per-instance db than this app
 * variant writes to. So the seeded theme can disagree with the theme this
 * client read from its own instance (e.g. the server boots ironclad while this
 * variant is caravel). POST the client's theme to `/__themes/activate` so the
 * server re-renders the right one and records it as active — which is also what
 * makes a later theme-css edit re-render THIS theme instead of snapping back to
 * the stale boot seed.
 *
 * No-ops in production (no dev server, no endpoint) and never persists — the
 * value came from tugbank, so there is nothing to write back. The server
 * skips the write (and the HMR) when the baked theme already matches, so the
 * common case is a cheap no-op with no flash.
 */
export async function syncDevActiveTheme(themeName: string): Promise<void> {
  if (import.meta.env.PROD) return;
  try {
    const res = await fetch("/__themes/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: themeName }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { hostCanvasColor?: string };
    if (typeof data.hostCanvasColor === "string") {
      sendCanvasColor(data.hostCanvasColor);
    }
  } catch {
    // Best-effort; the dev server's boot seed stands if the sync fails.
  }
}

// ---------------------------------------------------------------------------
// ThemeContext
// ---------------------------------------------------------------------------

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ---------------------------------------------------------------------------
// TugThemeProvider
// ---------------------------------------------------------------------------

/**
 * React context provider for theme state.
 *
 * Exposes `theme` and `setTheme` via React context. Registers a setter with
 * the action-dispatch system so the set-theme control frame can update the
 * theme from the Mac menu.
 *
 * `theme` is the theme on screen, read from this module's store — a
 * workspace switch changes it without passing through here. `setTheme` is a
 * theme being CHOSEN: it applies the theme through {@link applyTheme} and,
 * once it is on screen, reports it through `onThemeApplied`, which is where
 * the deck records it on the active workspace. A switch reports nothing,
 * because the workspace already holds the theme it is being shown in.
 */
export function TugThemeProvider({
  children,
  onThemeApplied,
}: {
  children?: React.ReactNode;
  /** Called with the theme name once a chosen theme is the one on screen. */
  onThemeApplied?: (theme: string) => void;
}): React.JSX.Element {
  const theme = useSyncExternalStore(subscribeOnScreenTheme, getOnScreenTheme);

  // The latest callback, read at the moment a chosen theme lands.
  const onThemeAppliedRef = useRef(onThemeApplied);
  useEffect(() => {
    onThemeAppliedRef.current = onThemeApplied;
  });

  const setThemeRef = useRef((newTheme: string): void => {
    void applyTheme(newTheme).then((applied) => {
      if (applied) onThemeAppliedRef.current?.(newTheme);
    });
  });
  const setTheme = setThemeRef.current;

  // Mirror the name outward for the host's Theme submenu checkmark — however
  // the theme changed, including the paths the host cannot see.
  useEffect(() => {
    publishActiveTheme(theme);
  }, [theme]);

  // Register with the action-dispatch system once on mount.
  useEffect(() => {
    registerThemeSetter(setThemeRef.current);
    registerThemeGetter(getOnScreenTheme);
  }, []);

  return React.createElement(
    ThemeContext.Provider,
    { value: { theme, setTheme } },
    children
  );
}

// ---------------------------------------------------------------------------
// useThemeContext hook
// ---------------------------------------------------------------------------

/**
 * Hook to access the current theme name and setter from TugThemeProvider.
 * Must be used within a TugThemeProvider tree.
 */
export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useThemeContext must be used within a TugThemeProvider");
  }
  return ctx;
}

/**
 * Hook that returns the theme context value when inside a TugThemeProvider,
 * or null when used outside one. Safe to call in components that may render
 * both inside and outside a TugThemeProvider (e.g. gallery cards in tests).
 */
export function useOptionalThemeContext(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
