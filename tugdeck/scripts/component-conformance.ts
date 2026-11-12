/**
 * component-conformance — the rules that keep the tugways component library a
 * library: which files are primitives, what a primitive may import, and who
 * may reach into `components/tugways/internal/`.
 *
 * Every check is a pure function of a repo-relative path and the file's
 * source text, so the test drives them over fixture strings with no tree and
 * no DOM. `audit-components.ts` walks `tugdeck/src`, applies them, and holds
 * the result against `component-conformance-allowlist.json` with
 * {@link ratchet}: a violation the allowlist does not name fails, and so does
 * an entry that no longer violates, so the allowlist can only shrink.
 *
 * Terms:
 *
 *  - A **primitive** is `components/tugways/tug-*.tsx` (a top-level
 *    primitive) or `components/tugways/internal/tug-*.tsx`.
 *  - An import specifier is **resolved** before any rule reads it: a relative
 *    specifier against the importing file, `@/` against `tugdeck/src`. A
 *    package specifier resolves to nothing and no rule reads it.
 *
 * Rules:
 *
 *  - **T01 internal-import.** Outside the primitives and the exempt set
 *    (everything under `internal/`, `cards/gallery-*.tsx`, `src/spikes/`,
 *    tests), no import resolves under `components/tugways/internal/`. The
 *    internal building blocks are reached through the public primitives.
 *  - **T02 primitive-store.** A top-level primitive imports no domain store:
 *    `lib/…-store…`, `deck-store-registry` or `connection-singleton`. The
 *    environment stores — `page-zoom-store`, `tug-dev-log-store/…`,
 *    `property-store`, `card-modal-hold-store` — are not app domain and do
 *    not make a primitive a feature.
 *  - **T03 prefix-placement.** Every `tug-*.tsx` under `components/tugways/`
 *    is a primitive. The `tug-` prefix promises a library component, so a
 *    feature file that wears it is in the wrong place or has the wrong name.
 *  - **V01 vocabulary.** A primitive takes the shared vocabulary of
 *    `tug-vocabulary.ts` rather than redeclaring it: no literal size union
 *    made only of `TugSize` members (`"sm" | "md" | "lg"`), no literal
 *    `…Density` union, and no `…Props` interface declaring a removed
 *    spelling (`ariaLabel`, `visible`, `subtitle`, `dataSlot`, `fillRole`,
 *    `confirmRole`, `iconRole`, `busyRole`, `onColorRole`, `iconColor`). A
 *    scale that reaches past `TugSize` (a type scale) is its own axis.
 *  - **C01–C09 structure.** A primitive is built the way the authoring guide
 *    (`tuglaws/component-authoring.md`) says: an exported
 *    `Tug<Name>Props` (C01) that extends something (C02), `forwardRef`
 *    (C03), `data-slot="tug-<basename>"` (C04), `className` through `cn()`
 *    (C05), `{...rest}` spread (C06), a leading docblock that cites `[L19]`
 *    (C07) and carries no history — `Phase `, `Spec S`, `[tugplan`, `A2.`,
 *    a backticked commit hash (C08) — and no appearance held in `useState`
 *    (C09), read as a named setter from {@link APPEARANCE_STATE}.
 *  - **L11 callbacks.** No exported `…Props` interface of a primitive
 *    declares a user-action callback ({@link ACTION_CALLBACKS}); the action
 *    travels the responder chain. An `Omit` in the `extends` clause is not a
 *    declaration.
 *  - **R01 slot-before-rest.** In a primitive, a JSX tag that spreads
 *    `{...rest}` writes its `data-slot` before the spread, so a caller's
 *    `data-slot` overrides it ([L19]: identity and defaults, then the spread,
 *    then what the component must keep).
 *  - **R02 handler-after-rest.** In a primitive, no `on…` attribute precedes
 *    `{...rest}` in the same tag: a handler written there is silently replaced
 *    by a caller's handler of the same name. The control destructures the
 *    name and writes the composed handler after the spread.
 *  - **G01 gallery.** Some `cards/gallery-*.tsx` imports every top-level
 *    primitive. It reads the whole tree, so it is {@link checkTree}'s, not
 *    {@link checkFile}'s.
 *
 * @module scripts/component-conformance
 */

import path from "path";

