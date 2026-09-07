import { defineConfig } from "vite";
import type { Plugin as VitePlugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
// postcss-tug-color expands --tug-color(color, l: lightness, c: chroma) to oklch() at build time.
import postcssTugColor from "./postcss-tug-color";
// theme-editor-core re-hues a theme's Key/Accent axes; shared with
// scripts/apply-theme-editor.ts.
import {
  applyDuet,
  deriveTheme,
  diffMergeBaseline,
  extractBaseline,
  identitySeed,
  isKnownHue,
  type DuetSeed,
} from "./theme-editor-core";
import { fracFromAuthored, chromaFromAuthored, resolveHueAngle } from "./src/components/tugways/tugcolor";

/**
 * Vite plugin: seamless CSS hot-reload when tugcolor.ts changes.
 *
 * Problem: tugcolor.ts is in vite.config.ts's import chain (via
 * postcss-tug-color.ts). Vite treats it as a config dependency and
 * auto-restarts the server on change, crashing the SharedWorker HMR client.
 *
 * Solution:
 *   1. Exclude tugcolor.ts from Vite's watcher (prevents auto-restart).
 *   2. Use fs.watchFile in our plugin to detect changes independently.
 *   3. Touch tug.css to trigger normal CSS HMR.
 *   4. PostCSS plugin re-reads presets from disk on mtime change.
 *
 * Result: edit tugcolor.ts → colors update seamlessly via CSS HMR.
 */
function paletteHotReload(): VitePlugin {
  const paletteEngine = path.resolve(__dirname, "src/components/tugways/tugcolor.ts");
  const tugBase = path.resolve(__dirname, "styles/tug.css");
  return {
    name: "palette-hot-reload",
    configureServer() {
      fs.watchFile(paletteEngine, { interval: 300 }, () => {
        // Touch tug.css so Vite sees a CSS change and re-runs PostCSS.
        // The PostCSS plugin re-reads presets from disk via mtime check.
        const now = new Date();
        fs.utimesSync(tugBase, now, now);
      });
    },
  };
}

/**
 * Virtual module id for the active theme stylesheet.
 *
 * The active theme is NOT a physical file — it is served from this dev
 * server's in-memory `activeThemeName` (below) through a Vite virtual
 * module. The resolved id ends in `.css` so Vite routes it through the CSS
 * pipeline (PostCSS expands `--tug-color()` tokens) and injects it as a
 * stylesheet. `src/css-imports.ts` imports it as a side effect.
 *
 * Why virtual, not a file: every build variant (release / debug / each
 * worktree) runs its OWN dev server process but shares ONE working tree. A
 * physical `tug-active-theme.css` was therefore a single mutable artifact
 * that every variant wrote and every variant's file watcher repainted from —
 * so activating a theme in one variant bled into all the others. Per-process
 * in-memory state has no shared artifact, so variants are isolated by
 * construction and nothing accumulates on disk.
 */
export const ACTIVE_THEME_VIRTUAL_ID = "virtual:tug-active-theme.css";
export const ACTIVE_THEME_RESOLVED_ID = "\0" + ACTIVE_THEME_VIRTUAL_ID;
/** Absolute path to the brio theme CSS file. */
const BASE_THEME_CSS = path.resolve(__dirname, "styles/themes/brio.css");
/** Absolute path to shipped override CSS files. */
export const SHIPPED_THEMES_CSS_DIR = path.resolve(__dirname, "styles/themes");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BASE_THEME_NAME } = require("./src/theme-constants") as { BASE_THEME_NAME: string };

/**
 * The dev server's authoritative record of which theme is currently active.
 *
 * Seeded at server boot from a best-effort `tugbank read` (see
 * `activeThemeVirtualPlugin`), then driven by the client: every successful
 * POST `/__themes/activate` updates it. This — NOT a fresh `tugbank read` —
 * is what the `virtual:tug-active-theme.css` module renders, and what
 * `controlTokenHotReload` re-renders when a theme's CSS is edited.
 *
 * This value lives only in THIS dev server process. Each build variant
 * (release / debug / each worktree) runs its own dev server, so each holds
 * its own active theme — activating a theme in one variant cannot bleed into
 * another. (There is no shared on-disk artifact anymore; the active theme
 * used to be a single `tug-active-theme.css` file in the shared working tree,
 * which is exactly what leaked across variants.)
 *
 * Why not re-read tugbank on every token edit: the dev server resolves its
 * tugbank db from its OWN process environment (`TUG_INSTANCE_ID` /
 * `TUGBANK_PATH`, falling back to legacy `~/.tugbank.db`). The running
 * Tug.app variant writes its theme over HTTP to its own per-instance db —
 * a different file. So a `tugbank read` here returns whatever theme the
 * dev server's (often empty/legacy) db holds, not what the app is actually
 * showing. Re-reading it on each edit was the cause of the "edit a theme
 * css → snaps back to brio" bug: the read returned the base fallback and
 * we baked it over the live theme. The client is the source of truth, and
 * it tells us via `/__themes/activate`.
 */
