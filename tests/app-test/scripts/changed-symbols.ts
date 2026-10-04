/**
 * changed-symbols.ts — resolve a diff's hunks to the named functions they touch.
 *
 * `@covers` resolves a changed PATH to the tests that declare it, and for a hub file that is
 * dozens of tests, each exactly as relevant as the next. What tells them apart is which
 * functions the change actually touched, so this module turns each changed source file into
 * the names of the functions its hunks fall inside, and each such name into the set of words
 * a test that reaches it is likely to spell (its *mention set*).
 *
 * ## One naming rule
 *
 * A *named function-like* in a TS/TSX module is a function declaration, a class method,
 * constructor, getter or setter, a class property or variable whose initializer is a function
 * or arrow, or an object-literal property that is a function when the literal initializes a
 * named variable or is returned from a named function. Class members are named `Class.name`,
 * object-literal members `<owner>.name`. A node with no body — an overload signature, an
 * abstract method, anything under `declare` — is not a symbol. Anything else with a body (an
 * inline callback, an IIFE, an anonymous default export) belongs to its nearest named
 * ancestor, and a line inside no named function-like is *module scope*.
 *
 * The instrumentation plugin in `tugdeck/scripts/` applies the same rule, so a name this
 * module emits is a name an instrumented map can record.
 *
 * Rust and Swift get a line scanner — `fn`/`func`/`init` open a symbol at their `{`, an `impl`
 * or type declaration prefixes `Type.` — that understands strings and comments only well
 * enough to keep braces balanced. A file it cannot balance is module scope as a whole. Every
 * other extension has no symbols.
 */

import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

/** One named function-like, by 1-based line range (both ends inclusive). */
export interface Span {
    name: string;
    start: number;
    end: number;
}

/** What {@link symbolIndex} could say about one file. */
export interface SymbolIndex {
    spans: Span[];
    /** Set when the file has no symbol data: an unsupported extension, or a scan that failed. */
    reason?: string;
    /** True when a scanner could not balance the file; every line is then module scope. */
    failed?: boolean;
}

/** One changed source file, resolved. */
export interface ChangedFile {
    path: string;
    /** Distinct names of the named function-likes the change touched, in first-touch order. */
    symbols: string[];
    /** True when a touched line lies outside every named function-like. */
    moduleScope: boolean;
    /** Why the file has no symbols, when it has none for a reason other than an empty diff. */
    reason?: string;
}

export type MentionRole = "symbol" | "caller" | "surface verb";

/** One member of a changed symbol's mention set. */
export interface Mention {
    /** The full symbol name (`Class.foo`). */
    name: string;
    /** The word a test must spell to mention it: the name's last segment. */
    word: string;
    role: MentionRole;
}

/** The mention set of one changed symbol. */
export interface MentionSet {
    path: string;
    symbol: string;
    members: Mention[];
}

const TEST_SURFACE = "tugdeck/src/test-surface.ts";

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** The named function-likes in one file, sorted by start line. */
export function symbolIndex(path: string, text: string): SymbolIndex {
    const ext = extname(path);
    let index: SymbolIndex;
    if (ext === ".ts" || ext === ".tsx") index = { spans: tsSpans(path, text) };
    else if (ext === ".rs") index = scanBraces(text, "rust");
    else if (ext === ".swift") index = scanBraces(text, "swift");
    else index = { spans: [], reason: `no symbol data for ${ext === "" ? "(no extension)" : ext}` };
    index.spans.sort((a, b) => a.start - b.start || b.end - a.end);
    return index;
}

/** The innermost span containing `line`, or undefined for module scope. */
export function spanAt(spans: Span[], line: number): Span | undefined {
    let best: Span | undefined;
    for (const s of spans) {
        if (line < s.start || line > s.end) continue;
        if (best === undefined || s.end - s.start < best.end - best.start ||
            (s.end - s.start === best.end - best.start && s.start > best.start)) {
            best = s;
        }
    }
    return best;
}

