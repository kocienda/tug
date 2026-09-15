/**
 * The opening-form linter ([P06], [Spec S02]).
 *
 * A card type that declares an unbound width and no opening form is a card the
 * deck sizes across but cannot size down: `getUnboundSizePolicy` composes a
 * zero height floor for it on the strength of a bid that will never be
 * measured. A card type with the form and no width is the mirror — the deck
 * measures a panel at a width the card type never claimed.
 *
 * Neither half is a type error; each is a form declared halfway, which is why
 * this is a test. The registry is the whole domain, so the assertion is set
 * equality over it — and over the SHIPPED registrations rather than fixtures,
 * because a fixture pair would only prove the test can hold two sets side by
 * side.
 *
 * The registration list is `main.tsx`'s, and deliberately duplicated rather
 * than factored out of it: `main.tsx` mounts the app at import, so a test that
 * imported the list would import the app. A card type added there and not here
 * is invisible to this guard, which is the cost of that.
 */

import { describe, expect, it, beforeAll } from "bun:test";

import { getAllRegistrations } from "@/card-registry";
import { registerHelloWorldCard } from "@/components/tugways/cards/hello-world-card";
import { registerSessionCard } from "@/components/tugways/cards/session-card-registration";
import { registerAboutCard } from "@/components/tugways/cards/about-card";
import { registerSettingsCard } from "@/components/tugways/cards/settings-card";
import { registerKeyboardCard } from "@/components/tugways/cards/keyboard-card";
import { registerJotsCard } from "@/components/jots/jots-card-registration";
import { registerOverviewCard } from "@/components/overview/overview-card-registration";
import { registerCardsCard } from "@/components/cards/cards-card-registration";
import { registerLayoutCard } from "@/components/layout/layout-card-registration";
import { registerArcsCard } from "@/components/arcs/arcs-card-registration";
import { registerTextCard } from "@/components/tugways/cards/text-card-registration";
import { registerFileViewCard } from "@/components/tugways/cards/file-view-card-registration";
import { registerDiffCard } from "@/components/tugways/cards/diff-card";

describe("the opening form and the unbound width are declared together", () => {
  beforeAll(() => {
    registerHelloWorldCard();
    registerSessionCard();
    registerAboutCard();
    registerSettingsCard();
    registerKeyboardCard();
    registerJotsCard();
    registerOverviewCard();
    registerCardsCard();
    registerLayoutCard();
    registerArcsCard();
    registerTextCard();
    registerFileViewCard();
    registerDiffCard();
  });

  it("the two sets are identical", () => {
    const withForm: string[] = [];
    const withWidth: string[] = [];
    for (const [componentId, registration] of getAllRegistrations()) {
      if (registration.openingForm !== undefined) withForm.push(componentId);
      if (registration.unboundWidthPolicy !== undefined) {
        withWidth.push(componentId);
      }
    }
    expect(withForm.sort()).toEqual(withWidth.sort());
  });

  it("the Session card is in both", () => {
    // Not a tautology over the assertion above: a regression that dropped BOTH
    // declarations at once would leave two empty sets happily equal, and every
    // unbound card would silently go back to standing at its transcript's
    // floor.
    const session = getAllRegistrations().get("session");
    expect(session?.openingForm).toBeDefined();
    expect(session?.unboundWidthPolicy).toBeDefined();
  });
});
