/**
 * help-docs.ts — the app's two help documents, as the deck names, fetches and
 * links them.
 *
 * The feature guide and the glossary ship inside the app bundle and tugcast
 * serves them at `GET /api/help/{name}` ([B01], [B02]). A help card is keyed
 * by the document it shows, and a link inside one is either a jump within it
 * (`#getting-help`) or a jump to the other (`glossary.md`, `glossary.md#fold`).
 * Everything here is pure over strings except {@link fetchHelpDoc}, so the
 * card's naming, its title and its link reading are one implementation the
 * tests can drive without a page.
 *
 * @module lib/help-docs
 */

/** A help document's name — the route's key and the help card's. */
export type HelpDocName = "features" | "glossary";

/** Every help document, in the order the Help menu lists them. */
export const HELP_DOC_NAMES: readonly HelpDocName[] = ["features", "glossary"];

/** What a help card is called before its document has loaded. */
const FALLBACK_TITLES: Record<HelpDocName, string> = {
  features: "Tug Help",
  glossary: "Glossary",
};

/** Narrow an unknown value to a help document name. */
export function isHelpDocName(value: unknown): value is HelpDocName {
  return value === "features" || value === "glossary";
}

/**
 * A help card's title: the document's first `# ` heading, or the menu item's
 * name when there is no document yet to read it from.
 */
export function helpDocTitle(doc: HelpDocName, markdown: string | null): string {
  if (markdown !== null) {
    for (const line of markdown.split("\n")) {
      const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (match !== null) return match[1];
    }
  }
  return FALLBACK_TITLES[doc];
}

/**
 * The anchor a heading or a glossary term answers to: lowercase, inline
 * markup and punctuation dropped, runs of spaces joined by single hyphens —
 * GitHub's spelling, so a link written for the repository's own rendering
 * lands in the card too. `Fit and Flow` is `fit-and-flow`; `Join draft.` is
 * `join-draft`.
 */
export function helpAnchorSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * A help ref's target — `glossary#split`, `features#stack-and-split`, or a
 * bare document name — as the seed that opens it. Null for anything else, so
 * a ref the card cannot open is never offered as one that can.
 */
export function readHelpRefTarget(target: string): { doc: HelpDocName; anchor?: string } | null {
  const hash = target.indexOf("#");
  const name = hash < 0 ? target : target.slice(0, hash);
  if (!isHelpDocName(name)) return null;
  const anchor = hash < 0 ? "" : target.slice(hash + 1);
  return anchor.length > 0 ? { doc: name, anchor } : { doc: name };
}

/**
 * A help ref's label: the passage its anchor names, spelled as words —
 * `glossary#join-draft` reads "join draft" — or the document's own name when
 * it names only the document.
 */
export function helpRefLabel(seed: { doc: HelpDocName; anchor?: string }): string {
  if (seed.anchor === undefined) return helpDocTitle(seed.doc, null);
  return seed.anchor.replace(/-/g, " ");
}

/** Where a link inside a help card points. */
export type HelpLink =
  | { kind: "anchor"; anchor: string }
  | { kind: "doc"; doc: HelpDocName; anchor: string | null };

/**
 * Read a link's `href` as a help link, or `null` for one that leaves the help
 * documents — a URL, a mail link, a path to anything but the two documents —
 * which the card lets navigate as any other link does.
 */
export function readHelpLink(href: string): HelpLink | null {
  if (href.startsWith("#")) {
    const anchor = decodeAnchor(href.slice(1));
    return anchor.length > 0 ? { kind: "anchor", anchor } : null;
  }
  const match = /^(?:\.\/)?(features|glossary)\.md(?:#(.*))?$/.exec(href);
  if (match === null) return null;
  const doc = match[1] as HelpDocName;
  const anchor = match[2] === undefined ? "" : decodeAnchor(match[2]);
  return { kind: "doc", doc, anchor: anchor.length > 0 ? anchor : null };
}

function decodeAnchor(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Fetch one help document's markdown from tugcast. */
export async function fetchHelpDoc(doc: HelpDocName): Promise<string> {
  const res = await fetch(`/api/help/${doc}`);
  if (!res.ok) {
    throw new Error(
      res.status === 503
        ? "Help isn't available in this build."
        : `Couldn't read the help document (${res.status}).`,
    );
  }
  const body = (await res.json()) as { markdown?: unknown };
  if (typeof body.markdown !== "string") {
    throw new Error("The help document came back empty.");
  }
  return body.markdown;
}