function tsSpans(path: string, text: string): Span[] {
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const spans: Span[] = [];
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const add = (name: string, node: ts.Node) =>
        spans.push({ name, start: lineOf(node.getStart(sf, true)), end: lineOf(node.getEnd()) });

    const isDeclared = (node: ts.Node) =>
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false);

    const memberName = (n: ts.PropertyName | undefined): string | undefined => {
        if (n === undefined) return undefined;
        if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
        if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
        return undefined;
    };

    const unwrap = (e: ts.Expression): ts.Expression => {
        while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) ||
            ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
            e = e.expression;
        }
        return e;
    };

    const fnInit = (e: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined => {
        if (e === undefined) return undefined;
        const u = unwrap(e);
        return ts.isArrowFunction(u) || ts.isFunctionExpression(u) ? u : undefined;
    };

    const children = (node: ts.Node, enclosing: string | undefined) =>
        ts.forEachChild(node, (c) => visit(c, enclosing));

    const visitObject = (obj: ts.ObjectLiteralExpression, owner: string, enclosing: string | undefined) => {
        for (const prop of obj.properties) {
            const name = memberName(prop.name);
            if (name !== undefined &&
                (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) ||
                    ts.isSetAccessorDeclaration(prop)) && prop.body !== undefined) {
                add(`${owner}.${name}`, prop);
                children(prop, `${owner}.${name}`);
            } else if (name !== undefined && ts.isPropertyAssignment(prop) && fnInit(prop.initializer)) {
                add(`${owner}.${name}`, prop);
                children(prop, `${owner}.${name}`);
            } else {
                visit(prop, enclosing);
            }
        }
    };

    const visitClass = (node: ts.ClassLikeDeclaration, enclosing: string | undefined) => {
        let cls = node.name?.text;
        if (cls === undefined && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
            cls = node.parent.name.text;
        }
        for (const member of node.members) {
            if (isDeclared(member)) continue;
            if (cls !== undefined) {
                if (ts.isConstructorDeclaration(member) && member.body !== undefined) {
                    add(`${cls}.constructor`, member);
                    children(member, `${cls}.constructor`);
                    continue;
                }
                const name = memberName(member.name);
                if (name !== undefined) {
                    if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) ||
                        ts.isSetAccessorDeclaration(member)) && member.body !== undefined) {
                        add(`${cls}.${name}`, member);
                        children(member, `${cls}.${name}`);
                        continue;
                    }
                    if (ts.isPropertyDeclaration(member) && fnInit(member.initializer)) {
                        add(`${cls}.${name}`, member);
                        children(member, `${cls}.${name}`);
                        continue;
                    }
                }
            }
            visit(member, enclosing);
        }
    };

    function visit(node: ts.Node, enclosing: string | undefined): void {
        if (isDeclared(node)) return;
        if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
            add(node.name.text, node);
            children(node, node.name.text);
            return;
        }
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            visitClass(node, enclosing);
            return;
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
            const name = node.name.text;
            // A lone declaration's span starts at its statement, so its doc comment is its own.
            const list = node.parent;
            const owner = ts.isVariableDeclarationList(list) && list.declarations.length === 1 &&
                ts.isVariableStatement(list.parent) ? list.parent : node;
            if (fnInit(node.initializer)) {
                add(name, owner);
                children(node, name);
                return;
            }
            const init = unwrap(node.initializer);
            if (ts.isObjectLiteralExpression(init)) {
                visitObject(init, name, enclosing);
                return;
            }
        }
        if (ts.isReturnStatement(node) && node.expression !== undefined && enclosing !== undefined) {
            const e = unwrap(node.expression);
            if (ts.isObjectLiteralExpression(e)) {
                visitObject(e, enclosing, enclosing);
                return;
            }
        }
        children(node, enclosing);
    }

    visit(sf, undefined);
    return spans;
}

// ---------------------------------------------------------------------------
// The Rust and Swift scanners
// ---------------------------------------------------------------------------

interface Tok {
    kind: "ident" | "punct";
    text: string;
    line: number;
}

