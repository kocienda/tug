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
 * Production mode: Theme switching swaps a <link id="tug-theme-override">
 * element pointing to the pre-built per-theme CSS asset. Host canvas color
 * is read from CSS metadata token --tugx-host-canvas-color after the override
 * stylesheet is applied. [D08]
 *
 * (#settheme-flow), [D03] Direct load, [D04] Dual persistence,
 * (#s03-theme-provider), [D08] Production link swap
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
} from "react";
import { putTheme } from "../settings-api";
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
// activateProductionTheme — production <link> swap [D08]
// ---------------------------------------------------------------------------

/**
 * Swap a `<link id="tug-theme-override">` element to activate a theme in
 * production mode (no Vite dev server, no POST /__themes/activate).
 *
 * - For the base theme: removes the link element if present (base theme tokens are the CSS foundation).
 * - For non-base themes: sets href to `/assets/themes/<name>.css`, creating the
 *   element if it does not already exist.
 *
 * [D08] Production link swap, (#s03-production-link).
 */
export async function activateProductionTheme(themeName: string): Promise<string | null> {
  const LINK_ID = "tug-theme-override";
  const existing = document.getElementById(LINK_ID) as HTMLLinkElement | null;

  if (themeName === BASE_THEME_NAME) {
    // Base theme tokens take over — remove the override link if present.
    if (existing) {
      existing.remove();
    }
    return readHostCanvasColorFromAppliedCss();
  }

  const href = `/assets/themes/${themeName}.css`;
  const targetHref = new URL(href, window.location.href).href;
  const link = existing ?? document.createElement("link");
  if (!existing) {
    link.id = LINK_ID;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== targetHref) {
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        link.removeEventListener("load", onLoad);
        link.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        link.removeEventListener("load", onLoad);
        link.removeEventListener("error", onError);
        reject(new Error(`Failed to load production theme CSS: ${href}`));
      };
      link.addEventListener("load", onLoad);
      link.addEventListener("error", onError);
      link.href = href;
    }).catch((err: unknown) => {
      console.warn("activateProductionTheme failed", err);
    });
  }
  return readHostCanvasColorFromAppliedCss();
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
 * Exposes `theme` and `setTheme` via React context. Registers a stable setter
 * wrapper with the action-dispatch system so the set-theme control frame can
 * update the theme from the Mac menu.
 *
 * The `setTheme` implementation posts to POST /__themes/activate with the new
 * theme name. The server records it as the active theme, re-renders the
 * virtual:tug-active-theme.css module, and returns { theme, hostCanvasColor }.
 * On success: calls sendCanvasColor(hostCanvasColor), updates React state,
 * persists to localStorage, and calls putTheme(). [D03]
 */
export function TugThemeProvider({
  children,
  initialTheme = BASE_THEME_NAME,
}: {
  children?: React.ReactNode;
  initialTheme?: string;
}): React.JSX.Element {
  const [theme, setThemeState] = useState<string>(initialTheme);

  // Stable ref always pointing at the latest setTheme function.
  // The action-dispatch handler captures this ref once on mount and reads
  // the current value on every call, preventing stale closures.
  const setThemeRef = useRef<(t: string) => void>(() => {});

  const setTheme = (newTheme: string): void => {
    if (import.meta.env.PROD) {
      // Production: swap <link> element and read host color from applied CSS. [D08]
      void activateProductionTheme(newTheme).then((hostCanvasColor) => {
        if (hostCanvasColor) {
          sendCanvasColor(hostCanvasColor);
        }
        setThemeState(newTheme);
        notifyThemeChange();
        try { localStorage.setItem("td-theme", newTheme); } catch { /* unavailable */ }
        putTheme(newTheme);
      });
      return;
    }

    // Dev: POST to activate endpoint — re-renders the active-theme virtual module via HMR. [D03]
    void fetch("/__themes/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: newTheme }),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn(`setTheme: activate failed for "${newTheme}" (${res.status})`);
          return;
        }
        return res.json().then((data: unknown) => {
          const result = data as { theme?: string; hostCanvasColor?: string };
          if (typeof result.hostCanvasColor === "string") {
            sendCanvasColor(result.hostCanvasColor);
          }
          setThemeState(newTheme);
          notifyThemeChange();
          try { localStorage.setItem("td-theme", newTheme); } catch { /* unavailable */ }
          putTheme(newTheme);
        });
      })
      .catch((err: unknown) => {
        console.warn(`setTheme: activate request failed for "${newTheme}"`, err);
      });
  };

  // Keep ref current on every render so the stable wrapper always calls the latest setter.
  useEffect(() => {
    setThemeRef.current = setTheme;
  });

  // Stable ref always pointing at the current theme name.
  const themeRef = useRef<string>(initialTheme);

  // Keep themeRef current so the getter always returns the latest value, and
  // mirror the name outward for the host's Theme submenu checkmark — however
  // the theme changed, including the paths the host cannot see.
  useEffect(() => {
    themeRef.current = theme;
    publishActiveTheme(theme);
  });

  // Register stable wrappers with the action-dispatch system once on mount.
  // The wrappers read from refs so they always access the latest values.
  useEffect(() => {
    registerThemeSetter((themeName: string) => {
      setThemeRef.current(themeName);
    });
    registerThemeGetter(() => themeRef.current);
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
