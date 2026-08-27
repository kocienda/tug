/**
 * tug-atom-markdown-body.tsx — the transcript user-message body.
 *
 * Renders a submitted prompt as **markdown** (via `TugMarkdownBlock`,
 * static `initialText` mode) so the transcript shows bold / lists /
 * code / headings exactly as the assistant body and the Claude Code
 * TUI do — while keeping the prompt's inline **atom chips** (`@`-mentions,
 * file / command references, pasted-image chips) at their original
 * positions inside that formatted markdown. The prompt *editor* stays
 * plain text; this is the display surface only.
 *
 * The trick is that an atom is encoded in the substrate as a `U+FFFC`
 * (Object Replacement Character) at its position, paired by index with
 * an entry in the `atoms` array. `U+FFFC` is not markdown syntax, so it
 * survives the lex/parse/sanitize pipeline untouched and lands in the
 * rendered DOM at exactly the right spot — whether that's mid-paragraph,
 * inside a list item, or inside a `**bold**` run. After the markdown
 * mounts, {@link injectAtomHosts} walks the rendered text nodes,
 * replaces each `U+FFFC` with an empty inline host span, and the
 * component **portals the real {@link TugAtomChip}** into each host. So
 * the chips are the same inline-SVG, theme-token-reactive, transcript-font
 * chips every other surface renders — not a baked-color `<img>` — and
 * there is zero chip-rendering duplication.
 *
 * Insertion is post-sanitize and post-render, so it sidesteps the two
 * traps of injecting chip markup *before* parsing: the sanitizer would
 * strip the chip's inline `style` (its vertical-align), and the editor's
 * `<img>` data-URI bakes colors and the editor font rather than tracking
 * the transcript theme. A `U+FFFC` past the end of `atoms` (the
 * defensive `buildWirePayload` invariant) is left as a visible character.
 *
 * Laws:
 *  - [L02] no external state; the only React state is the resolved set
 *    of portal mount hosts, derived in a layout effect.
 *  - [L03] `useLayoutEffect` so the chips are grafted before paint —
 *    no flash of raw `U+FFFC`. Child (markdown) layout effects run
 *    before this parent effect, so the markdown DOM exists when we walk.
 *  - [L06] chip appearance flows from `TugAtomChip` (CSS tokens), not
 *    from React state here.
 *  - [L19] file pair (`.tsx` + `.css`), module docstring, exported
 *    props interface, `data-slot="tug-atom-markdown-body"`, forwardRef
 *    so the cell can use the root as its menu anchor.
 *
 * @module components/tugways/cards/tug-atom-markdown-body
 */

import "./tug-atom-markdown-body.css";

import * as React from "react";
import { createPortal } from "react-dom";

import { TugMarkdownBlock } from "../tug-markdown-block";
import { TugAtomChip } from "@/lib/tug-atom-chip";
import { TugSessionCitation } from "@/components/tugways/tug-session-identity";
import {
  isSessionAtomType,
  sessionAtomCallsign,
  sessionAtomProject,
} from "@/lib/session-atom";
import {
  TRANSCRIPT_CHIP_BASE_FONT_SIZE,
  TUG_ATOM_CHAR,
  atomHeightFor,
  transcriptAtomChipVars,
  type AtomSegment,
} from "@/lib/tug-atom-img";
import { hasLeadingCommandAtom } from "@/lib/command-atom";
import { parseSlashCommandLine } from "@/lib/annotator/command-grammar";
import { stampAnnotation } from "@/lib/annotator/annotation-element";
import { payloadForAtom } from "@/lib/annotator/payloads";
import type { AtomPathRoots } from "@/lib/atom-file-path";
import type { AnnotationContext } from "@/lib/annotator/types";
import { buildSlashCommandLine } from "@/lib/slash-commands";
import { decorateChipLabel } from "./tug-atom-text-body";
import type { TurnAddress } from "../tug-transcript-entry";

/** A host span (inside the rendered markdown) plus the atom it carries. */
interface AtomMount {
  host: HTMLElement;
  atom: AtomSegment;
  key: string;
}

const HOST_CLASS = "tug-atom-chip-host";

/**
 * Replace each `U+FFFC` in `root`'s rendered text with an empty inline
 * host span (up to `atomCount`), returning the hosts in document order.
 * A `U+FFFC` past `atomCount` is left as a visible character — the
 * defensive branch mirroring `buildWirePayload`'s invariant.
 *
 * Idempotent across re-runs: if hosts already exist (a StrictMode
 * double-invoke, or any re-render against the same mount-once markdown
 * DOM), the existing hosts are returned and no second walk happens —
 * the first walk already consumed the `U+FFFC` characters. A genuine
 * text change remounts `TugMarkdownBlock` (keyed on the text), producing
 * fresh markdown with no host spans, so the next walk injects anew.
 */
