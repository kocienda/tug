/**
 * docket-card-registration.tsx — registers the Docket card ([L25]).
 *
 * An ordinary deck card on the Commit card's pattern: listed in the type
 * picker, seeded through `addCard`'s initial content, restored by
 * `useCardStatePreservation`, reused through `docket-card-open-registry`.
 * Its identity is the docket's name, read from the DOCKETS snapshot for a
 * mounted card and from the bag a parked card remembers, through the one
 * resolver each.
 *
 * @module components/docket/docket-card-registration
 */

import React from "react";

import { registerCard } from "@/card-registry";
import type { CardIdentityFacts } from "@/card-registry";
import { parkedCardBag } from "@/lib/card-identity";
import { getDocketStore } from "@/lib/docket-store";
import { CONTENT_WIDTH_COMFY_PX } from "@/lib/layout-imposer";
import { coerceDocketSeed, DOCKET_CARD_COMPONENT_ID } from "@/lib/open-docket-in-card";
import { DocketCardContent, liveDocketName } from "./docket-card";

/** What a Docket card holds, spelled once for both resolvers. */
function docketIdentityOf(name: string | null, projectDir: string | null): CardIdentityFacts {
  return {
    title: name !== null ? `Docket ${name}` : "Docket",
    secondary: projectDir,
  };
}

function liveDocketIdentity(cardId: string): CardIdentityFacts | null {
  const snapshot = getDocketStore()?.getSnapshot();
  if (snapshot === undefined) return null;
  const name = liveDocketName(cardId, snapshot);
  return name === null ? null : docketIdentityOf(name, null);
}

function parkedDocketIdentity(cardId: string): CardIdentityFacts | null {
  const seed = coerceDocketSeed(parkedCardBag(cardId));
  if (seed === null || seed.docketId === undefined) return null;
  const snapshot = getDocketStore()?.getSnapshot();
  const project = snapshot?.projects.find((p) => p.project_dir === seed.projectDir);
  const name = project?.dockets.find((d) => d.id === seed.docketId)?.name ?? null;
  return docketIdentityOf(name, seed.projectDir ?? null);
}

/** Register the Docket card. Called from `card-kinds.ts`. */
export function registerDocketCard(): void {
  registerCard({
    componentId: DOCKET_CARD_COMPONENT_ID,
    contentFactory: (cardId) => <DocketCardContent cardId={cardId} />,
    defaultMeta: { title: "Docket", icon: "Layers", closable: true },
    // A docket is a record opened in its own card, as a commit is, so it
    // files beside the Commit card.
    category: { label: "Files", icon: "Layers" },
    identity: { live: liveDocketIdentity, parked: parkedDocketIdentity },
    sizePolicy: {
      min: { width: 420, height: 280 },
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 560 },
    },
    takesContentWidth: true,
  });
}
