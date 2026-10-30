/**
 * The transient-surface census: every module that draws above a page's
 * content — through the canvas overlay root (`use-canvas-overlay.ts`), or a
 * body's mirror of a surface the overlay draws (`surface-mirror.ts`) — and
 * the page it is drawn in ([B07], [B08]).
 *
 * Built by reading each surface's imports: what it reads decides where it can
 * live. A surface is drawn in one of three pages:
 *
 * - **overlay** — the page above every card. `self-hosted` when the overlay's
 *   own connection carries what it shows (tugcast broadcasts its CONTROL
 *   frames to every page); `relayed` when its truth stays in the shell and
 *   crosses as an overlay-scoped store or action (`bus/declarations/overlay.ts`).
 * - **card** — the card's own page, inside the card's own box: a popover, a
 *   menu or a tooltip a card raises over itself. Every page mounts its own
 *   canvas overlay root, so these never cross.
 * - **shell** — drawn by the shell. None is left: the shell's page goes
 *   beneath the cards, and the shell draws nothing over a card ([B08]).
 *
 * `infrastructure` marks the modules the surfaces are drawn through rather
 * than a surface. `__tests__/overlay-census.test.ts` holds this list to the
 * source: every importer is listed, and nothing listed for the overlay reads
 * a card's geometry.
 *
 * @module overlay/overlay-census
 */

export type SurfacePage = "overlay" | "card" | "shell";

export interface SurfaceCensusEntry {
  /** The module, under `tugdeck/src/`. */
  readonly module: string;
  readonly page: SurfacePage | "infrastructure";
  /** How an overlay surface gets what it shows; absent elsewhere. */
  readonly how?: "self-hosted" | "relayed";
  /** What decided it, read from the module's imports. */
  readonly why: string;
}