export type RuleId =
  | "T01"
  | "T02"
  | "T03"
  | "C01"
  | "C02"
  | "C03"
  | "C04"
  | "C05"
  | "C06"
  | "C07"
  | "C08"
  | "C09"
  | "V01"
  | "L11"
  | "R01"
  | "R02"
  | "G01";

export interface Violation {
  rule: RuleId;
  /** Repo-relative path of the offending file (`tugdeck/src/…`). */
  path: string;
  /** What was found: the resolved module reached, or the misplaced name. */
  detail: string;
}

/** `{ "<rule>": { "<repo-relative path>": "<reason>" } }`. */
export type Allowlist = Partial<Record<RuleId, Record<string, string>>>;

const SRC = "tugdeck/src";
const TUGWAYS = `${SRC}/components/tugways`;
const INTERNAL = `${TUGWAYS}/internal`;

/** A top-level primitive: `components/tugways/tug-*.tsx`. */
export function isTopLevelPrimitive(file: string): boolean {
  return path.posix.dirname(file) === TUGWAYS && isTugTsx(file);
}

/** A primitive: top-level, or `components/tugways/internal/tug-*.tsx`. */
export function isPrimitive(file: string): boolean {
  return (
    isTopLevelPrimitive(file) ||
    (path.posix.dirname(file) === INTERNAL && isTugTsx(file))
  );
}

function isTugTsx(file: string): boolean {
  const base = path.posix.basename(file);
  return base.startsWith("tug-") && base.endsWith(".tsx") && !base.endsWith(".test.tsx");
}

/** Files T01 does not read: `internal/`, gallery cards, spikes and tests. */
export function isT01Exempt(file: string): boolean {
  const base = path.posix.basename(file);
  return (
    file.startsWith(`${INTERNAL}/`) ||
    (path.posix.dirname(file) === `${TUGWAYS}/cards` &&
      base.startsWith("gallery-") &&
      base.endsWith(".tsx")) ||
    file.startsWith(`${SRC}/spikes/`) ||
    file.split("/").includes("__tests__") ||
    /\.test\.tsx?$/.test(base)
  );
}

