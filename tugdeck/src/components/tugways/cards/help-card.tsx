/**
 * help-card.tsx — one of the app's help documents, rendered and read-only.
 *
 * Tug ships two help documents, the feature guide and the glossary, and the
 * Help menu opens each as a card ([B03], [B04]). The card fetches its document
 * from tugcast (`GET /api/help/{name}`, the resolver the Operator reads
 * through too) and renders it in the house markdown style with
 * {@link TugMarkdownBlock}: every block in document flow, so a heading or a
 * glossary term an anchor names is in the DOM to scroll to. Its chrome title is
 * the document's own heading.
 *
 * It is keyed by its document: the seed `{ doc, anchor? }` arrives through
 * `addCard`'s initial-content channel and is read back by
 * `useCardStatePreservation`, which is also what `findHelpCardInDeck` reads to
 * bring an open card forward instead of adding a second.
 *
 * Links: `#anchor` scrolls this card; `glossary.md` or `features.md` (with or
 * without an anchor) opens that document's card; anything else navigates as
 * any link in the deck does.
 *
 * Find: ⌘F opens the shared {@link TugFindBar} docked under the document, ⌘G
 * and ⇧⌘G step through the matches, and ⌘E searches for the selection. The
 * engine searches the rendered document's own text
 * (`document-find-engine.ts`), and its session lives as long as the bar.
 *
 * Laws: [L03] the link listener is registered in a layout effect, live before
 *       the first click; [L11] the find commands arrive through the card's
 *       content responder; [L06] appearance via `help-card.css`; [L07] the
 *       registry's scroll handler reads the rendered root through a ref.
 *       The fetched markdown is local data (`useState`), not external state,
 *       so [L02] has nothing to carry.
 *
 * @module components/tugways/cards/help-card
 */

import "./help-card.css";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { registerCard } from "@/card-registry";
import type { CardIdentityFacts } from "@/card-registry";
import { parkedCardBag } from "@/lib/card-identity";
import { cardTitleStore } from "@/lib/card-title-store";
import { CONTENT_WIDTH_COMFY_PX } from "@/lib/layout-imposer";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { useCardStatePreservation } from "@/components/tugways/use-card-state-preservation";
import { TugFindBar, type TugFindBarHandle } from "@/components/tugways/tug-find-bar";
import { documentFindEngine } from "@/components/tugways/document-find-engine";
import { useResponder } from "@/components/tugways/use-responder";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { FindSession } from "@/lib/find-session";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { readFindOptions, putFindOptions } from "@/settings-api";
import {
  fetchHelpDoc,
  helpAnchorSlug,
  helpDocTitle,
  readHelpLink,
  type HelpDocName,
} from "@/lib/help-docs";
import {
  coerceHelpSeed,
  registerOpenHelpCard,
  requestHelpCard,
  unregisterOpenHelpCard,
  type HelpCardSeed,
} from "@/lib/open-help-in-card";

/**
 * The element an anchor names inside a rendered help document: a heading whose
 * slug matches, or a glossary entry — a paragraph opening on its bold term —
 * whose term does.
 */
function findAnchorTarget(root: HTMLElement, anchor: string): HTMLElement | null {
  const wanted = helpAnchorSlug(anchor);
  if (wanted.length === 0) return null;
  for (const heading of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    if (helpAnchorSlug(heading.textContent ?? "") === wanted) return heading;
  }
  for (const term of root.querySelectorAll<HTMLElement>("p > strong:first-child")) {
    if (helpAnchorSlug(term.textContent ?? "") === wanted) {
      return term.parentElement;
    }
  }
  return null;
}

/** What a help card holds — the one place its name is spelled. */
function helpIdentityOf(doc: HelpDocName): CardIdentityFacts {
  return { title: helpDocTitle(doc, null), secondary: null };
}

function parkedHelpIdentity(cardId: string): CardIdentityFacts | null {
  const seed = coerceHelpSeed(parkedCardBag(cardId));
  return seed === null ? null : helpIdentityOf(seed.doc);
}

/**
 * The help card's find bar: the shared {@link TugFindBar} over a session of
 * the card's, which the bar's lifetime bounds — dismissing the bar ends the
 * search.
 */
const HelpCardFindBar = React.forwardRef<
  TugFindBarHandle,
  {
    session: FindSession;
    frameRef: React.RefObject<HTMLElement | null>;
    initialQuery: string;
    onClose: () => void;
  }