/** Identifiers and single-character punctuation, with comments and literals skipped. */
function tokenize(text: string, lang: "rust" | "swift"): Tok[] {
    const toks: Tok[] = [];
    let line = 1;
    let i = 0;
    const n = text.length;
    const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
    const isId = (c: string) => /[A-Za-z0-9_]/.test(c);
    // Skip to just past `close`, counting newlines; an unterminated literal ends the text.
    const skipTo = (close: string, escapes: boolean) => {
        while (i < n) {
            if (escapes && text[i] === "\\") { i += 2; continue; }
            if (text.startsWith(close, i)) { i += close.length; return; }
            if (text[i] === "\n") line++;
            i++;
        }
    };
    while (i < n) {
        const c = text[i];
        if (c === "\n") { line++; i++; continue; }
        if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
        if (c === "/" && text[i + 1] === "*") { i += 2; skipTo("*/", false); continue; }
        if (lang === "rust" && (c === "r" || (c === "b" && text[i + 1] === "r")) &&
            !isId(text[i - 1] ?? " ")) {
            const m = /^b?r(#*)"/.exec(text.slice(i, i + 64));
            if (m) { i += m[0].length; skipTo(`"${m[1]}`, false); continue; }
        }
        if (lang === "swift" && c === "#") {
            const m = /^(#+)("""|")/.exec(text.slice(i, i + 64));
            if (m) { i += m[0].length; skipTo(`${m[2]}${m[1]}`, false); continue; }
        }
        if (c === '"') {
            if (lang === "swift" && text.startsWith('"""', i)) { i += 3; skipTo('"""', true); continue; }
            i++;
            skipTo('"', true);
            continue;
        }
        if (lang === "rust" && c === "'") {
            // A char literal ('x', '\n', '{') or a lifetime ('a): only the literal is skipped.
            if (text[i + 1] === "\\") { i += 2; skipTo("'", true); continue; }
            if (text[i + 2] === "'") { i += 3; continue; }
            i++;
            continue;
        }
        if (isIdStart(c)) {
            let j = i + 1;
            while (j < n && isId(text[j])) j++;
            toks.push({ kind: "ident", text: text.slice(i, j), line });
            i = j;
            continue;
        }
        if (!/\s/.test(c)) toks.push({ kind: "punct", text: c, line });
        i++;
    }
    return toks;
}

const SWIFT_TYPE_KEYWORDS = new Set(["class", "struct", "enum", "extension"]);
const SWIFT_NOT_A_TYPE_NAME = new Set(["func", "var", "let", "override", "final", "static", "subscript"]);

interface Frame {
    kind: "fn" | "type" | "block";
    name: string;
    start: number;
}

function scanBraces(text: string, lang: "rust" | "swift"): SymbolIndex {
    const toks = tokenize(text, lang);
    const spans: Span[] = [];
    const frames: Frame[] = [];
    let pending: { kind: "fn" | "type"; name: string; line: number } | undefined;
    let depth = 0; // ( and [ nesting, so a `{` inside an argument list opens no symbol

    const typePrefix = () => {
        for (let k = frames.length - 1; k >= 0; k--) {
            if (frames[k].kind === "type") return `${frames[k].name}.`;
        }
        return "";
    };
    const failed = (): SymbolIndex => ({ spans: [], failed: true, reason: "unbalanced braces" });

    for (let t = 0; t < toks.length; t++) {
        const tok = toks[t];
        const next = toks[t + 1];
        if (tok.kind === "ident") {
            if (lang === "rust" && tok.text === "fn" && next?.kind === "ident") {
                pending = { kind: "fn", name: typePrefix() + next.text, line: tok.line };
                t++;
            } else if (lang === "rust" && tok.text === "impl" && pending?.kind !== "fn") {
                const type = rustImplType(toks, t + 1);
                if (type !== undefined) pending = { kind: "type", name: type, line: tok.line };
            } else if (lang === "swift" && tok.text === "func" && next !== undefined) {
                pending = { kind: "fn", name: typePrefix() + next.text, line: tok.line };
                t++;
            } else if (lang === "swift" && tok.text === "init" && toks[t - 1]?.text !== "." &&
                next !== undefined && ["(", "?", "!", "<"].includes(next.text)) {
                pending = { kind: "fn", name: `${typePrefix()}init`, line: tok.line };
            } else if (lang === "swift" && SWIFT_TYPE_KEYWORDS.has(tok.text) && next?.kind === "ident" &&
                !SWIFT_NOT_A_TYPE_NAME.has(next.text)) {
                // `extension Outer.Inner` names Inner.
                let k = t + 1;
                let name = toks[k].text;
                while (toks[k + 1]?.text === "." && toks[k + 2]?.kind === "ident") {
                    k += 2;
                    name = toks[k].text;
                }
                pending = { kind: "type", name, line: tok.line };
                t = k;
            }
            continue;
        }
        switch (tok.text) {
            case "(":
            case "[":
                depth++;
                break;
            case ")":
            case "]":
                depth = Math.max(0, depth - 1);
                break;
            case ";":
                if (depth === 0) pending = undefined; // a Rust signature with no body
                break;
            case "{":
                if (depth === 0 && pending !== undefined) {
                    frames.push({ kind: pending.kind, name: pending.name, start: pending.line });
                    pending = undefined;
                } else {
                    frames.push({ kind: "block", name: "", start: tok.line });
                }
                break;
            case "}": {
                pending = undefined; // a Swift requirement with no body
                const f = frames.pop();
                if (f === undefined) return failed();
                if (f.kind === "fn") spans.push({ name: f.name, start: f.start, end: tok.line });
                break;
            }
        }
    }
    if (frames.length > 0) return failed();
    return { spans };
}

/** The self type an `impl` header names: `impl<T> Trait for path::Type<T> where …` → `Type`. */
function rustImplType(toks: Tok[], from: number): string | undefined {
    let k = from;
    const header: Tok[] = [];
    let angle = 0;
    for (; k < toks.length && !(toks[k].text === "{" && angle === 0); k++) {
        const t = toks[k];
        if (t.text === "<") angle++;
        else if (t.text === ">" && toks[k - 1]?.text !== "-") angle = Math.max(0, angle - 1);
        else if (angle === 0) {
            if (t.text === "where" || t.text === ";") break;
            header.push(t);
        }
    }
    const forAt = header.findIndex((t) => t.text === "for");
    const rest = forAt >= 0 ? header.slice(forAt + 1) : header;
    let name: string | undefined;
    for (const t of rest) {
        if (t.kind === "ident") {
            if (t.text === "dyn" || t.text === "mut") continue;
            name = t.text;
        } else if (t.text !== ":" && t.text !== "&") {
            break;
        }
    }
    return name;
}

// ---------------------------------------------------------------------------
// Hunks → symbols
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): { ok: boolean; out: string } {
    // `GIT_DIFF_OPTS` takes precedence over `-U0` on the command line, and a context line
    // read as a changed one would name a neighbouring function.
    const env = { ...process.env };
    delete env.GIT_DIFF_OPTS;
    const proc = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString() };
}