// `import … from "x"` (the clause may span lines), `import "x"`, and the
// re-export `export … from "x"`, which reaches the module just as an import
// does. A `;` or a quote ends the clause, so one statement never swallows the
// next.
const IMPORT_RE =
  /^[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;

/** Every module specifier the source imports or re-exports, in order. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * The repo-relative path a specifier names, without extension, or `null` for
 * a package specifier.
 */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let resolved: string;
  if (specifier.startsWith("@/")) {
    resolved = `${SRC}/${specifier.slice(2)}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    resolved = path.posix.join(path.posix.dirname(fromFile), specifier);
  } else {
    return null;
  }
  return path.posix.normalize(resolved).replace(/\.(tsx?|jsx?)$/, "");
}

function resolvedImports(file: string, source: string): string[] {
  const out = new Set<string>();
  for (const spec of importSpecifiers(source)) {
    const resolved = resolveSpecifier(file, spec);
    if (resolved !== null) out.add(resolved);
  }
  return [...out];
}

/** T01: a non-primitive outside the exempt set reaches into `internal/`. */
export function checkInternalImport(file: string, source: string): Violation[] {
  if (!file.startsWith(`${SRC}/`) || !/\.tsx?$/.test(file)) return [];
  if (isPrimitive(file) || isT01Exempt(file)) return [];
  return resolvedImports(file, source)
    .filter((target) => target.startsWith(`${INTERNAL}/`))
    .map((target) => ({ rule: "T01", path: file, detail: target }));
}

const ENVIRONMENT_STORES = [
  `${SRC}/lib/page-zoom-store`,
  `${SRC}/lib/tug-dev-log-store/`,
  `${SRC}/lib/property-store`,
  `${SRC}/lib/card-modal-hold-store`,
];

/** Whether a resolved module is a domain store ([P11]'s line). */
export function isDomainStore(resolved: string): boolean {
  if (
    ENVIRONMENT_STORES.some((env) =>
      env.endsWith("/") ? resolved.startsWith(env) : resolved === env,
    )
  ) {
    return false;
  }
  const base = path.posix.basename(resolved);
  if (base === "deck-store-registry" || base === "connection-singleton") return true;
  return resolved.startsWith(`${SRC}/lib/`) && resolved.slice(SRC.length + 5).includes("-store");
}

/** T02: a top-level primitive imports a domain store. */
export function checkPrimitiveStore(file: string, source: string): Violation[] {
  if (!isTopLevelPrimitive(file)) return [];
  return resolvedImports(file, source)
    .filter(isDomainStore)
    .map((target) => ({ rule: "T02", path: file, detail: target }));
}

/**
 * T03: a `tug-*.tsx` under `components/tugways/` that is not a primitive. A
 * test named for the component it tests is not a component, so `__tests__/`
 * is not read.
 */
export function checkPrefixPlacement(file: string): Violation[] {
  if (!file.startsWith(`${TUGWAYS}/`) || !isTugTsx(file) || isPrimitive(file)) return [];
  if (file.split("/").includes("__tests__")) return [];
  return [
    {
      rule: "T03",
      path: file,
      detail: `${path.posix.basename(file)} wears the primitive prefix outside the primitive tier`,
    },
  ];
}

const TUG_SIZES = new Set(["2xs", "xs", "sm", "md", "lg", "xl", "2xl"]);

const REMOVED_PROPS = [
  "ariaLabel",
  "visible",
  "subtitle",
  "dataSlot",
  "fillRole",
  "confirmRole",
  "iconRole",
  "busyRole",
  "onColorRole",
  "iconColor",
];

// A literal union: two or more quoted members joined by `|`, nothing else.
const LITERAL_UNION = /^\s*\|?\s*("[^"]+"\s*(\|\s*"[^"]+"\s*)+)/;

function literalMembers(text: string): string[] | null {
  const m = LITERAL_UNION.exec(text);
  if (m === null) return null;
  const rest = text.slice(m[0].length).trimStart();
  if (rest.length > 0 && !rest.startsWith(";") && !rest.startsWith("\n")) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * The bodies of the `interface …Props` blocks, at their top level only;
 * with `exportedOnly`, of the exported ones.
 */
function propsInterfaceBodies(source: string, exportedOnly = false): string[] {
  const bodies: string[] = [];
  const re = exportedOnly ? /\bexport\s+interface\s+\w*Props\b[^{]*\{/g : /\binterface\s+\w*Props\b[^{]*\{/g;
  for (const m of source.matchAll(re)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    let top = "";
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === "{" || c === "(" || c === "<") depth++;
      else if (c === "}" || c === ")" || (c === ">" && source[i - 1] !== "=")) depth--;
      if (depth === 1 && c !== "}") top += c;
      else if (depth === 1) top += "\n";
    }
    bodies.push(top);
  }
  return bodies;
}

/** V01: a primitive redeclares the shared vocabulary or a removed spelling. */
export function checkVocabulary(file: string, source: string): Violation[] {
  if (!isPrimitive(file)) return [];
  const found: string[] = [];
  for (const m of source.matchAll(/\btype\s+(\w*(Size|Density))\s*=([^;]*);/g)) {
    const members = literalMembers(m[3]);
    if (members === null) continue;
    if (m[2] === "Density") found.push(`${m[1]} is a local density union`);
    else if (members.every((x) => TUG_SIZES.has(x))) found.push(`${m[1]} is a local size union`);
  }
  for (const m of source.matchAll(/^\s+size\??:\s*([^;\n]*);/gm)) {
    const members = literalMembers(m[1]);
    if (members !== null && members.every((x) => TUG_SIZES.has(x))) found.push("a size prop declares a literal size union");
  }
  for (const body of propsInterfaceBodies(source)) {
    for (const name of REMOVED_PROPS) {
      if (new RegExp(`(^|\\n)\\s*${name}\\??\\s*:`).test(body)) found.push(`a props interface declares \`${name}\``);
    }
  }
  return [...new Set(found)].map((detail) => ({ rule: "V01", path: file, detail }));
}

/** `tug-combo-box.tsx` → `combo-box`. */
function componentBase(file: string): string {
  return path.posix.basename(file, ".tsx").slice("tug-".length);
}

/** `tug-combo-box.tsx` → `TugComboBox`. */
export function componentName(file: string): string {
  return (
    "Tug" +
    componentBase(file)
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("")
  );
}

/** The file's leading block comment, or `""` when it opens on code. */
export function leadingDocblock(source: string): string {
  return /^\s*(\/\*[\s\S]*?\*\/)/.exec(source)?.[1] ?? "";
}

/**
 * The source with its comments removed, so a rule that looks for code — a
 * `forwardRef`, a `data-slot` literal, a `cn(`, a `{...rest}` — is not
 * satisfied by prose that names it. A line comment starts at `//` after
 * whitespace or the line's start, which leaves `http://` in a string alone.
 */
