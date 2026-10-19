/**
 * Which page this is: the shell, or a body and the card it shows.
 *
 * Set once at boot — `main.tsx` installs the shell, `body-main.ts` installs
 * a body — before the first render, and read by any module that behaves
 * differently in a body. A warm spare installs as a body with no card and
 * learns its card later, once, through {@link bindPageCard}.
 *
 * Before {@link installPage}, the page reads as the shell, so a unit test
 * runs as a shell unless it installs a body.
 *
 * @module bus/page
 */

export interface PageIdentity {
  readonly role: "shell" | "body";
  readonly cardId: string | null;
  readonly componentId: string | null;
}

interface PageState {
  role: "shell" | "body";
  cardId: string | null;
  componentId: string | null;
}

let installed: PageState | null = null;

/** This page, read live. */
export const page = {
  get role(): "shell" | "body" {
    return installed?.role ?? "shell";
  },
  get cardId(): string | null {
    return installed?.cardId ?? null;
  },
  get componentId(): string | null {
    return installed?.componentId ?? null;
  },
  get isShell(): boolean {
    return (installed?.role ?? "shell") === "shell";
  },
  get isBody(): boolean {
    return installed?.role === "body";
  },
} satisfies PageIdentity & { readonly isShell: boolean; readonly isBody: boolean };

/** Say which page this is. Once per page load; a second call throws. */
export function installPage(identity: PageIdentity): void {
  if (installed !== null) throw new Error("installPage: the page is already installed");
  if (identity.role === "shell" && (identity.cardId !== null || identity.componentId !== null)) {
    throw new Error("installPage: the shell shows no card");
  }
  installed = { role: identity.role, cardId: identity.cardId, componentId: identity.componentId };
}

/** A body learns its card: a spare at bind. Throws in the shell, and in a body already bound. */
export function bindPageCard(cardId: string, componentId: string): void {
  if (installed === null || installed.role !== "body") {
    throw new Error("bindPageCard: only a body page shows a card");
  }
  if (installed.cardId !== null && installed.cardId !== cardId) {
    throw new Error(`bindPageCard: this page already shows card ${installed.cardId}`);
  }
  installed.cardId = cardId;
  installed.componentId = componentId;
}

export function _resetPageForTest(): void {
  installed = null;
}
