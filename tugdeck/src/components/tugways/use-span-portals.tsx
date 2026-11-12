/**
 * `useSpanPortals` — mount a React component into every run the annotator
 * marked in a container.
 *
 * The annotator is a DOM pass: it can mark a run as a commit, a path or a
 * session, and it cannot mount a component into it. The bridge is a portal,
 * and three hooks — {@link useCommitTipPortals}, {@link useFileTipPortals} and
 * {@link useSessionCitationPortals} — each held the same one: query the marked
 * spans, keep the run's own words on an attribute and empty the host the first
 * time it is hosted, rebuild the mount list from the live DOM, publish it only
 * when it changed, and portal one node into each host. This is that bridge
 * once. What is mounted, and which facts a mount carries, stay with the kind.
 *
 * **Driven by the pass, not beside it.** The callback goes to
 * `TugMarkdownBlock` as `onAnnotated`, so collection runs after the pass that
 * creates the spans rather than racing it from a second subscription.
 *
 * **The host list is a function of the live DOM, never an accumulation.**
 * `dropStaleWraps` may unwrap a mark whose target stopped resolving, which
 * detaches a node React is portaling into; every pass therefore rebuilds the
 * list from what is in the container now.
 *
 * **The words are saved before the host is emptied.** A later pass finds an
 * empty span and must still know what it said, and the path and session
 * re-checks read the saved words rather than the emptied element.
 *
 * `onAnnotated` is stable for the life of the hook: the kind's `mountFor` is
 * read through a ref at call time, so a caller may close over props.
 *
 * Laws:
 *  - [L03] collection runs in the block's layout effect, before paint.
 *  - [L06] nothing here is appearance state — the hosts are IDENTITY.
 *  - [L27] `onAnnotated` is a registration and hands back its release.
 *
 * @module components/tugways/use-span-portals
 */

import React from "react";
import { createPortal } from "react-dom";

import { breadcrumb } from "@/lib/dom-forensics";

/** A mount: the emptied host and the facts the portal is rendered from. */
export interface SpanMount {
  host: HTMLElement;
}

export interface SpanPortalSpec<M extends SpanMount> {
  /** The hook's name in the `portal.hosts` breadcrumb. */
  name: string;
  /** Every marked span of this kind in a container. */
  selector: string;
  /** The attribute naming what the run stands for; a host without it is passed over. */
  targetAttribute: string;
  /** Where the run's own words are kept once its host is emptied. */
  textAttribute: string;
  /**
   * The mount for a host, called after its words are saved and it is empty.
   * Every own field but `host` is a fact the portal is drawn from, and a
   * change in any of them re-renders the portals.
   */
  mountFor: (host: HTMLElement, target: string, text: string) => M;
  /** The node portalled into a mount's host. */
  render: (mount: M, index: number) => React.ReactNode;
  /** The portal's key — indexed where one post can name a target twice. */
  keyFor: (mount: M, index: number) => string;
}

/**
 * Whether two collections name the same hosts, in the same order, with the
 * same facts. A pass that finds what the last one found publishes nothing.
 */
export function sameMounts<M extends SpanMount>(
  a: readonly M[],
  b: readonly M[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((mount, i) => {
    const other = b[i]!;
    const keys = Object.keys(mount) as (keyof M)[];
    if (keys.length !== Object.keys(other).length) return false;
    return keys.every((key) => mount[key] === other[key]);
  });
}

/**
 * Collect the marked spans in a container and portal into each.
 *
 * Returns the callback to hand `TugMarkdownBlock` as `onAnnotated`, and the
 * portals to render. The portals have no layout of their own — render them
 * anywhere in the consumer's tree; they mount into the spans.
 */
export function useSpanPortals<M extends SpanMount>(
  spec: SpanPortalSpec<M>,
): {
  onAnnotated: (container: HTMLElement) => void;
  portals: React.ReactNode;
} {
  const [mounts, setMounts] = React.useState<readonly M[]>([]);
  const specRef = React.useRef(spec);
  specRef.current = spec;

  const onAnnotated = React.useCallback((container: HTMLElement): void => {
    const { name, selector, targetAttribute, textAttribute, mountFor } =
      specRef.current;
    const next: M[] = [];
    for (const host of Array.from(
      container.querySelectorAll<HTMLElement>(selector),
    )) {
      const target = host.getAttribute(targetAttribute);
      if (target === null || target === "") continue;
      let text = host.getAttribute(textAttribute);
      if (text === null) {
        text = host.textContent ?? "";
        host.setAttribute(textAttribute, text);
        host.textContent = "";
      }
      next.push(mountFor(host, target, text));
    }
    breadcrumb("portal.hosts", { hook: name, hosts: next.length });
    setMounts((prev) => (sameMounts(prev, next) ? prev : next));
  }, []);

  const portals = mounts.map((mount, index) =>
    createPortal(spec.render(mount, index), mount.host, spec.keyFor(mount, index)),
  );

  return { onAnnotated, portals };
}