function injectAtomHosts(root: HTMLElement, atomCount: number): HTMLElement[] {
  const existing = root.querySelectorAll<HTMLElement>(`span.${HOST_CLASS}`);
  if (existing.length > 0) return Array.from(existing);
  if (atomCount === 0) return [];

  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n.nodeValue !== null && n.nodeValue.includes(TUG_ATOM_CHAR)) {
      textNodes.push(n as Text);
    }
  }

  const hosts: HTMLElement[] = [];
  let atomIndex = 0;
  for (const node of textNodes) {
    const value = node.nodeValue ?? "";
    const frag = doc.createDocumentFragment();
    let buf = "";
    for (const ch of value) {
      if (ch === TUG_ATOM_CHAR) {
        if (buf !== "") {
          frag.appendChild(doc.createTextNode(buf));
          buf = "";
        }
        if (atomIndex < atomCount) {
          const host = doc.createElement("span");
          host.className = HOST_CLASS;
          frag.appendChild(host);
          hosts.push(host);
        } else {
          frag.appendChild(doc.createTextNode(TUG_ATOM_CHAR));
        }
        atomIndex += 1;
      } else {
        buf += ch;
      }
    }
    if (buf !== "") frag.appendChild(doc.createTextNode(buf));
    node.parentNode?.replaceChild(frag, node);
  }
  return hosts;
}

/**
 * Tag the leading command chip's host span as a clickable command, so a
 * `/command` the user *submitted* carries the same gesture a `/command`
 * the assistant *wrote in backticks* does.
 *
 * The assistant path gets this from the annotator, which walks inline
 * `<code>` spans. A submitted command isn't code — it's a command atom
 * plus its argument atoms, portalled in as chips — so there is nothing in
 * the rendered markdown for that pass to find. Stamping the same
 * annotation here means the transcript root's single delegated click
 * listener services both without knowing the difference.
 *
 * The command line is reconstructed through {@link buildSlashCommandLine}
 * (atoms expand to their values) and split by the same
 * {@link parseSlashCommandLine} the assistant path uses, so the two can't
 * disagree on where the name ends and the args begin.
 *
 * No known-command predicate: the user typed this command and claude
 * expanded it, which is stronger evidence than any catalog lookup.
 */
function tagLeadingCommandHost(
  hosts: ReadonlyArray<HTMLElement>,
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
): void {
  const host = hosts[0];
  if (host === undefined) return;
  if (!hasLeadingCommandAtom(text, atoms, TUG_ATOM_CHAR)) return;
  // Pair each `U+FFFC` with its atom by ordinal — the same alignment
  // `injectAtomHosts` walks — to get the positioned shape the builder wants.
  const positioned: Array<{ position: number; segment: AtomSegment }> = [];
  let at = text.indexOf(TUG_ATOM_CHAR);
  for (let i = 0; at !== -1 && i < atoms.length; i++) {
    positioned.push({ position: at, segment: atoms[i] });
    at = text.indexOf(TUG_ATOM_CHAR, at + 1);
  }
  const parsed = parseSlashCommandLine(
    buildSlashCommandLine(text, positioned),
  );
  if (parsed === null) return;
  stampAnnotation(host, {
    kind: "slash-command",
    name: parsed.name,
    args: parsed.args,
  });
}

/**
 * Stamp the annotation each atom host carries, so a chip the user
 * attached is as actionable in the transcript as the same thing written
 * in prose: a file chip opens its file, a link chip opens its URL.
 *
 * Which atom types get which annotation is {@link payloadForAtom}'s call,
 * shared with the plain-text renderer so the two transcript atom
 * surfaces cannot drift.
 */
function tagAtomHosts(
  hosts: ReadonlyArray<HTMLElement>,
  atoms: ReadonlyArray<AtomSegment>,
  roots: AtomPathRoots | undefined,
): void {
  for (let i = 0; i < hosts.length; i += 1) {
    const host = hosts[i];
    const atom = atoms[i];
    if (atom === undefined) continue;
    // The leading submitted-command chip already carries its own
    // annotation; so does an atom a previous pass could already resolve.
    if (host.dataset.tugAnnotation !== undefined) continue;
    const payload = payloadForAtom(atom, roots);
    if (payload !== null) stampAnnotation(host, payload);
  }
}

