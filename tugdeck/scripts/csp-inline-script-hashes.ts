/**
 * csp-inline-script-hashes.ts — admit the deck's own inline scripts by hash.
 *
 * `index.html`'s Content-Security-Policy does not carry `'unsafe-inline'` in
 * `script-src`. That clause is what turns a sanitizer miss in rendered HTML (an
 * `onerror=` attribute that survived, say) into a string on the screen rather than
 * script with the host bridges in reach. The deck still has inline scripts of its own —
 * the lead recorder and the React commit census in `index.html`, which have to run
 * before the vendor chunk evaluates, and the dev server's React refresh preamble — so
 * each one is admitted by the SHA-256 of its exact text.
 *
 * The hashes are computed from the HTML as served, after every other plugin has
 * injected its tags, so an edited script or a new one is admitted by the same build
 * that changed it and nobody keeps a list by hand.
 */

import { createHash } from "crypto";
import type { Plugin as VitePlugin } from "vite";

/**
 * Every inline `<script>` (one with no `src`) in `html`, as its exact text. A comment
 * is consumed whole, so a `<script>` written inside one is not a script.
 */
export function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const re = /<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m[1] === undefined) continue;
    if (/\bsrc\s*=/i.test(m[1])) continue;
    if (m[2].length === 0) continue;
    bodies.push(m[2]);
  }
  return bodies;
}

/** The CSP source expression for `body`: `'sha256-<base64>'` over its UTF-8 bytes. */
export function scriptHashSource(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

/**
 * `html` with a hash source for each of its inline scripts appended to the
 * `script-src` directive of its CSP `<meta>`. Throws when there is no such directive,
 * because a page whose policy could not be amended is a page whose own scripts the
 * browser will refuse.
 */
export function addInlineScriptHashes(html: string): string {
  const sources = [...new Set(inlineScriptBodies(html).map(scriptHashSource))];
  const re = /(<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*?\bscript-src\b)([^;"]*)/i;
  if (!re.test(html)) {
    throw new Error("csp-inline-script-hashes: index.html has no CSP <meta> with a script-src directive");
  }
  if (sources.length === 0) return html;
  return html.replace(re, (_all, head: string, list: string) => `${head}${list} ${sources.join(" ")}`);
}

/** The Vite plugin: amends the policy last, in both the dev server and the build. */
export function cspInlineScriptHashesPlugin(): VitePlugin {
  return {
    name: "tug-csp-inline-script-hashes",
    transformIndexHtml: {
      order: "post",
      handler: (html) => addInlineScriptHashes(html),
    },
  };
}
