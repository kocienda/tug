/**
 * babel-plugin-tug-reach.ts — record which named functions run, in an app-test deck.
 *
 * Wired into `@vitejs/plugin-react`'s Babel pass by `vite.config.ts` only when the build
 * runs with `TUG_APPTEST_REACH=1`. Each instrumented module gains a prologue that
 * registers its function names with `src/lib/reach-registry.ts`, and each named function
 * gains one first statement that marks its slot:
 *
 *     import { __tugReachRegister } from "../../lib/reach-registry.ts";
 *     var __trm = __tugReachRegister("tugdeck/src/…/focus-manager.ts", ["FocusManager.popFocusMode", …]);
 *     …
 *     __trm !== undefined && (__trm[7] = 1);
 *
 * The names are baked in at transform time, so the map is readable without a manifest
 * and without `fn.name`. A typed-array element store is the cheapest observable form of
 * "this ran" — no call, no allocation.
 *
 * `var` and the guard are load-bearing. In an import cycle a hoisted function can be
 * called before its module's body has run; with `const` that call would throw a TDZ
 * `ReferenceError` and the instrumented deck would break where the plain one works.
 * With `var` the binding is `undefined` and the store is skipped — the only cost is that
 * such an early call goes unrecorded.
 *
 * ## One naming rule
 *
 * Which functions have a name, and what it is, is the rule the selector's resolver
 * (`tests/app-test/scripts/changed-symbols.ts`) applies to a diff, so a name a hunk
 * resolves to is a name a map can contain: function declarations; class methods,
 * constructors, getters, setters and function-valued properties as `Class.name`;
 * function-valued variables; and function-valued properties of an object literal that
 * initializes a named variable or is returned from a named function, as `<owner>.name`.
 * Bodiless nodes (overloads, abstract methods, anything `declare`d) have no slot.
 */

import path from "path";
import { fileURLToPath } from "url";
import { parseSync, traverse, type NodePath, type PluginObj } from "@babel/core";
import * as t from "@babel/types";

const TUGDECK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface TugReachOptions {
    /** The repository root map keys are relative to (default: the checkout this file is in). */
    repoRoot?: string;
}

type FnNode =
    | t.FunctionDeclaration
    | t.FunctionExpression
    | t.ArrowFunctionExpression
    | t.ObjectMethod
    | t.ClassMethod
    | t.ClassPrivateMethod;

interface Named {
    name: string;
    fn: FnNode;
}

function unwrap(e: t.Node | null | undefined): t.Node | null | undefined {
    while (
        e &&
        (t.isTSAsExpression(e) || t.isTSSatisfiesExpression(e) || t.isTSNonNullExpression(e) ||
            t.isParenthesizedExpression(e) || t.isTSTypeAssertion(e))
    ) {
        e = e.expression;
    }
    return e;
}

function fnValue(e: t.Node | null | undefined): t.FunctionExpression | t.ArrowFunctionExpression | undefined {
    const u = unwrap(e);
    return t.isFunctionExpression(u) || t.isArrowFunctionExpression(u) ? u : undefined;
}

function keyName(key: t.Node, computed: boolean): string | undefined {
    if (t.isPrivateName(key)) return `#${key.id.name}`;
    if (computed) return undefined;
    if (t.isIdentifier(key)) return key.name;
    if (t.isStringLiteral(key)) return key.value;
    if (t.isNumericLiteral(key)) return String(key.value);
    return undefined;
}

/** The name a class's members are prefixed with: its own, or the variable it initializes. */
function className(p: NodePath<t.Class>): string | undefined {
    if (p.node.id) return p.node.id.name;
    if (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parentPath.node.id) && p.parentPath.node.init === p.node) {
        return p.parentPath.node.id.name;
    }
    return undefined;
}

/** True when `p` sits under a `declare`d class or namespace. */
function declared(p: NodePath): boolean {
    return p.findParent((a) =>
        ((a.isClassDeclaration() || a.isTSModuleDeclaration()) && a.node.declare === true)) !== null;
}

/**
 * The named function-likes of one module, in traversal (declaration) order, each paired
 * with the function node whose body gets the store.
 */