export interface TugAtomMarkdownBodyProps {
  /** Raw substrate text with `U+FFFC` placeholders at atom positions. */
  text: string;
  /**
   * Parallel atoms array. The Nth `U+FFFC` in `text` pairs with
   * `atoms[N]`; a surplus `U+FFFC` renders as a visible character.
   */
  atoms: ReadonlyArray<AtomSegment>;
  /**
   * Optional transcript entry address. Retained for call-site
   * compatibility but no longer decorates the chip label: image atoms
   * render their unified `image-N` name verbatim, identical to the
   * plain-text `TugAtomTextBody` path. See {@link decorateChipLabel}.
   */
  address?: TurnAddress;
  /**
   * Annotator inputs for this body's prose — the gate on a command the
   * user wrote inside backticks rather than submitted as an atom.
   * Forwarded to `TugMarkdownBlock`. The submitted-command chip needs no
   * gate; see {@link tagLeadingCommandHost}.
   */
  annotation?: AnnotationContext;
  /** Forwarded to the root element. */
  className?: string;
  /** Forwarded to the root element (test anchor). */
  "data-testid"?: string;
}

/**
 * Markdown-rendered user body with inline atom chips grafted back in.
 * See the module docstring for the mechanism and the laws it honours.
 */
export const TugAtomMarkdownBody = React.forwardRef<
  HTMLDivElement,
  TugAtomMarkdownBodyProps
>(function TugAtomMarkdownBody(
  {
    text,
    atoms,
    address,
    annotation,
    className,
    "data-testid": dataTestid,
  },
  ref,
) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [mounts, setMounts] = React.useState<AtomMount[]>([]);

  // Graft chips after the markdown has mounted. Keyed on `text` only:
  // the text uniquely determines both the rendered markdown DOM and the
  // `U+FFFC` positions the atoms pair with, and `atoms` is submitted
  // together with `text`, so a closure over the current `atoms` is
  // correct for this text. Re-running on every render instead would
  // re-walk a DOM whose `U+FFFC` were already consumed and wrongly drop
  // the chips — hence the explicit, justified dep list.
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const hosts = injectAtomHosts(root, atoms.length);
    tagLeadingCommandHost(hosts, text, atoms);
    tagAtomHosts(hosts, atoms, annotation?.atomPathRoots);
    setMounts(
      hosts.map((host, i) => ({ host, atom: atoms[i], key: `atom-${i}` })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // The roots a project-relative atom value resolves against arrive after
  // the row paints — the card's project binding and the session's cwd both
  // land post-handshake. Re-tag when they change so a mention written
  // against the project root becomes actionable the moment there is a root
  // to count from. Idempotent: an atom already stamped is skipped.
  const atomPathRoots = annotation?.atomPathRoots;
  React.useLayoutEffect(() => {
    if (mounts.length === 0) return;
    tagAtomHosts(mounts.map((m) => m.host), atoms, atomPathRoots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounts, atomPathRoots]);

  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref !== null && ref !== undefined) ref.current = el;
    },
    [ref],
  );

  // Publish the chip's pixel height so the stylesheet can floor the
  // line-box of a chip-bearing markdown line to at least atom-tall —
  // otherwise a chip (taller than the prose line) clips at the line-box
  // edge. Mirrors `TugAtomTextBody`'s floor; the Swift host's
  // `WKWebView.pageZoom` scales the floor with the chip.
  const hostStyle: React.CSSProperties = {
    ...transcriptAtomChipVars(),
    ["--tugx-atom-markdown-body-atom-height" as string]: `${atomHeightFor(TRANSCRIPT_CHIP_BASE_FONT_SIZE)}px`,
  };

  return (
    <div
      ref={setRefs}
      data-slot="tug-atom-markdown-body"
      className={className}
      data-testid={dataTestid}
      style={hostStyle}
    >
      {/* `findable` opts the rendered prompt text into transcript Find; the
          chip SVGs grafted below live in `.tug-atom-chip-host` spans, which
          the find painter excludes (the index projects atoms as no-text). */}
      <TugMarkdownBlock
        key={text}
        initialText={text}
        className="session-card-transcript-code-body"
        annotation={annotation}
        findable
      />
      {mounts.map(({ host, atom, key }) =>
        createPortal(
          // A session atom portals the live identity chip instead of a generic
          // one: same surface, same portal, a subscribed component rather than
          // a drawing of one ([P14]). The callsign is what it resolves through;
          // the value's `<project>/` head rides along as the recorded project
          // so an unresolvable atom still shows the project its value named.
          isSessionAtomType(atom.type) ? (
            <TugSessionCitation
              citedId={sessionAtomCallsign(atom.value)}
              recordedTag={sessionAtomCallsign(atom.value)}
              size="sm"
              context={{
                recordedProject: sessionAtomProject(atom.value),
              }}
              atom={atom}
            />
          ) : (
            <TugAtomChip
              className="tug-atom-chip"
              type={atom.type}
              label={decorateChipLabel(atom, address)}
              value={atom.value}
            />
          ),
          host,
          key,
        ),
      )}
    </div>
  );
});