export const SURFACE_CENSUS: readonly SurfaceCensusEntry[] = [
  // ---- In the overlay ----
  {
    module: "components/tugways/tug-version-gate.tsx",
    page: "overlay",
    how: "self-hosted",
    why: "An app-modal. Reads the host's version from the tugcast handshake, which the overlay's own connection makes.",
  },
  {
    module: "components/tugways/tug-restore-gate.tsx",
    page: "overlay",
    how: "relayed",
    why: "An app-modal. Reads the restore fold, which only the shell can compute over every card: `overlay.restoreGate`.",
  },
  {
    module: "components/tugways/configure-tug.tsx",
    page: "overlay",
    how: "self-hosted",
    why: "An app-modal. Its auth, version, install and host-tools frames are tugcast broadcasts; the deck's work-card count is `deck.cards`, and its first session is `overlay.openFirstSession`.",
  },
  {
    module: "components/tugways/update-tug.tsx",
    page: "overlay",
    how: "relayed",
    why: "An app-modal. The host reports update state to the shell, which sends each snapshot on in order (`overlay.updateState`), beside the live-turn count (`overlay.liveTurns`); its asks go back as `overlay.updateAction`.",
  },
  {
    module: "components/chrome/update-pill.tsx",
    page: "overlay",
    how: "relayed",
    why: "The update notice. Shares one zoom rect with the wizard, so it is drawn in the wizard's page; reads the same relayed state.",
  },
  {
    module: "components/chrome/zoom-rects.ts",
    page: "overlay",
    how: "relayed",
    why: "The pill's and the wizard's zoom between them, drawn in their page.",
  },
  {
    module: "components/tugways/tug-alert.tsx",
    page: "overlay",
    how: "relayed",
    why: "The shell's alerts (logout, Configure Tug…) are asked of the overlay (`overlay.alert`). A card's own alert stays in its page, which mounts its own provider.",
  },
  {
    module: "components/chrome/open-quickly-overlay.tsx",
    page: "overlay",
    how: "relayed",
    why: "The deck-global Open Quickly dialog. Its open state is the shell's (`overlay.openQuickly`) and so is the project it searches (`deck.frontmostProject`); it searches on the overlay's own connection, and its choice and its close go back (`overlay.openFile`, `overlay.closeOpenQuickly`).",
  },
  {
    module: "components/chrome/zoom-readout.tsx",
    page: "overlay",
    how: "relayed",
    why: "The View › Zoom readout. The overlay applies the deck's zoom to its own root from `deck.facts` and raises the readout in the task that writes that transform.",
  },
  {
    module: "overlay/overlay-surface-drawer.ts",
    page: "overlay",
    how: "relayed",
    why: "A body's surface that escapes its card — the Z2 placard — drawn at the card's rest rect from `overlay.surfaces`, which the shell withdraws while the card moves.",
  },
  {
    module: "overlay/overlay-drawing.ts",
    page: "overlay",
    how: "relayed",
    why: "Draws the surfaces and a drag's indication (`overlay.indication`: zone, merge band, snap guides, ghost tab) into the overlay root, against stationary zones and the pointer.",
  },

  // ---- In the card's own page ----
  {
    module: "components/tugways/tug-popover.tsx",
    page: "card",
    why: "Raised by a control in a card, over that card, from the card's own canvas overlay root.",
  },
  {
    module: "lib/chart/chart-hover.ts",
    page: "card",
    why: "A chart mark's row of its table, in the tooltip's bubble, in the page that draws the chart.",
  },
  {
    module: "components/tugways/tug-tooltip.tsx",
    page: "card",
    why: "A control's tooltip, in the page that draws the control.",
  },
  {
    module: "components/tugways/tug-context-menu.tsx",
    page: "card",
    why: "A right-click menu, in the page the press landed in.",
  },
  {
    module: "components/tugways/tug-editor-context-menu.tsx",
    page: "card",
    why: "The editor's right-click menu, in the editor's page.",
  },
  {
    module: "components/tugways/tug-combo-box.tsx",
    page: "card",
    why: "A field's list, under the field, in the field's page.",
  },
  {
    module: "components/tugways/internal/tug-popup-menu.tsx",
    page: "card",
    why: "A popup button's menu, in the button's page.",
  },
  {
    module: "components/tugways/tug-text-editor.tsx",
    page: "card",
    why: "The editor's completion menus, in the editor's page.",
  },
  {
    module: "components/tugways/chrome/find-wrap-overlay.tsx",
    page: "card",
    why: "The Session card's Find wrap indicator, centred over that card's page.",
  },
  {
    module: "components/tugways/tug-modal-input-dialog.tsx",
    page: "card",
    why: "A dialog the page that raises it draws. The shell raises one, Open Quickly, which is listed under the shell.",
  },
  {
    module: "components/tugways/cards/session-card-telemetry-renderers.tsx",
    page: "card",
    why: "The card's half of a surface the overlay draws for it (`getSurfaceHost`): rendered here, hidden, and mirrored.",
  },

  // ---- What surfaces are drawn through ----
  { module: "components/chrome/canvas-overlay-root.tsx", page: "infrastructure", why: "Every page's portal root." },
  { module: "lib/use-canvas-overlay.ts", page: "infrastructure", why: "The portal root's hook." },
  { module: "lib/canvas-overlay-registry.ts", page: "infrastructure", why: "The portal root's registry." },
  { module: "components/tugways/use-focus-trap.tsx", page: "infrastructure", why: "Traps focus inside a surface drawn in the root." },
  { module: "components/tugways/responder-chain-provider.tsx", page: "infrastructure", why: "Reads the root to keep the responder chain on a drawn surface." },
  { module: "lib/surface-mirror.ts", page: "infrastructure", why: "A body's mirror of a surface the overlay draws: its markup, line and anchor, published as `card.surface`." },
  { module: "body/body-main.ts", page: "infrastructure", why: "A body gone dormant withholds its mirror's surface, and draws it again when it wakes." },
];