export function collectNamed(program: NodePath<t.Program>): Named[] {
    const named: Named[] = [];
    const nameOf = new Map<t.Node, string>();
    const add = (name: string, fn: FnNode) => {
        nameOf.set(fn, name);
        named.push({ name, fn });
    };

    /** The name of the nearest named function-like enclosing `p`. */
    const enclosingName = (p: NodePath): string | undefined => {
        for (let a = p.parentPath; a; a = a.parentPath) {
            const n = nameOf.get(a.node);
            if (n !== undefined) return n;
        }
        return undefined;
    };

    /** The owner an object literal's members are prefixed with, if it has one. */
    const objectOwner = (obj: NodePath): string | undefined => {
        let p: NodePath = obj;
        // Climb through TS/paren wrappers.
        while (p.parentPath && (p.parentPath.isTSAsExpression() || p.parentPath.isTSSatisfiesExpression() ||
            p.parentPath.isTSNonNullExpression() || p.parentPath.isParenthesizedExpression() ||
            p.parentPath.isTSTypeAssertion())) {
            p = p.parentPath;
        }
        const parent = p.parentPath;
        if (parent?.isVariableDeclarator() && parent.node.init === p.node && t.isIdentifier(parent.node.id)) {
            return parent.node.id.name;
        }
        if (parent?.isReturnStatement()) return enclosingName(parent);
        return undefined;
    };

    program.traverse({
        FunctionDeclaration(p) {
            if (p.node.id && !declared(p)) add(p.node.id.name, p.node);
        },
        ClassMethod(p) {
            if (declared(p)) return;
            const cls = className(p.parentPath.parentPath as NodePath<t.Class>);
            if (cls === undefined) return;
            if (p.node.kind === "constructor") {
                add(`${cls}.constructor`, p.node);
                return;
            }
            const key = keyName(p.node.key, p.node.computed);
            if (key !== undefined) add(`${cls}.${key}`, p.node);
        },
        ClassPrivateMethod(p) {
            if (declared(p)) return;
            const cls = className(p.parentPath.parentPath as NodePath<t.Class>);
            const key = keyName(p.node.key, false);
            if (cls !== undefined && key !== undefined) add(`${cls}.${key}`, p.node);
        },
        "ClassProperty|ClassPrivateProperty"(p) {
            const node = p.node as t.ClassProperty | t.ClassPrivateProperty;
            if (declared(p) || (t.isClassProperty(node) && node.declare)) return;
            const fn = fnValue(node.value);
            if (fn === undefined) return;
            const cls = className(p.parentPath!.parentPath as NodePath<t.Class>);
            const key = keyName(node.key, t.isClassProperty(node) ? node.computed : false);
            if (cls !== undefined && key !== undefined) add(`${cls}.${key}`, fn);
        },
        VariableDeclarator(p) {
            if (!t.isIdentifier(p.node.id)) return;
            const fn = fnValue(p.node.init);
            if (fn !== undefined) add(p.node.id.name, fn);
        },
        ObjectMethod(p) {
            const owner = objectOwner(p.parentPath);
            const key = keyName(p.node.key, p.node.computed);
            if (owner !== undefined && key !== undefined) add(`${owner}.${key}`, p.node);
        },
        ObjectProperty(p) {
            const fn = fnValue(p.node.value);
            if (fn === undefined) return;
            const owner = objectOwner(p.parentPath);
            const key = keyName(p.node.key, p.node.computed);
            if (owner !== undefined && key !== undefined) add(`${owner}.${key}`, fn);
        },
    });
    return named;
}

/** The distinct names `collectNamed` finds in one source text — the cross-check's view. */
export function reachNames(code: string, filename: string): string[] {
    const ast = parseSync(code, {
        filename,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", ...(filename.endsWith(".tsx") ? (["jsx"] as const) : [])] },
    });
    if (ast === null) return [];
    let names: string[] = [];
    traverse(ast, {
        Program(p) {
            names = collectNamed(p).map((n) => n.name);
            p.stop();
        },
    });
    return [...new Set(names)];
}

function storeAt(index: number): t.Statement {
    return t.expressionStatement(
        t.logicalExpression(
            "&&",
            t.binaryExpression("!==", t.identifier("__trm"), t.identifier("undefined")),
            t.assignmentExpression(
                "=",
                t.memberExpression(t.identifier("__trm"), t.numericLiteral(index), true),
                t.numericLiteral(1),
            ),
        ),
    );
}

/** The Babel plugin. `vite.config.ts` adds it only when `TUG_APPTEST_REACH=1`. */
export function tugReachPlugin(options: TugReachOptions = {}): PluginObj {
    const repoRoot = options.repoRoot ?? path.resolve(TUGDECK_DIR, "..");
    const srcRoot = path.join(repoRoot, "tugdeck", "src") + path.sep;
    const registry = path.join(repoRoot, "tugdeck", "src", "lib", "reach-registry.ts");
    return {
        name: "tug-reach",
        visitor: {
            Program(program, state) {
                const filename = state.filename;
                if (!filename || !filename.startsWith(srcRoot)) return;
                if (filename.includes(`${path.sep}node_modules${path.sep}`) || filename === registry) return;
                const named = collectNamed(program);
                if (named.length === 0) return;

                named.forEach(({ fn }, i) => {
                    if (!t.isBlockStatement(fn.body)) {
                        fn.body = t.blockStatement([t.returnStatement(fn.body)]);
                    }
                    // Statements, not directives: a `"use strict"` stays first.
                    fn.body.body.unshift(storeAt(i));
                });

                let specifier = path.relative(path.dirname(filename), registry).split(path.sep).join("/");
                if (!specifier.startsWith(".")) specifier = `./${specifier}`;
                const rel = path.relative(repoRoot, filename).split(path.sep).join("/");
                program.node.body.unshift(
                    t.importDeclaration(
                        [t.importSpecifier(t.identifier("__tugReachRegister"), t.identifier("__tugReachRegister"))],
                        t.stringLiteral(specifier),
                    ),
                    t.variableDeclaration("var", [
                        t.variableDeclarator(
                            t.identifier("__trm"),
                            t.callExpression(t.identifier("__tugReachRegister"), [
                                t.stringLiteral(rel),
                                t.arrayExpression(named.map((n) => t.stringLiteral(n.name))),
                            ]),
                        ),
                    ]),
                );
            },
        },
    };
}