/** New-side line ranges of `git diff -U0` hunks; a pure deletion touches its anchor line. */
export function hunkLines(diff: string): number[] {
    const lines: number[] = [];
    for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const c = Number(m[1]);
        const d = m[2] === undefined ? 1 : Number(m[2]);
        if (d === 0) lines.push(Math.max(1, c));
        else for (let l = c; l < c + d; l++) lines.push(l);
    }
    return lines;
}

const distinct = (names: string[]) => [...new Set(names)];

/**
 * Resolve each changed path to the symbols its hunks touch. A tracked file is read against
 * `HEAD` (staged and unstaged together); an untracked file changes every symbol it has; a
 * file deleted from the working tree changes every symbol it had at `HEAD`.
 */
export function changedSymbols(paths: string[], repoRoot: string): ChangedFile[] {
    return paths.map((path) => {
        const abs = join(repoRoot, path);
        const present = existsSync(abs);
        const text = present ? readFileSync(abs, "utf8") : git(["show", `HEAD:${path}`], repoRoot).out;
        const index = symbolIndex(path, text);
        if (index.failed) return { path, symbols: [], moduleScope: true, reason: index.reason };
        if (index.reason !== undefined) return { path, symbols: [], moduleScope: false, reason: index.reason };

        const tracked = git(["ls-files", "--error-unmatch", "--", path], repoRoot).ok;
        if (!tracked || !present) {
            return { path, symbols: distinct(index.spans.map((s) => s.name)), moduleScope: false };
        }
        const symbols: string[] = [];
        let moduleScope = false;
        for (const line of hunkLines(git(["diff", "-U0", "HEAD", "--", path], repoRoot).out)) {
            const span = spanAt(index.spans, line);
            if (span === undefined) moduleScope = true;
            else symbols.push(span.name);
        }
        return { path, symbols: distinct(symbols), moduleScope };
    });
}