>(function HelpCardFindBar({ session, frameRef, initialQuery, onClose }, ref) {
  useEffect(() => () => session.clear(), [session]);
  return (
    <TugFindBar
      ref={ref}
      session={session}
      onClose={onClose}
      cardRootRef={frameRef}
      initialQuery={initialQuery}
      placeholder="Find in help"
      className="help-card-find-bar"
      dataSlot="help-card-find-bar"
      inputTestId="help-card-find-input"
    />
  );
});

type Loaded =
  | { phase: "loading" }
  | { phase: "ready"; markdown: string }
  | { phase: "error"; message: string };

export function HelpCardContent({ cardId }: { cardId: string }): React.ReactElement {
  const [seed, setSeed] = useState<HelpCardSeed | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The anchor still to be honored once the document is on the page.
  const pendingAnchorRef = useRef<string | null>(null);

  // ---- Find ----
  // The bar mounts while `findOpen`; its ref answers "is it up?" (React
  // nulls it on unmount). ⌘E's seed waits in a ref for the bar it opens.
  const [findOpen, setFindOpen] = useState(false);
  const findBarRef = useRef<TugFindBarHandle | null>(null);
  const findSeedRef = useRef("");
  const frameRef = useRef<HTMLDivElement | null>(null);

  // One session for the card, made on the first ⌘F: options seed from, and
  // persist to, the deck-wide find preference, and the engine searches the
  // rendered document. The bar clears it when it goes.
  const findSessionRef = useRef<FindSession | null>(null);
  const findSession = useCallback((): FindSession => {
    if (findSessionRef.current === null) {
      const client = getTugbankClient();
      const seeded = client ? readFindOptions(client) : null;
      const session = new FindSession(seeded ?? undefined, { onOptionsChanged: putFindOptions });
      session.setDelegate(
        documentFindEngine({
          root: () =>
            rootRef.current?.querySelector<HTMLElement>('[data-slot="tug-markdown-block"]') ?? null,
          scroller: () => rootRef.current,
        }),
      );
      findSessionRef.current = session;
    }
    return findSessionRef.current;
  }, []);

  const openFind = useCallback((seed: string | null) => {
    const bar = findBarRef.current;
    if (bar !== null) {
      if (seed === null) bar.focusQuery();
      else bar.setQuery(seed);
      return;
    }
    findSeedRef.current = seed ?? "";
    setFindOpen(true);
  }, []);

  const closeFind = useCallback(() => setFindOpen(false), []);

  // The card's content responder: key-card dispatch starts here wherever
  // focus sits, so ⌘F reaches it from the document, from the bar, or from a
  // card nobody has clicked into. ⌘G / ⇧⌘G step the open bar's session;
  // the bar's own responder answers them first when it holds the keyboard.
  const { ResponderScope, responderRef } = useResponder({
    id: `${cardId}-card-content`,
    kind: "card-content",
    actions: {
      [TUG_ACTIONS.FIND]: () => openFind(null),
      [TUG_ACTIONS.FIND_SELECTION]: () => {
        const root = rootRef.current;
        const sel = window.getSelection();
        if (root === null || sel === null || sel.rangeCount === 0) return;
        if (!sel.getRangeAt(0).intersectsNode(root)) return;
        const query = sel.toString().trim();
        if (query !== "") openFind(query);
      },
      [TUG_ACTIONS.FIND_NEXT]: () => {
        if (findBarRef.current !== null) findSession().next();
      },
      [TUG_ACTIONS.FIND_PREVIOUS]: () => {
        if (findBarRef.current !== null) findSession().previous();
      },
    },
  });

  const setFrame = useCallback(
    (el: HTMLDivElement | null) => {
      frameRef.current = el;
      (responderRef as (node: Element | null) => void)(el);
    },
    [responderRef],
  );

  useCardStatePreservation<HelpCardSeed | undefined>({
    // Only the document persists; an anchor is a one-time scroll.
    onSave: () => (seed === null ? undefined : { doc: seed.doc }),
    onRestore: (state) => {
      const restored = coerceHelpSeed(state);
      if (restored === null) return;
      pendingAnchorRef.current = restored.anchor ?? null;
      setSeed(restored);
    },
  });

  const doc = seed?.doc ?? null;

  useEffect(() => {
    if (doc === null) return;
    let live = true;
    setLoaded({ phase: "loading" });
    fetchHelpDoc(doc).then(
      (markdown) => {
        if (live) setLoaded({ phase: "ready", markdown });
      },
      (error: unknown) => {
        if (live) {
          setLoaded({
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [doc]);

  const markdown = loaded.phase === "ready" ? loaded.markdown : null;

  // The chrome title is the document's heading, set before paint.
  useLayoutEffect(() => {
    if (doc === null) return;
    cardTitleStore.set(cardId, helpDocTitle(doc, markdown));
  }, [cardId, doc, markdown]);
  useLayoutEffect(() => () => cardTitleStore.clear(cardId), [cardId]);

  // Scroll to the seeded anchor once the document has rendered. The block's
  // own layout effect has painted its DOM by the time this one runs.
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const root = rootRef.current;
    if (markdown === null || anchor === null || root === null) return;
    pendingAnchorRef.current = null;
    findAnchorTarget(root, anchor)?.scrollIntoView({ block: "start" });
  }, [markdown]);

  // A re-open of this document from elsewhere scrolls this card — or, when
  // the document is still being read, leaves the anchor for the render.
  useLayoutEffect(() => {
    registerOpenHelpCard(cardId, {
      scrollToAnchor: (anchor) => {
        const root = rootRef.current;
        const target = root === null ? null : findAnchorTarget(root, anchor);
        if (target !== null) target.scrollIntoView({ block: "start" });
        else pendingAnchorRef.current = anchor;
      },
    });
    return () => unregisterOpenHelpCard(cardId);
  }, [cardId]);

  // Links inside the document, caught before the anchor navigates the page.
  // A modified click is caught too: a help link is relative, so letting ⌘ or
  // ⇧ through would load `glossary.md` into this card's own page.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || !root.contains(link)) return;
      const help = readHelpLink(link.getAttribute("href") ?? "");
      if (help === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (help.kind === "anchor") {
        findAnchorTarget(root, help.anchor)?.scrollIntoView({ block: "start" });
      } else if (help.doc === doc) {
        if (help.anchor !== null) {
          findAnchorTarget(root, help.anchor)?.scrollIntoView({ block: "start" });
        }
      } else {
        requestHelpCard(
          help.anchor === null ? { doc: help.doc } : { doc: help.doc, anchor: help.anchor },
          cardId,
        );
      }
    };
    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [cardId, doc]);

  return (
    <ResponderScope>
      {/* The frame stacks the document over the find bar, so the bar docks
          below the scroller rather than scrolling away with the text. */}
      <div ref={setFrame} className="help-card-frame" data-slot="help-card-frame">
        {/* `data-tug-scroll-key` puts this scroller on the region-preservation
            seam, so its position survives a cross-mount and a width change. */}
        <div
          ref={rootRef}
          data-slot="help-card"
          data-help-doc={doc ?? undefined}
          className="help-card"
          data-tug-scroll-key="help-card"
        >
          {loaded.phase === "error" ? (
            <p className="help-card-notice" role="alert">
              {loaded.message}
            </p>
          ) : markdown === null ? (
            <p className="help-card-notice" role="status">
              Reading help…
            </p>
          ) : (
            // Keyed on the document so a different text remounts the block, which
            // renders its text once ([#md-block-api]'s mount-once contract).
            <TugMarkdownBlock key={doc ?? ""} initialText={markdown} className="help-card-body" />
          )}
        </div>
        {findOpen ? (
          <HelpCardFindBar
            ref={findBarRef}
            session={findSession()}
            frameRef={frameRef}
            initialQuery={findSeedRef.current}
            onClose={closeFind}
          />
        ) : null}
      </div>
    </ResponderScope>
  );
}

/**
 * Register the help card. Hidden from the type picker: its doors are the Help
 * menu, links between the documents, and the Overview's help refs.
 */
export function registerHelpCard(): void {
  registerCard({
    componentId: "help",
    contentFactory: (cardId) => <HelpCardContent cardId={cardId} />,
    defaultMeta: { title: "Help", icon: "BookOpen", closable: true },
    // The bag holds the seed from `addCard` on, so the durable answer is
    // the live one too: a help card's document never changes under it.
    identity: { parked: parkedHelpIdentity },
    hidden: true,
    sizePolicy: {
      // A document read at the deck's content width, the one the Text and
      // Commit cards open at.
      min: { width: 420, height: 320 },
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 720 },
    },
    takesContentWidth: true,
  });
}