export function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

const HISTORY_MARKERS: { label: string; re: RegExp }[] = [
  { label: "`Phase `", re: /Phase / },
  { label: "`Spec S`", re: /Spec S/ },
  { label: "`[tugplan`", re: /\[tugplan/ },
  { label: "`A2.`", re: /A2\./ },
  { label: "a backticked commit hash", re: /`[0-9a-f]{7,12}`/ },
];

/**
 * Appearance held in `useState`, by the setter that holds it. A setter named
 * here is appearance in that file — a highlight, a measured position, a
 * counter's text — and belongs in a ref and the DOM ([L06]).
 */
export const APPEARANCE_STATE: Record<string, string[]> = {
  [`${TUGWAYS}/tug-label.tsx`]: ["setTruncatedText"],
  [`${TUGWAYS}/tug-textarea.tsx`]: ["setCharCount"],
  [`${TUGWAYS}/tug-combo-box.tsx`]: ["setActiveIndex", "setPos"],
};

/**
 * Whether a primitive's file exports a component named for it: `TugComboBox`
 * from `tug-combo-box.tsx`, by any binding but a context. A file that exports
 * none — a context, a helper module, an imperative API with its provider, a
 * family of parts with no part named for the file — is a module rather than a
 * component, and the component rules C01–C06 do not read it; its docblock
 * rules C07 and C08 still do.
 */
export function exportsComponent(file: string, source: string): boolean {
  const name = componentName(file);
  const binding = new RegExp(`export\\s+(const|function)\\s+${name}\\b([^=\\n]*=\\s*(React\\.)?createContext\\b)?`).exec(source);
  return binding !== null && binding[2] === undefined;
}

/** C01–C09: a primitive is built the way the authoring guide says. */
export function checkStructure(file: string, source: string): Violation[] {
  if (!isPrimitive(file)) return [];
  const out: Violation[] = [];
  const add = (rule: RuleId, detail: string) => out.push({ rule, path: file, detail });
  const component = exportsComponent(file, source);
  const name = `${componentName(file)}Props`;
  const iface = new RegExp(`export\\s+interface\\s+${name}\\b([^{]*)\\{`).exec(source);
  // A component that renders no element of its own — a compound's root that
  // holds state in context for its parts, or a wrapper whose element is the
  // primitive it composes — says so with `@no-element` in its props
  // interface's docblock. The guide extends native props "when wrapping a
  // native element" and forwards its ref to a DOM root, and an element-less
  // component has no root to forward to, name or class, so C02–C05 do not
  // read it; `...rest` (C06) still reaches whatever it composes.
  const noElement = new RegExp(
    `/\\*\\*(?:(?!\\*/)[\\s\\S])*@no-element(?:(?!\\*/)[\\s\\S])*\\*/\\s*export\\s+interface\\s+${name}\\b`,
  ).test(source);
  // A discriminated union cannot be an interface, so `export type TugXProps =`
  // satisfies C01, and it satisfies C02 when one of the interfaces it names
  // in this file has an `extends` clause — the native props reach it there.
  const alias = iface === null ? new RegExp(`export\\s+type\\s+${name}\\b[^=]*=([^;]*);`).exec(source) : null;
  const aliasExtends =
    alias !== null &&
    [...alias[1].matchAll(/\b(Tug\w*Props)\b/g)].some(([, member]) =>
      new RegExp(`interface\\s+${member}\\b[^{]*\\bextends\\b`).test(source),
    );
  if (component && iface === null && alias === null) add("C01", `no \`export interface ${name}\``);
  else if (component && !noElement && iface !== null && !/\bextends\b/.test(iface[1])) {
    add("C02", `\`${name}\` extends nothing`);
  } else if (component && !noElement && alias !== null && !aliasExtends) {
    add("C02", `\`${name}\` names no interface that extends native props`);
  }
  const code = codeOf(source);
  if (component && !noElement && !/\bforwardRef\b/.test(code)) add("C03", "the component is not created with `forwardRef`");
  const slot = `tug-${componentBase(file)}`;
  const slotRe = new RegExp(
    `data-slot="${slot}"|"data-slot":\\s*\\w+\\s*=\\s*"${slot}"|data-slot=\\{\\w+\\s*\\?\\?\\s*"${slot}"\\}`,
  );
  if (component && !noElement && !slotRe.test(code)) add("C04", `no \`data-slot="${slot}"\``);
  if (component && !noElement && !/\bcn\(/.test(code)) add("C05", "`className` is not composed with `cn()`");
  if (component && !/\{\s*\.\.\.rest\s*\}/.test(code)) add("C06", "`{...rest}` is not spread");
  const doc = leadingDocblock(source);
  if (!doc.includes("[L19]")) add("C07", "the leading docblock does not cite `[L19]`");
  const history = HISTORY_MARKERS.filter((m) => m.re.test(doc)).map((m) => m.label);
  if (history.length > 0) add("C08", `the leading docblock carries history: ${history.join(", ")}`);
  for (const setter of APPEARANCE_STATE[file] ?? []) {
    if (new RegExp(`,\\s*${setter}\\s*\\]\\s*=\\s*(React\\.)?useState\\b`).test(source)) {
      add("C09", `\`${setter}\` holds appearance in \`useState\``);
    }
  }
  return out;
}

/** The user-action callbacks [L11] sends through the chain instead. */
export const ACTION_CALLBACKS = [
  "onCheckedChange",
  "onPressedChange",
  "onClick",
  "onSelect",
  "onSelectSlot",
  "onSelectOption",
  "onClose",
  "onChange",
  "onSubmit",
  "onSettle",
];

/** L11: an exported props interface of a primitive declares a callback. */
export function checkCallbacks(file: string, source: string): Violation[] {
  if (!isPrimitive(file)) return [];
  const found = new Set<string>();
  for (const body of propsInterfaceBodies(source, true)) {
    for (const name of ACTION_CALLBACKS) {
      if (new RegExp(`(^|\\n)\\s*${name}\\??\\s*:`).test(body)) found.add(name);
    }
  }
  return [...found].map((name) => ({
    rule: "L11",
    path: file,
    detail: `a props interface declares \`${name}\``,
  }));
}

/**
 * The authoring guide's code held to the same [L11] list. A fenced
 * TypeScript block in the guide that declares, in a props interface, a
 * callback the chain carries instead teaches the shape the checker refuses
 * in a primitive. Returns one line per problem, naming the block's opening
 * line; empty means the guide's interfaces are clean. Nothing is
 * allowlisted. The one exemption is the guide's own counter-example: a
 * declaration whose line carries `❌` is the guide showing what not to write.
 */
export function checkGuide(markdown: string): string[] {
  const problems: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^```(ts|tsx|typescript)\s*$/.test(lines[i])) continue;
    const open = i + 1;
    const body: string[] = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    for (const iface of propsInterfaceBodies(body.join("\n"))) {
      for (const line of iface.split("\n")) {
        if (line.includes("❌")) continue;
        for (const name of ACTION_CALLBACKS) {
          if (new RegExp(`^\\s*${name}\\??\\s*:`).test(line)) {
            problems.push(`guide line ${open}: a props interface declares \`${name}\`, which [L11] sends through the chain`);
          }
        }
      }
    }
  }
  return problems;
}

