/**
 * theme-constants.ts — single source of truth for the base theme name.
 *
 * Zero dependencies. Importable from:
 *   - Browser runtime (main.tsx, theme-provider.tsx, etc.)
 *   - Vite/Node config (vite.config.ts, via require())
 *   - Bun build scripts (generate-tug-tokens.ts)
 *
 * To change the base theme, change BASE_THEME_NAME here. Everything else
 * references this constant — no other file needs to change.
 */

/** The name of the base theme. Its tokens are the CSS foundation. */
export const BASE_THEME_NAME = "ironclad";
