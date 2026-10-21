/**
 * Every stylesheet the overlay's drawn copy of a body surface is written
 * against.
 *
 * The overlay draws the Z2 placard from the body's markup
 * (`overlay-surface-drawer.ts`), not by rendering its components, so nothing
 * the components import reaches this page on its own. Whatever the placard can
 * mount — the ARC head's lifecycle block, a step fraction, an atom — is styled
 * here or not at all: a copy whose stylesheet is missing draws as bare text,
 * and only in the overlay, while the hidden original in the body looks right.
 *
 * The list is the CSS closure of `session-card-telemetry-renderers.tsx`, the
 * one module whose surface the overlay draws, in import-graph order so the
 * cascade matches the body page's. It is not hand-picked: the four files it
 * replaced were, and the ARC head's block drew unstyled for it.
 * `__tests__/overlay-surface-styles.test.ts` walks the closure and fails on
 * any stylesheet it reaches that is not imported here.
 *
 * @module overlay/overlay-surface-styles
 */

import "../components/tugways/cards/session-card-telemetry-renderers.css";
import "../components/tugways/tug-arc-gauge.css";
import "../components/tugways/tug-pane.css";
import "../components/tugways/tug-tab-bar.css";
import "../components/tugways/internal/tug-button.css";
import "../components/tugways/tug-menu.css";
import "../components/tugways/tug-key-sink.css";
import "../components/tugways/internal/tug-stable-overlay.css";
import "../components/tugways/tug-tooltip.css";
import "../components/tugways/tug-confirm-popover.css";
import "../components/tugways/tug-popover.css";
import "../components/tugways/tug-label.css";
import "../components/tugways/tug-editor-context-menu.css";
import "../components/tugways/tug-push-button.css";
import "../components/tugways/masthead-frame.css";
import "../components/tugways/session-masthead.css";
import "../components/tugways/tug-popup-list.css";
import "../components/tugways/cards/session-activity-card.css";
import "../components/tugways/tug-sparkline.css";
import "../components/tugways/body-kinds/affordances/block-actions-cluster.css";
import "../components/tugways/beat-text.css";
import "../components/tugways/tug-atom-ref.css";
import "../components/tugways/entity-tips.css";
import "../components/tugways/tug-badge.css";
import "../components/tugways/tug-status-mark.css";
import "../components/tugways/tug-session-identity.css";
import "../components/tugways/tug-filter-field.css";
import "../components/tugways/internal/tug-progress-pulsing-dot.css";
import "../components/tugways/tug-progress-indicator.css";
import "../components/tugways/internal/tug-progress-ring.css";
import "../components/tugways/internal/tug-progress-bar.css";
import "../components/tugways/internal/tug-progress-pie.css";
import "../components/tugways/internal/tug-progress-spinner.css";
import "../components/tugways/internal/tug-progress-wave.css";
import "../components/tugways/session-identity-row.css";
import "../components/tugways/tug-markdown-block.css";
import "../components/tugways/tug-commit-atom.css";
import "../components/tugways/arc-lifecycle-mark.css";
import "../components/tugways/arc-phase-mark.css";
import "../components/tugways/tug-arc-track.css";
import "../components/tugways/tug-step-fraction.css";
import "../components/tugways/tug-session-row.css";
import "../components/tugways/tug-list-row.css";
import "../components/tugways/tug-activity-line.css";
import "../components/tugways/tug-path.css";
import "../components/tugways/card-masthead.css";
import "../components/tugways/commit-presentation.css";
import "../components/tugways/commit-sha-text.css";
import "../components/tugways/tug-markdown-text.css";
import "../components/tugways/tug-changes-list.css";
import "../components/tugways/tug-checkbox.css";
import "../components/tugways/body-kinds/diff-block.css";
import "../components/tugways/tug-cue.css";
import "../components/tugways/tug-choice-group.css";
import "../components/tugways/internal/tug-group-utils.css";
import "../components/tugways/blocks/block-chrome.css";
import "../components/tugways/blocks/block-header.css";
import "../components/tugways/chrome/session-caution-badge.css";
import "../components/tugways/blocks/block-strip.css";
import "../components/tugways/blocks/block-notice.css";
import "../components/tugways/tug-meta-run.css";
import "../components/tugways/tug-section-label.css";
import "../components/tugways/commit-masthead.css";
import "../components/tugways/card-slot-badge.css";
import "../components/tugways/tug-slot.css";
import "../components/tugways/tug-slot-layout.css";
import "../components/tugways/tug-column-badge.css";
import "../components/tugways/cards/compaction-progress-sheet.css";
import "../components/tugways/tug-placard.css";
import "../components/tugways/tug-status-cell.css";
import "../components/tugways/cards/side-question-overlay.css";
import "../components/tugways/cards/session-card-telemetry-popovers.css";
import "../components/tugways/tug-transcript-entry.css";
import "../components/tugways/tug-icons.css";
import "../components/tugways/arc-step-list.css";
import "../components/tugways/arc-trouble-notes.css";
import "../components/tugways/arc-verb-row.css";
import "../components/tugways/body-kinds/todo-list-block.css";
import "../components/tugways/tug-list-view.css";
import "../components/tugways/arc-lifecycle-block.css";
import "../components/tugways/arc-lifecycle-line.css";
import "../components/tugways/tug-arc-atom.css";