/**
 * The source with every comment blanked to spaces, newlines kept, so an
 * offset into it is an offset into the file and a line number reads true.
 */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}

/**
 * The text with everything inside `{…}` and inside a quoted attribute value
 * blanked, so what remains is a tag's attribute names at its own level.
 */
function attributeLevel(text: string): string {
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  for (const c of text) {
    if (quote !== null) {
      out += c === quote ? c : " ";
      if (c === quote) quote = null;
    } else if (c === "{") {
      depth++;
      out += " ";
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      out += " ";
    } else if (depth > 0) {
      out += c === "\n" ? c : " ";
    } else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out;
}

/** One JSX opening tag that spreads `{...rest}`, split at the spread. */
export interface RestSpreadTag {
  /** The tag's name: `div`, `Comp`, `LabelPrimitive.Root`. */
  name: string;
  /** The 1-based line of the spread. */
  line: number;
  /** The tag's attributes before the spread, at the tag's own level. */
  before: string;
  /** The tag's attributes after the spread, at the tag's own level. */
  after: string;
}

/**
 * Every JSX opening tag in the source that spreads `{...rest}` among its
 * attributes. An object spread (`{ ...rest, x }`, `const p = {...rest}`) is
 * not a tag's and is not returned: walking back from it meets an enclosing
 * `{` or the end of a statement before it meets a `<`.
 */
export function restSpreadTags(source: string): RestSpreadTag[] {
  const code = blankComments(source);
  const out: RestSpreadTag[] = [];
  for (const m of code.matchAll(/\{\s*\.\.\.rest\s*\}/g)) {
    const at = m.index ?? 0;
    let depth = 0;
    let start = -1;
    for (let i = at - 1; i >= 0; i--) {
      const c = code[i];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === ";" || c === ">")) break;
      else if (depth === 0 && c === "<" && /[A-Za-z]/.test(code[i + 1] ?? "")) {
        start = i;
        break;
      }
    }
    if (start < 0) continue;
    const from = at + m[0].length;
    let end = -1;
    let quote: string | null = null;
    depth = 0;
    for (let i = from; i < code.length; i++) {
      const c = code[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (depth === 0 && c === ">") {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    const name = /^<([\w.]+)/.exec(code.slice(start))?.[1] ?? "?";
    out.push({
      name,
      line: code.slice(0, at).split("\n").length,
      before: attributeLevel(code.slice(start + 1 + name.length, at)),
      after: attributeLevel(code.slice(from, end)),
    });
  }
  return out;
}

/**
 * R01 and R02: the root order. A tag that spreads `{...rest}` writes its
 * `data-slot` before the spread, and no handler before it.
 */
export function checkRootOrder(file: string, source: string): Violation[] {
  if (!isPrimitive(file)) return [];
  const out: Violation[] = [];
  for (const tag of restSpreadTags(source)) {
    if (/(^|\s)data-slot\s*=/.test(tag.after)) {
      out.push({ rule: "R01", path: file, detail: `<${tag.name}> at line ${tag.line} writes \`data-slot\` after \`{...rest}\`` });
    }
    for (const h of tag.before.matchAll(/(?:^|\s)(on[A-Z]\w*)\s*=/g)) {
      out.push({ rule: "R02", path: file, detail: `<${tag.name}> at line ${tag.line} writes \`${h[1]}\` before \`{...rest}\`` });
    }
  }
  return out;
}

/** Every per-file rule over one file. */
export function checkFile(file: string, source: string): Violation[] {
  return [
    ...checkInternalImport(file, source),
    ...checkPrimitiveStore(file, source),
    ...checkPrefixPlacement(file),
    ...checkStructure(file, source),
    ...checkVocabulary(file, source),
    ...checkCallbacks(file, source),
    ...checkRootOrder(file, source),
  ];
}

/** Whether a file is a gallery card: `components/tugways/cards/gallery-*.tsx`. */
export function isGalleryCard(file: string): boolean {
  const base = path.posix.basename(file);
  return (
    path.posix.dirname(file) === `${TUGWAYS}/cards` && base.startsWith("gallery-") && base.endsWith(".tsx")
  );
}

/** G01: a top-level primitive no gallery card imports. */
export function checkGallery(files: { path: string; source: string }[]): Violation[] {
  const shown = new Set<string>();
  for (const f of files) {
    if (isGalleryCard(f.path)) for (const target of resolvedImports(f.path, f.source)) shown.add(target);
  }
  return files
    .filter((f) => isTopLevelPrimitive(f.path) && !shown.has(f.path.replace(/\.tsx$/, "")))
    .map((f) => ({ rule: "G01", path: f.path, detail: "no gallery card imports it" }));
}

/** Every rule over the whole tree: the per-file rules and G01. */
export function checkTree(files: { path: string; source: string }[]): Violation[] {
  return [...files.flatMap((f) => checkFile(f.path, f.source)), ...checkGallery(files)];
}

/**
 * Hold violations against the allowlist, both ways. An allowlist entry names
 * a file and a rule, so it covers every violation of that rule in that file.
 * Returns one line per problem; empty means the tree and the list agree.
 */
export function ratchet(violations: Violation[], allowlist: Allowlist): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const v of violations) {
    const key = `${v.rule} ${v.path}`;
    seen.add(key);
    if (allowlist[v.rule]?.[v.path] === undefined) {
      problems.push(`${v.rule} ${v.path}: ${v.detail}`);
    }
  }
  for (const [rule, entries] of Object.entries(allowlist)) {
    for (const file of Object.keys(entries ?? {})) {
      if (!seen.has(`${rule} ${file}`)) {
        problems.push(`${rule} ${file}: allowlisted but no longer violates; remove the entry`);
      }
    }
  }
  return problems;
}
