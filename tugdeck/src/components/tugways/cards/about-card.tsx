/**
 * about-card.tsx — About box (app-level singleton card).
 *
 * An Apple-style About box: app icon tile, wordmark, version + build,
 * build diagnostics (profile · branch, commit), and copyright. All
 * identity comes from {@link appInfoStore}, populated by the Swift
 * host's `show-card` payload; with no host (browser-only dev) every
 * field renders an em-arc placeholder.
 *
 * Shown via the app menu's About Tug item, which routes through
 * `DeckManager.showSingletonCard("about")` — at most one About card
 * exists at a time.
 *
 * Laws: external state enters through `useSyncExternalStore` [L02];
 * layout/appearance live in about-card.css [L06].
 *
 * @module components/tugways/cards/about-card
 */

import React, { useLayoutEffect, useSyncExternalStore } from "react";
import { Ship } from "lucide-react";
import { registerCard } from "@/card-registry";
import { appInfoStore } from "@/lib/app-info-store";
import { cardTitleStore } from "@/lib/card-title-store";
import "./about-card.css";

const PLACEHOLDER = "—";

/** Shorten a full SHA to the conventional 8-character display form. */
function shortCommit(commit: string | undefined): string {
  if (!commit) return PLACEHOLDER;
  return commit.slice(0, 8);
}

export function AboutCardContent({ cardId }: { cardId: string }) {
  const info = useSyncExternalStore(
    appInfoStore.subscribe,
    appInfoStore.getSnapshot,
  );

  // The variant's display name ("Tug", "Tug-debug", …) — app identity
  // delivered with the rest of the About payload. Drives both the
  // wordmark and the card's chrome title. "Tug" is the generic fallback
  // when no host has delivered identity (browser-only dev).
  const name = info?.name ?? "Tug";
  const version = info?.version ?? PLACEHOLDER;
  const build = info?.build ?? PLACEHOLDER;
  const profile = info?.profile ?? PLACEHOLDER;
  const branch = info?.branch ?? PLACEHOLDER;
  const copyright = info?.copyright ?? PLACEHOLDER;

  // Publish the chrome title from card content via the same
  // `cardTitleStore` mechanism the session card uses. The About card
  // declares no static registry title — its title *is* its dynamic
  // identity — so this override stands alone as the whole title bar
  // ("About Tug-debug"). useLayoutEffect so the title is set before
  // paint, with no empty-base flash.
  useLayoutEffect(() => {
    cardTitleStore.set(cardId, `About ${name}`);
    return () => cardTitleStore.clear(cardId);
  }, [cardId, name]);

  return (
    <div className="about-card" data-testid="about-card">
      {info?.icon ? (
        <img
          className="about-card-icon-image"
          src={info.icon}
          alt=""
          aria-hidden="true"
          data-testid="about-card-icon"
        />
      ) : (
        <div className="about-card-icon" aria-hidden="true">
          <Ship size={40} strokeWidth={1.5} />
        </div>
      )}
      <h1 className="about-card-name">{name}</h1>
      <p className="about-card-version" data-testid="about-card-version">
        Version {version} ({build})
      </p>
      <p className="about-card-detail">
        {profile} · {branch}
      </p>
      <p className="about-card-detail about-card-commit">
        {shortCommit(info?.commit)}
      </p>
      <p className="about-card-copyright">{copyright}</p>
    </div>
  );
}

/**
 * Register the About card. The fixed size policy (`min == max ==
 * preferred`) makes the pane non-resizable — an About box has exactly
 * one correct size — and `placement: "center"` opens it centered in
 * the canvas like a dialog. `hidden` keeps it out of the type-picker
 * `[+]` menu: it is reachable only through the app menu.
 */
export function registerAboutCard(): void {
  registerCard({
    componentId: "about",
    contentFactory: (cardId) => <AboutCardContent cardId={cardId} />,
    // Empty static title: the About card's chrome title is its dynamic
    // identity, published by the content via cardTitleStore once the
    // app name resolves (see AboutCardContent). The empty base lets
    // that override stand alone as the whole title bar.
    defaultMeta: { title: "", closable: true },
    hidden: true,
    placement: "center",
    sizePolicy: {
      min: { width: 320, height: 360 },
      max: { width: 320, height: 360 },
      preferred: { width: 320, height: 360 },
    },
  });
}