// ---------------------------------------------------------------------------
// Mention sets
// ---------------------------------------------------------------------------

/** The word a test spells to mention a symbol: `Class.foo` → `foo`. */
export function bareName(name: string): string {
    return name.slice(name.lastIndexOf(".") + 1);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` contains `word` as a whole JS identifier. */
export function mentionsWord(text: string, word: string): boolean {
    return new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(word)}(?![A-Za-z0-9_$])`).test(text);
}

/**
 * A file's named function-likes, each with the text of the lines it owns as the innermost
 * one — so a body that spells a word is the function that calls it, never its ancestors.
 */
function readOwned(path: string, repoRoot: string): { name: string; text: string }[] {
    const abs = join(repoRoot, path);
    if (!existsSync(abs)) return [];
    const lines = readFileSync(abs, "utf8").split("\n");
    const spans = symbolIndex(path, lines.join("\n")).spans;
    const owned = new Map<Span, string[]>(spans.map((s) => [s, []]));
    lines.forEach((text, i) => {
        const s = spanAt(spans, i + 1);
        if (s !== undefined) owned.get(s)!.push(text);
    });
    return spans.map((s) => ({ name: s.name, text: owned.get(s)!.join("\n") }));
}

/**
 * The mention set of every changed symbol: the symbol itself, every named function-like in
 * its module whose body spells it (the one-hop callers), and — for a module under `tugdeck/`
 * — every named function-like in the test surface whose body spells either (the verbs the
 * harness can call).
 */
export function mentionSet(changed: ChangedFile[], repoRoot: string): MentionSet[] {
    let surface: { name: string; text: string }[] | null = null;
    const sets: MentionSet[] = [];
    for (const file of changed) {
        if (file.symbols.length === 0) continue;
        const module = readOwned(file.path, repoRoot);
        for (const symbol of file.symbols) {
            const word = bareName(symbol);
            const members: Mention[] = [{ name: symbol, word, role: "symbol" }];
            const seen = new Set([symbol]);
            for (const s of module) {
                if (seen.has(s.name) || !mentionsWord(s.text, word)) continue;
                seen.add(s.name);
                members.push({ name: s.name, word: bareName(s.name), role: "caller" });
            }
            if (file.path.startsWith("tugdeck/") && file.path !== TEST_SURFACE) {
                if (surface === null) surface = readOwned(TEST_SURFACE, repoRoot);
                const words = distinct(members.map((m) => m.word));
                for (const s of surface) {
                    if (seen.has(s.name)) continue;
                    if (!words.some((w) => mentionsWord(s.text, w))) continue;
                    seen.add(s.name);
                    members.push({ name: s.name, word: bareName(s.name), role: "surface verb" });
                }
            }
            sets.push({ path: file.path, symbol, members });
        }
    }
    return sets;
}

