/**
 * fixture-registrations.tsx — the app-test fixture annex.
 *
 * A **fixture** is a card whose only consumer is the test harness. It is not
 * documentation, it is not a design surface, and no human is meant to browse
 * to it: every fixture is `hidden: true`, so none appears in a pane's `+` type
 * picker. Its only door is `seedDeckState`, which resolves componentIds against
 * the live registry — which is the whole reason a fixture must be registered at
 * all.
 *
 * These lived in the Component Gallery for a long time, where they padded the
 * type picker with things nobody could pick and made the gallery's membership
 * rule unstateable. The gallery is for exemplary demos of established `Tug*`
 * components; a fixture is a test input.
 *
 * **Every fixture names the tests that seed it.** That is the annex's one
 * discipline, and it is what makes the other rule enforceable: a fixture no
 * test seeds any more gets deleted, not kept in case somebody wants it.
 *
 * Three of the five are not new components at all — they are prop-variant
 * registrations of gallery components that stay in the gallery. Importing
 * *from* `components/tugways/cards/` is the intended direction; nothing under
 * `cards/` may import from here.
 *
 * @module fixtures/fixture-registrations
 */

import React from "react";

import { registerCard, type CardSizePolicy } from "@/card-registry";
import { GalleryListView } from "@/components/tugways/cards/gallery-list-view";
import { GalleryMarkdownView } from "@/components/tugways/cards/gallery-markdown-view";

import { FixtureCycleDemo } from "./fixture-cycle-demo";
import { FixtureTranscriptCopy } from "./fixture-transcript-copy";

/** The card family every fixture registers under. */
export const FIXTURE_FAMILY = "fixture";

const FIXTURE_SIZE: CardSizePolicy = {
  min: { width: 400, height: 350 },
  preferred: { width: 640, height: 520 },
};

const FIXTURE_CATEGORY = { label: "Fixtures", icon: "FlaskConical" } as const;

/**
 * Register every app-test fixture.
 *
 * Called from `main.tsx` alongside the other card registrations, and from the
 * `beforeAll` of any test that walks the registry. Registration is not
 * optional: `filterDeckStateByRegistration` drops restored cards whose
 * componentId does not resolve, and `seedDeckState` cannot mount what the
 * registry does not know.
 */
export function registerFixtureCards(): void {
  // Keyboard-focus-cycling fixture for the `useCycleMode` primitive: ⌥⇥
  // toggles a trapped cycle scope, Tab wraps the stops, toggling off restores
  // the resting key view. The real consumer is the session card; this exercises
  // the mechanism in isolation.
  // Seeded by: NOTHING, currently. at0139 drove this and no longer exists;
  // at0140 proves the same mechanism on the real session card instead. By this
  // annex's own rule a fixture no test seeds gets deleted — this one is a
  // candidate, left standing only because removing it is a separate decision
  // from moving it.
  registerCard({
    componentId: "fixture-cycle-demo",
    hidden: true,
    contentFactory: (cardId) => <FixtureCycleDemo cardId={cardId} />,
    defaultMeta: { title: "Cycle Mode", icon: "List", closable: true },
    // Follows its subject: this fixture exists to exercise engaged-mode
    // mechanics, so it is engaged at rest.
    kbfAtRest: true,
    family: FIXTURE_FAMILY,
    acceptsFamilies: [FIXTURE_FAMILY],
    sizePolicy: FIXTURE_SIZE,
    category: FIXTURE_CATEGORY,
  });

  // `TugListView` carrying a `scrollKey`, so the [A9] region-scroll axis
  // captures the list's position into `bag.regionScroll`, and mounted `inline`
  // (every cell in the DOM, no windowing) to mirror the session-card transcript
  // configuration.
  // Seeded by: at0061, at0083, at0331.
  registerCard({
    componentId: "fixture-list-view-scroll-keyed",
    hidden: true,
    contentFactory: (_cardId) => (
      <GalleryListView
        scrollKey="fixture-list-view-scroll"
        inline
        disableStreaming
      />
    ),
    defaultMeta: {
      title: "TugListView (scroll-keyed)",
      icon: "List",
      closable: true,
    },
    family: FIXTURE_FAMILY,
    acceptsFamilies: [FIXTURE_FAMILY],
    sizePolicy: FIXTURE_SIZE,
    category: FIXTURE_CATEGORY,
  });

  // Transcript COPY wiring: mounts the real `useTranscriptCellMenu` handler
  // over a static body (markdown + tool + thinking) so a test can drive real
  // ⌘C / menu-Copy and assert the clipboard.
  // Seeded by: at0188.
  registerCard({
    componentId: "fixture-transcript-copy",
    hidden: true,
    contentFactory: (_cardId) => <FixtureTranscriptCopy />,
    defaultMeta: { title: "Transcript Copy", icon: "Clipboard", closable: true },
    family: FIXTURE_FAMILY,
    acceptsFamilies: [FIXTURE_FAMILY],
    sizePolicy: FIXTURE_SIZE,
    category: FIXTURE_CATEGORY,
  });

  // 1KB of static markdown — small enough that every block fits in one
  // viewport, so block-container children render fully and stay stable across
  // re-mount. The cold-boot selection tests need deterministic anchor paths;
  // the 50KB variant exercises the virtualization-aware path instead.
  // Seeded by: at0010-cold-boot-selection.
  registerCard({
    componentId: "fixture-markdown-1kb",
    hidden: true,
    contentFactory: (_cardId) => <GalleryMarkdownView staticContentSize="1kb" />,
    defaultMeta: { title: "TugMarkdownView (1KB)", icon: "FileText", closable: true },
    family: FIXTURE_FAMILY,
    acceptsFamilies: [FIXTURE_FAMILY],
    sizePolicy: FIXTURE_SIZE,
    category: FIXTURE_CATEGORY,
  });

  // 50KB of static markdown loaded immediately, for predictable scrollable
  // content. Same component code as the 1KB variant, distinct id.
  // Seeded by: at0010-cold-boot-selection, at0010-markdown-selection,
  // at0014-cold-boot-scroll, at0014-scroll-persistence, at0023.
  registerCard({
    componentId: "fixture-markdown-50kb",
    hidden: true,
    contentFactory: (_cardId) => <GalleryMarkdownView staticContentSize="50kb" />,
    defaultMeta: { title: "TugMarkdownView (50KB)", icon: "FileText", closable: true },
    family: FIXTURE_FAMILY,
    acceptsFamilies: [FIXTURE_FAMILY],
    sizePolicy: FIXTURE_SIZE,
    category: FIXTURE_CATEGORY,
  });
}