let activeThemeName: string = BASE_THEME_NAME;

/** Read active theme from tugbank, with base fallback on any error. */
function readActiveThemeFromTugbank(): string {
  try {
    const raw = execSync("tugbank read dev.tugapp.app theme", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return raw || BASE_THEME_NAME;
  } catch {
    return BASE_THEME_NAME;
  }
}

/** Resolve shipped theme CSS path by name. */
function findThemeCssPath(themeName: string, themesCssDir: string): string | null {
  const cssPath = path.join(themesCssDir, `${themeName}.css`);
  return fs.existsSync(cssPath) ? cssPath : null;
}

/** Tiny CSS metadata parser for --tugx-host-canvas-color (literal #rrggbb only). */
export function parseHostCanvasColor(cssText: string): string | null {
  // Strip block comments so commented declarations are ignored.
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, " ");
  const match = withoutComments.match(/--tugx-host-canvas-color\s*:\s*(#[0-9a-fA-F]{6})\s*;/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resolve the active theme's complete CSS text — the body of the
 * `virtual:tug-active-theme.css` module.
 *
 * - For brio (or missing/default): reads styles/themes/brio.css.
 * - For any other theme: reads styles/themes/<name>.css.
 * - Falls back to brio when the named theme is missing or unreadable.
 * - The result is always a complete theme; it is never empty.
 */
function resolveActiveThemeCss(themeName: string): string {
  if (!themeName || themeName === BASE_THEME_NAME) {
    return fs.readFileSync(BASE_THEME_CSS, "utf-8");
  }

  const sourceCssPath = findThemeCssPath(themeName, SHIPPED_THEMES_CSS_DIR);
  if (!sourceCssPath) {
    console.warn(`[active-theme] theme "${themeName}" not found, falling back to brio`);
    return fs.readFileSync(BASE_THEME_CSS, "utf-8");
  }

  try {
    return fs.readFileSync(sourceCssPath, "utf-8");
  } catch (err) {
    console.error(`[active-theme] failed to read CSS for theme "${themeName}":`, err);
    return fs.readFileSync(BASE_THEME_CSS, "utf-8");
  }
}

/**
 * Vite plugin: serve the active theme as the `virtual:tug-active-theme.css`
 * module, sourced from this dev server's in-memory `activeThemeName`.
 *
 * - `configResolved` seeds `activeThemeName` best-effort from tugbank
 *   (`tugbank read dev.tugapp.app theme`). Correct when the dev server
 *   shares the running app variant's tugbank instance; otherwise the client
 *   corrects it on startup via `/__themes/activate` (see `syncDevActiveTheme`).
 *   Either way, `activeThemeName` — not a fresh read — drives later loads.
 * - `load` returns the active theme's complete CSS; PostCSS expands its
 *   `--tug-color()` tokens. The module is never empty.
 * - Same logic for dev and build — in a production build `load` runs at build
 *   time and bakes the seeded theme into the bundle (the production link swap
 *   then overrides it at runtime, [D08]).
 */
function activeThemeVirtualPlugin(): VitePlugin {
  return {
    name: "active-theme-virtual",
    configResolved() {
      activeThemeName = readActiveThemeFromTugbank();
    },
    resolveId(id) {
      if (id === ACTIVE_THEME_VIRTUAL_ID) return ACTIVE_THEME_RESOLVED_ID;
    },
    load(id) {
      if (id === ACTIVE_THEME_RESOLVED_ID) {
        return resolveActiveThemeCss(activeThemeName);
      }
    },
  };
}

/**
 * Re-render the active-theme virtual module on this dev server and tell the
 * client a theme change is coming.
 *
 * Sends `tug:theme-changed` FIRST so the `hmr-bridge` consumer sees it ahead
 * of the CSS update Vite emits for the reloaded module and can skip the
 * per-card state-preservation flush. WebSocket messages are TCP-ordered, so
 * the custom event lands before `reloadModule`'s update. No-op if the module
 * has not been pulled into the graph yet (no client has loaded it).
 */
function repaintActiveTheme(server: import("vite").ViteDevServer): void {
  const mod = server.moduleGraph.getModuleById(ACTIVE_THEME_RESOLVED_ID);
  if (!mod) return;
  server.ws.send({ type: "custom", event: "tug:theme-changed" });
  void server.reloadModule(mod);
}

/**
 * Vite plugin: when a theme source file changes, re-render the active-theme
 * virtual module so the app receives a standard CSS HMR update.
 *
 * Watches styles/themes/*.css (all themes including brio). Only the active
 * theme's own CSS feeds the live stylesheet — editing any other theme's file
 * changes nothing on screen, so we emit no update. The repaint reads from
 * `activeThemeName` (the client's truth), never a fresh `tugbank read` (wrong
 * db — see `activeThemeName`).
 */
function controlTokenHotReload(): VitePlugin {
  return {
    name: "control-token-hot-reload",
    handleHotUpdate({ file, server }) {
      if (file.startsWith(SHIPPED_THEMES_CSS_DIR) && file.endsWith(".css")) {
        const editedTheme = path.basename(file, ".css");
        if (editedTheme === activeThemeName) {
          repaintActiveTheme(server);
        }
        // The virtual module — not this source file — is what the client
        // imports, so suppress Vite's own update for the edited source.
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Theme load middleware — handles /__themes/* endpoints
// Handler functions are exported for unit testing with mocked fs.
//
// Only shipped themes are supported:
//   Shipped theme CSS:  tugdeck/styles/themes (activation source of truth)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveThemeActivation — shared validation for the activate endpoint
//
// Validates the theme exists and parses its --tugx-host-canvas-color metadata,
// returning { theme, hostCanvasColor }. The active stylesheet itself is served
// from the in-memory `activeThemeName` via the virtual module, so this writes
// nothing — the endpoint sets `activeThemeName` and repaints the module.
// ---------------------------------------------------------------------------

/** Return value of resolveThemeActivation on success. */
export interface ActivateResult {
  theme: string;
  hostCanvasColor: string;
}

/**
 * Validate a theme and read its host canvas color.
 *
 * - For the base theme (brio): reads styles/themes/brio.css.
 * - For non-base themes: reads styles/themes/<name>.css from themesCssDir.
 * - Parses --tugx-host-canvas-color from the source CSS file.
 * - Throws if the source CSS is missing or host color metadata is missing/invalid.
 *
 * The active theme name is persisted to tugbank by the client (putTheme) and
 * held in this dev server's in-memory `activeThemeName`; this function only
 * resolves metadata.
 */
export function resolveThemeActivation(
  themeName: string,
  themesCssDir: string,
): ActivateResult {
  const cssPath =
    themeName === BASE_THEME_NAME
      ? BASE_THEME_CSS
      : findThemeCssPath(themeName, themesCssDir);
  if (!cssPath) {
    throw new Error(`Theme '${themeName}' not found`);
  }

  const css = fs.readFileSync(cssPath, "utf-8");
  const hostCanvasColor = parseHostCanvasColor(css);
  if (!hostCanvasColor) {
    throw new Error(`Missing or invalid --tugx-host-canvas-color in ${cssPath}`);
  }
  return { theme: themeName, hostCanvasColor };
}

// ---------------------------------------------------------------------------
// writeMutex — Promise chain that serializes all override file writes.
//
// Pattern: pending = pending.catch(() => {}).then(fn)
// The .catch(() => {}) swallows any previous rejection so fn always executes
// exactly once, regardless of whether the previous write succeeded or failed.
// The alternative .then(fn).catch(fn) would double-execute fn on rejection.
// ---------------------------------------------------------------------------

let pending: Promise<void> = Promise.resolve();

function withMutex(fn: () => Promise<void>): Promise<void> {
  pending = pending.catch(() => {}).then(fn);
  return pending;
}

// ---------------------------------------------------------------------------
// handleThemesActivate — POST /__themes/activate
//
// Parses the request body, validates the theme field, resolves its metadata,
// and returns the response. The caller (middleware) sets `activeThemeName` and
// repaints the virtual module on success. Exported for unit testing.
//
// Parameters:
//   body           — parsed JSON request body (unknown)
//   themesCssDir   — absolute path to shipped theme CSS files
// ---------------------------------------------------------------------------

export async function handleThemesActivate(
  body: unknown,
  themesCssDir: string,
): Promise<{ status: number; body: string }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: JSON.stringify({ error: "invalid request body" }) };
  }
  const b = body as Record<string, unknown>;
  const themeName = b.theme;
  if (!themeName || typeof themeName !== "string" || themeName.trim() === "") {
    return { status: 400, body: JSON.stringify({ error: "theme field is required" }) };
  }
  const name = themeName.trim();

  return new Promise<{ status: number; body: string }>((resolve) => {
    withMutex(async () => {
      try {
        const result = resolveThemeActivation(name, themesCssDir);
        resolve({ status: 200, body: JSON.stringify(result) });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (msg.includes("not found")) {
          resolve({ status: 404, body: JSON.stringify({ error: msg }) });
        } else {
          resolve({ status: 500, body: JSON.stringify({ error: msg }) });
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// handleThemeEditApply — POST /__theme-editor/apply
//
// Re-hues a theme's Key/Accent axes from the clean baseline recipe and writes
// the theme CSS, then re-copies the active theme so HMR repaints. Drives the
// Theme Editor card's Apply button. Dev-only.
// ---------------------------------------------------------------------------

// Per-theme editor state — the living identity-space baseline, the seed last
// applied, and the editor's own last CSS output. Lets the next Apply diff-merge
// hand edits (made directly to the .css) apart from the editor's own writes.
// Dev-local cache (gitignored): rebuilt from the committed .css on first use.
interface ThemeEditorEntry {
  identityBaseline: Record<string, string>;
  appliedSeed: DuetSeed;
  lastGenCss: string;
}
type ThemeEditorState = Record<string, ThemeEditorEntry>;

function themeEditorStatePath(themesCssDir: string): string {
  return path.join(themesCssDir, "theme-editor-state.json");
}

function loadThemeEditorState(themesCssDir: string): ThemeEditorState {
  try {
    return JSON.parse(fs.readFileSync(themeEditorStatePath(themesCssDir), "utf-8")) as ThemeEditorState;
  } catch {
    return {};
  }
}

function saveThemeEditorState(themesCssDir: string, state: ThemeEditorState): void {
  fs.writeFileSync(themeEditorStatePath(themesCssDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// First Apply for a theme with no cached state: adopt the committed .css as the
// identity origin (appliedSeed = identity, lastGenCss = current). Pre-existing
// hand edits are preserved verbatim because they ARE the baseline; the editor's
// scale/shift simply re-origin to the current file from here on.
function bootstrapThemeState(currentCss: string): ThemeEditorEntry {
  return {
    identityBaseline: extractBaseline(currentCss),
    appliedSeed: identitySeed(),
    lastGenCss: currentCss,
  };
}

export async function handleThemeEditApply(
  body: unknown,
  themesCssDir: string,
): Promise<{ status: number; body: string }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: JSON.stringify({ error: "invalid request body" }) };
  }
  const b = body as Record<string, unknown>;
  const theme = typeof b.theme === "string" ? b.theme.trim() : "";
  const keyHue = typeof b.keyHue === "string" ? b.keyHue.trim() : "";
  const accentHue = typeof b.accentHue === "string" ? b.accentHue.trim() : "";
  // Additive lightness/chroma/alpha deltas off each rung's base. Deltas are oklch
  // nudges on the full-axis ×1000 footing (like l/a) — NOT the chroma value scale
  // (×MAX_CHROMA) — since one delta applies across many tokens of differing hue.
  const frac = (v: unknown): number => (v === undefined ? 0 : fracFromAuthored(Number(v)));
  const parseAdjust = (v: unknown): { lDelta: number; cDelta: number; aDelta?: number } => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return { lDelta: frac(o.lDelta), cDelta: frac(o.cDelta), aDelta: frac(o.aDelta) };
  };
  const key = parseAdjust(b.key);
  const accent = parseAdjust(b.accent);
  if (!theme || !isKnownHue(keyHue) || !isKnownHue(accentHue) ||
      !Number.isFinite(key.lDelta) || !Number.isFinite(key.cDelta) ||
      !Number.isFinite(accent.lDelta) || !Number.isFinite(accent.cDelta)) {
    return { status: 400, body: JSON.stringify({ error: "theme + valid keyHue/accentHue + numeric key/accent {lDelta,cDelta,aDelta} required" }) };
  }

  // Treatments are VALUE colors painted on the key hue, so their chroma is the
  // relative scale resolved against keyHue's angle at the treatment lightness.
  const keyAngle = resolveHueAngle(keyHue);
  const parseTreatment = (v: unknown): { l: number; c: number; a?: number } | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    const l = fracFromAuthored(Number(o.l));
    const c = keyAngle === undefined ? 0 : chromaFromAuthored(Number(o.c), l, keyAngle);
    if (!Number.isFinite(l) || !Number.isFinite(c)) return undefined;
    const a = o.a === undefined ? undefined : fracFromAuthored(Number(o.a));
    return { l, c, a: a !== undefined && Number.isFinite(a) ? a : undefined };
  };
  const titlebar = parseTreatment(b.titlebar);
  const filled = parseTreatment(b.filled);
  const tinted = parseTreatment(b.tinted);
  const textsel = parseTreatment(b.textsel);

  const themeFile = findThemeCssPath(theme, themesCssDir);
  if (!themeFile) {
    return { status: 404, body: JSON.stringify({ error: `theme '${theme}' not found` }) };
  }

  return new Promise<{ status: number; body: string }>((resolve) => {
    withMutex(async () => {
      try {
        const newSeed: DuetSeed = {
          keyHue, key, accentHue, accent,
          titlebar, filled, tinted, textsel,
        };
        const current = fs.readFileSync(themeFile, "utf-8");

        // Recover the identity-space baseline by folding hand edits made directly
        // to the .css back in (diff-merge against the editor's own last output),
        // so hand tuning survives Apply and the .css stays the source of truth.
        const state = loadThemeEditorState(themesCssDir);
        const prior = state[theme] ?? bootstrapThemeState(current);
        const baseline = diffMergeBaseline(
          current, prior.lastGenCss, prior.identityBaseline, prior.appliedSeed,
        );

        const { css, keyCount, accentCount } = applyDuet(current, baseline, newSeed);
        fs.writeFileSync(themeFile, css, "utf-8");

        // Persist the merged baseline + this apply so the next diff-merge can tell
        // future hand edits apart from this output.
        state[theme] = { identityBaseline: baseline, appliedSeed: newSeed, lastGenCss: css };
        saveThemeEditorState(themesCssDir, state);

        // The written themes/<theme>.css triggers controlTokenHotReload, which
        // repaints the active-theme virtual module when `theme` is active.
        resolve({ status: 200, body: JSON.stringify({ theme, keyHue, accentHue, keyCount, accentCount }) });
      } catch (err) {
        resolve({ status: 500, body: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// handleThemeDerive — POST /__theme-editor/derive
//
// Generate a family-member theme from a canonical base (brio/harmony) by
// rotating its brand hues, holding perceived chroma + lightness. Writes the
// derived theme CSS. Drives the Theme Deriver card's Generate button. Dev-only.
// ---------------------------------------------------------------------------

export async function handleThemeDerive(
  body: unknown,
  themesCssDir: string,
): Promise<{ status: number; body: string }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: JSON.stringify({ error: "invalid request body" }) };
  }
  const b = body as Record<string, unknown>;
  const base = typeof b.base === "string" ? b.base.trim() : "";
  const out = typeof b.out === "string" ? b.out.trim() : "";
  const keyHue = typeof b.keyHue === "string" ? b.keyHue.trim() : "";
  const accentHue = typeof b.accentHue === "string" ? b.accentHue.trim() : undefined;
  if (!base || !out || !isKnownHue(keyHue) || (accentHue && !isKnownHue(accentHue))) {
    return { status: 400, body: JSON.stringify({ error: "base + out + valid keyHue (+optional accentHue) required" }) };
  }
  // Optional explicit Key color (base editor): absolute OKLCH chroma + lightness
  // the Key ramp's anchor token should take. Absent for plain sibling derives.
  const ka = b.keyAnchor;
  const keyAnchor =
    ka && typeof ka === "object"
      && typeof (ka as Record<string, unknown>).c === "number"
      && typeof (ka as Record<string, unknown>).l === "number"
      ? { c: (ka as { c: number }).c, l: (ka as { l: number }).l }
      : undefined;

  const baseFile = findThemeCssPath(base, themesCssDir);
  const outFile = path.join(themesCssDir, `${out}.css`);
  if (!baseFile) {
    return { status: 404, body: JSON.stringify({ error: `base theme '${base}' not found` }) };
  }

  return new Promise<{ status: number; body: string }>((resolve) => {
    withMutex(async () => {
      try {
        const baseCss = fs.readFileSync(baseFile, "utf-8");
        const { css, count } = deriveTheme(baseCss, keyHue, accentHue, keyAnchor);
        fs.writeFileSync(outFile, css, "utf-8");
        // If the derived theme is active, the written themes/<out>.css triggers
        // controlTokenHotReload, which repaints the active-theme virtual module.
        resolve({ status: 200, body: JSON.stringify({ base, out, keyHue, accentHue, count }) });
      } catch (err) {
        resolve({ status: 500, body: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) });
      }
    });
  });
}

/**
 * Vite plugin: duet API endpoint for the dev server.
 * POST /__theme-editor/apply  — re-hue a theme's Key/Accent axes (legacy).
 * POST /__theme-editor/derive — generate a family member from a base theme.
 */
function themeEditApplyPlugin(): VitePlugin {
  return {
    name: "theme-editor-apply",
    configureServer(server) {
      server.middlewares.use(
        "/__theme-editor",
        (req: import("http").IncomingMessage, res: import("http").ServerResponse, next: () => void) => {
          const url = req.url ?? "/";
          if (req.method === "POST" && url === "/apply") {
            let raw = "";
            req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
            req.on("end", () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
              }
              handleThemeEditApply(parsed, SHIPPED_THEMES_CSS_DIR).then((result) => {
                // Repaint flows through controlTokenHotReload when the written
                // themes/<theme>.css is the active theme — no manual broadcast.
                res.writeHead(result.status, { "Content-Type": "application/json" });
                res.end(result.body);
              }).catch((err) => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
              });
            });
            return;
          }
          if (req.method === "POST" && url === "/derive") {
            let raw = "";
            req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
            req.on("end", () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
              }
              handleThemeDerive(parsed, SHIPPED_THEMES_CSS_DIR).then((result) => {
                // Repaint flows through controlTokenHotReload when the written
                // themes/<out>.css is the active theme — no manual broadcast.
                res.writeHead(result.status, { "Content-Type": "application/json" });
                res.end(result.body);
              }).catch((err) => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
              });
            });
            return;
          }
          next();
        },
      );
    },
  };
}

/**
 * Vite plugin: theme API endpoints for the dev server.
 * POST /__themes/activate     — activate a theme by rewriting the override file
 */
function themeSaveLoadPlugin(): VitePlugin {
  return {
    name: "theme-save-load",
    configureServer(server) {
      server.middlewares.use(
        "/__themes",
        (req: import("http").IncomingMessage, res: import("http").ServerResponse, next: () => void) => {
          const url = req.url ?? "/";

          if (req.method === "POST" && url === "/activate") {
            let raw = "";
            req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
            req.on("end", () => {
              let body: unknown;
              try {
                body = JSON.parse(raw);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
              }
              handleThemesActivate(body, SHIPPED_THEMES_CSS_DIR).then((result) => {
                if (result.status === 200) {
                  // The client is the source of truth for the active theme.
                  // Record what it just activated so the virtual module — and
                  // later theme-css edits — render THIS theme (see
                  // `activeThemeName`), including the startup sync that
                  // corrects a stale boot seed. Repaint only on a real change:
                  // a no-op re-activate (e.g. startup sync of an
                  // already-correct theme) needs no HMR and no flash.
                  try {
                    const parsed = JSON.parse(result.body) as { theme?: string };
                    if (typeof parsed.theme === "string" && parsed.theme !== activeThemeName) {
                      activeThemeName = parsed.theme;
                      repaintActiveTheme(server);
                    }
                  } catch {
                    // Keep the prior active theme; no repaint.
                  }
                }
                res.writeHead(result.status, { "Content-Type": "application/json" });
                res.end(result.body);
              }).catch((err) => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
              });
            });
            return;
          }

          next();
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Capabilities virtual module (D6.c).
//
// Resolves `import "virtual:capabilities/system-metadata"` to the raw JSONL
// contents of `<repo-root>/capabilities/<LATEST>/system-metadata.jsonl`. The
// artifact is produced by the tugcast capture binary (D6.a) and consumed by
// tugdeck's SessionMetadata fixture (D5) as the source of truth for slash
// commands / skills / agents available to the UI.
//
// HMR: watches the pointer + snapshot files so dev-server reloads pick up
// a new version bump without a manual restart.
// ---------------------------------------------------------------------------

export const CAPABILITIES_VIRTUAL_ID = "virtual:capabilities/system-metadata";
export const CAPABILITIES_RESOLVED_ID = "\0" + CAPABILITIES_VIRTUAL_ID;
const CAPABILITIES_ROOT = path.resolve(__dirname, "..", "capabilities");

export function loadCapabilitiesSnapshot(
  root: string = CAPABILITIES_ROOT,
): { content: string; snapshotPath: string; version: string } {
  const latestPath = path.join(root, "LATEST");
  if (!fs.existsSync(latestPath)) {
    throw new Error(
      `capabilities plugin: ${latestPath} not found — capabilities snapshot is missing`,
    );
  }
  const version = fs.readFileSync(latestPath, "utf-8").trim();
  if (!version) {
    throw new Error(`capabilities plugin: ${latestPath} is empty`);
  }
  const snapshotPath = path.join(root, version, "system-metadata.jsonl");
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(
      `capabilities plugin: ${snapshotPath} not found — LATEST points at missing version ${version}`,
    );
  }
  const content = fs.readFileSync(snapshotPath, "utf-8");
  return { content, snapshotPath, version };
}

function capabilitiesVirtualModulePlugin(): VitePlugin {
  let snapshotPath: string | null = null;
  return {
    name: "capabilities-virtual-module",
    resolveId(id) {
      if (id === CAPABILITIES_VIRTUAL_ID) return CAPABILITIES_RESOLVED_ID;
    },
    load(id) {
      if (id === CAPABILITIES_RESOLVED_ID) {
        const { content, snapshotPath: p } = loadCapabilitiesSnapshot();
        snapshotPath = p;
        return `export default ${JSON.stringify(content)};\n`;
      }
    },
    configureServer(server) {
      // The capabilities tree lives outside tugdeck's root, so Vite's watcher
      // doesn't include it by default — add it explicitly.
      const latestPath = path.join(CAPABILITIES_ROOT, "LATEST");
      server.watcher.add(latestPath);
      if (snapshotPath) server.watcher.add(snapshotPath);
    },
    handleHotUpdate({ file, server }) {
      const latestPath = path.join(CAPABILITIES_ROOT, "LATEST");
      if (file === latestPath || (snapshotPath && file === snapshotPath)) {
        const mod = server.moduleGraph.getModuleById(CAPABILITIES_RESOLVED_ID);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          // Re-prime snapshotPath in case LATEST rolled to a different version.
          try {
            snapshotPath = loadCapabilitiesSnapshot().snapshotPath;
            server.watcher.add(snapshotPath);
          } catch {
            // Surface at next request via load() error; don't crash HMR.
          }
          return [mod];
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Discover shipped theme CSS files for production build inputs.
//
// Each styles/themes/<name>.css file is added as a separate Rollup entry
// so Vite processes it through PostCSS (expanding --tug-color() tokens)
// and emits it to dist/assets/themes/<name>.css. The production link swap
// in theme-provider.tsx targets these paths. [D08]
// ---------------------------------------------------------------------------

/**
 * Force every dev response to be a full 200 — never a 304.
 *
 * The WKWebView revalidates each module script against Vite's content-hash
 * etag. When the validator matches, Vite answers 304 and WebKit must supply
 * the body from its own disk cache — but the debug app is force-quit on
 * every rebuild/relaunch, which can tear that cache: the metadata survives
 * (so the conditional request still goes out) while the body blob is gone
 * or corrupt. The 304 then resolves to an empty module script, `main.tsx`
 * never executes, `frontendReady` never fires, and the app hangs at the
 * native splash. Stripping the conditional headers before Vite's etag
 * check makes every load a full-body 200, taking WebKit's cache out of the
 * boot path entirely (~200KB over loopback, irrelevant).
 */
function noConditionalRequestsPlugin(): VitePlugin {
  return {
    name: "tug-no-conditional-requests",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        delete req.headers["if-none-match"];
        delete req.headers["if-modified-since"];
        next();
      });
    },
  };
}

function discoverThemeCssInputs(): Record<string, string> {
  const themesDir = path.resolve(__dirname, "styles", "themes");
  const inputs: Record<string, string> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(themesDir).filter((f) => f.endsWith(".css"));
  } catch {
    // themes dir may not exist yet during first run
  }
  for (const file of files) {
    const name = file.slice(0, -4); // strip .css
    inputs[`themes/${name}`] = path.join(themesDir, file);
  }
  return inputs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// The default build reporter prints one row per emitted asset — 144 of
// them here, the bulk being KaTeX font faces that never change. That is a
// table nobody reads, and it buries the warnings that matter. We drop to
// `logLevel: "warn"` for builds (dev keeps its startup banner) and report
// the one fact worth knowing: how much shipped.
function buildSummaryPlugin() {
  return {
    name: "tug:build-summary",
    apply: "build" as const,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeBundle(_options: any, bundle: Record<string, any>) {
      const entries = Object.values(bundle);
      let bytes = 0;
      for (const entry of entries) {
        const payload = entry.type === "chunk" ? entry.code : entry.source;
        if (typeof payload === "string") bytes += Buffer.byteLength(payload);
        else if (payload) bytes += payload.length;
      }
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      // eslint-disable-next-line no-console
      console.log(`    tugdeck dist: ${entries.length} files, ${mb} MB`);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (defineConfig as any)((env: any = {}) => {
  const tugcastPort = process.env.TUGCAST_PORT || "55255";
  const proxyConfig = {
    "/auth": { target: `http://localhost:${tugcastPort}` },
    "/ws": { target: `ws://localhost:${tugcastPort}`, ws: true },
    "/api": { target: `http://localhost:${tugcastPort}` },
  };

  const themeInputs = discoverThemeCssInputs();

  return {
    // Builds report through buildSummaryPlugin; the dev server keeps its
    // normal banner (the local URL is signal, not noise).
    logLevel: env.command === "build" && !process.env.TUG_BUILD_STREAM ? "warn" : "info",
    plugins: [
      buildSummaryPlugin(),
      noConditionalRequestsPlugin(),
      react(),
      activeThemeVirtualPlugin(),
      paletteHotReload(),
      controlTokenHotReload(),
      themeSaveLoadPlugin(),
      themeEditApplyPlugin(),
      capabilitiesVirtualModulePlugin(),
    ],
    css: {
      postcss: {
        plugins: [postcssTugColor()],
      },
    },
    resolve: {
      // CodeMirror 6 packages MUST be single instances in the bundle. Its
      // Facets and Compartments are identified by object reference, so a
      // second copy of a package is a second, unconfigured set of facets:
      // `@codemirror/commands` shipped a nested `@codemirror/language`, and
      // `indentMore` therefore read a DIFFERENT `indentUnit` facet than the
      // editors configure — silently falling back to its built-in two-space
      // default and making "Spaces per tab" look inert. Deduping is the
      // upstream-documented remedy; `overrides` in package.json keeps the
      // second copy from reappearing on install.
      dedupe: [
        "@codemirror/state",
        "@codemirror/view",
        "@codemirror/language",
        "@codemirror/commands",
      ],
      alias: {
        "@": path.resolve(__dirname, "./src"),
        // Shared client→tugcode message contract ([#step-13c1]). Lives at the
        // repo root (sibling of tugdeck); Vite's default `server.fs.allow`
        // covers it via the `.git` workspace-root detection, so only the alias
        // is needed.
        "@tugproto": path.resolve(__dirname, "../tugproto/src"),
        // lucide@0.564 predates the exports field; point Vite at its ESM entry directly
        lucide: path.resolve(
          __dirname,
          "./node_modules/lucide/dist/esm/lucide/src/lucide.js",
        ),
      },
    },
    server: {
      host: "127.0.0.1",
      proxy: proxyConfig,
      watch: {
        // Exclude tugcolor.ts from Vite's watcher. It's in the config
        // import chain (vite.config → postcss-tug-color → tugcolor),
        // so changes would trigger an auto-restart that crashes SharedWorker.
        // The paletteHotReload plugin handles it via fs.watchFile instead.
        // The crates/*/pkg glob auto-covers every WASM crate's built
        // artifacts; new crates need no edit here.
        ignored: ["**/tugcolor.ts", "**/tugdeck/crates/*/pkg/**"],
      },
      // Pin the HMR host/protocol explicitly. Vite would otherwise
      // infer them from the loaded page's URL — under WKWebView the
      // inference has historically been flaky enough to silently
      // break CSS hot updates without any visible error. `port` is
      // omitted on purpose: Vite mirrors it from the dev server's
      // own port, which is per-instance (derived from
      // TUG_INSTANCE_ID via tugcore::ports::vite_port_default) and
      // not known at config-load time.
      hmr: {
        host: "127.0.0.1",
        protocol: "ws",
        // Suppress Vite's built-in `vite-error-overlay`. Its shadow-DOM
        // window grows unbounded with the babel/rollup stack trace and
        // overflows the laptop viewport with no internal scroll, so the
        // message and code frame scroll off-screen. We render our own
        // viewport-fitting overlay from the same `vite:error` payload —
        // see `src/dev-error-overlay.ts`.
        overlay: false,
      },
    },
    preview: {
      proxy: proxyConfig,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // Tauri app loads from local filesystem — chunk size is not a
      // performance concern. Disable the warning entirely.
      chunkSizeWarningLimit: Infinity,
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "index.html"),
          ...themeInputs,
        },
        output: {
          // Emit per-theme CSS to assets/themes/<name>.css (no hash) so
          // the production link swap can target a stable path. [D08]
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          assetFileNames: (assetInfo: any) => {
            const name = assetInfo.name ?? "";
            if (name.endsWith(".css")) {
              // Theme entry CSS files are named "themes/<themeName>" by discoverThemeCssInputs.
              // Rollup preserves the entry key as the asset name for extracted CSS.
              const names = assetInfo.names ?? [name];
              for (const n of names) {
                if (n.startsWith("themes/") || n.includes("/styles/themes/")) {
                  const themeName = path.basename(n, ".css");
                  return `assets/themes/${themeName}.css`;
                }
              }
            }
            return "assets/[name]-[hash][extname]";
          },
          manualChunks: (id: string) => {
            if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
              return "vendor";
            }
            if (id.includes("node_modules/shiki")) {
              return "shiki";
            }
          },
        },
      },
    },
  };
});