/** The `changed symbols:` block's line for one file. */
export function describeChanged(file: ChangedFile, sets: MentionSet[]): string {
    if (file.symbols.length === 0) {
        if (file.moduleScope) return `${file.path} → module scope${file.reason ? ` (${file.reason})` : ""}`;
        return `${file.path} → ${file.reason ?? "no hunks"}`;
    }
    const mine = sets.filter((s) => s.path === file.path);
    const symbols = new Set(file.symbols);
    const byRole = (role: MentionRole) =>
        distinct(mine.flatMap((s) => s.members.filter((m) => m.role === role).map((m) => m.name)))
            .filter((n) => !symbols.has(n));
    const callers = byRole("caller");
    const verbs = byRole("surface verb");
    let line = `${file.path} → ${file.symbols.join(", ")}`;
    if (callers.length > 0) line += ` (+ callers ${callers.join(", ")})`;
    if (verbs.length > 0) line += ` (+ surface verbs ${verbs.join(", ")})`;
    if (file.moduleScope) line += " + module scope";
    return line;
}

/** How far one test reaches a change: the count and what the reach bracket says. */
export interface Reach {
    reach: number;
    note: string;
    /** The map ruled a changed symbol out and nothing was reached. */
    negative: boolean;
}

/** A test's recorded reach map, and the tree it was recorded against. */
export interface MapEvidence {
    /** Per module path, the names that ran (`window.__tugReach.dump()`'s shape). */
    map: Record<string, { n: number; hit: string[] }>;
    /** The text of `path` at the map's recorded sha, or null when git cannot say. */
    textAtHead: (path: string) => string | null;
}

/**
 * The reach of one test, symbol by symbol. With a map, a symbol the map hit is reached
 * (`measured`); a symbol the map's tree spelled and the map did not hit is ruled out; and
 * a symbol the map's tree never had — or a tree git cannot show — is unknown to the map,
 * so the text decides it as it would with no map at all. A map recorded before a function
 * existed is no evidence about it, which is what keeps an old map from burying a test.
 *
 * One is counted per symbol reached, through the first member of its mention set the text
 * spells, plus one per module-scope change, which every test covering the file reaches
 * equally. That credit is not a symbol reached, so it never cancels a ruled-out symbol:
 * `negative` holds whenever the map ruled one out and no symbol was reached.
 */
export function reachOf(text: string, files: ChangedFile[], sets: MentionSet[], evidence?: MapEvidence): Reach {
    let reach = 0;
    const measured: string[] = [];
    const hits: string[] = [];
    const others: string[] = [];
    let anySymbols = false;
    let ruledOut = 0;
    for (const f of files) {
        if (f.symbols.length > 0) anySymbols = true;
        for (const set of sets) {
            if (set.path !== f.path) continue;
            if (evidence !== undefined) {
                if (evidence.map[f.path]?.hit.includes(set.symbol)) {
                    reach++;
                    measured.push(bareName(set.symbol));
                    continue;
                }
                const head = evidence.textAtHead(f.path);
                if (head !== null && mentionsWord(head, bareName(set.symbol))) {
                    ruledOut++;
                    continue;
                }
            }
            const m = set.members.find((member) => mentionsWord(text, member.word));
            if (m === undefined) continue;
            reach++;
            hits.push(
                m.role === "caller" ? `${m.word}, caller of ${bareName(set.symbol)}` : `${m.word}, ${m.role}`,
            );
        }
        if (f.moduleScope) {
            reach++;
            others.push("module scope");
        } else if (f.reason !== undefined) {
            others.push(f.reason);
        }
    }
    const parts: string[] = [];
    if (measured.length > 0) parts.push(`measured: ${measured.join(", ")}`);
    if (hits.length > 0) parts.push(`textual: ${hits.join("; ")}`);
    else if (measured.length === 0 && anySymbols) parts.push(ruledOut > 0 ? "negative" : "textual: no mention");
    parts.push(...distinct(others));
    const reachedSymbol = measured.length > 0 || hits.length > 0;
    return { reach, negative: ruledOut > 0 && !reachedSymbol, note: parts.length > 0 ? parts.join("; ") : "no hunks" };
}
