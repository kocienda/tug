import { describe, expect, test } from "bun:test";

import {
  checkCallbacks,
  checkFile,
  checkGallery,
  checkInternalImport,
  checkPrefixPlacement,
  checkPrimitiveStore,
  checkStructure,
  checkVocabulary,
  componentName,
  importSpecifiers,
  isDomainStore,
  leadingDocblock,
  ratchet,
  resolveSpecifier,
} from "../component-conformance";

const TW = "tugdeck/src/components/tugways";

describe("importSpecifiers", () => {
  test("reads named, multi-line, side-effect, type and re-export imports", () => {
    const source = [
      'import React from "react";',
      "import {",
      "  a,",
      "  b,",
      '} from "./internal/scroller-context";',
      'import "./tug-pane.css";',
      'import type { X } from "@/lib/x";',
      'export { y } from "../y";',
      'const s = "import z from \\"nope\\"";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual([
      "react",
      "./internal/scroller-context",
      "./tug-pane.css",
      "@/lib/x",
      "../y",
    ]);
  });
});

describe("resolveSpecifier", () => {
  test("resolves relative and alias specifiers and ignores packages", () => {
    expect(resolveSpecifier(`${TW}/tug-bulletin.tsx`, "../../lib/page-zoom-store")).toBe(
      "tugdeck/src/lib/page-zoom-store",
    );
    expect(resolveSpecifier(`${TW}/cards/x.tsx`, "@/components/tugways/internal/tug-button")).toBe(
      `${TW}/internal/tug-button`,
    );
    expect(resolveSpecifier(`${TW}/x.tsx`, "./y.tsx")).toBe(`${TW}/y`);
    expect(resolveSpecifier(`${TW}/x.tsx`, "react")).toBeNull();
  });
});

describe("T01 internal-import", () => {
  const reach = 'import { TugButton } from "./internal/tug-button";';

  test("feature code that reaches into internal/ fails, by resolved path", () => {
    expect(checkInternalImport(`${TW}/session-masthead.tsx`, reach)).toEqual([
      { rule: "T01", path: `${TW}/session-masthead.tsx`, detail: `${TW}/internal/tug-button` },
    ]);
    const viaAlias = 'import { X } from "@/components/tugways/internal/scroller-context";';
    expect(checkInternalImport("tugdeck/src/components/overview/overview-card.tsx", viaAlias)).toHaveLength(1);
  });

  test("a public import passes, and primitives and the exempt set are not read", () => {
    expect(checkInternalImport(`${TW}/session-masthead.tsx`, 'import { TugIconButton } from "./tug-icon-button";')).toEqual([]);
    expect(checkInternalImport(`${TW}/tug-icon-button.tsx`, reach)).toEqual([]);
    expect(checkInternalImport(`${TW}/internal/list-view-window.ts`, reach)).toEqual([]);
    expect(checkInternalImport(`${TW}/cards/gallery-buttons.tsx`, 'import "../internal/tug-button";')).toEqual([]);
    expect(checkInternalImport("tugdeck/src/spikes/spike-x.tsx", 'import "@/components/tugways/internal/tug-button";')).toEqual([]);
    expect(checkInternalImport(`${TW}/__tests__/x.test.tsx`, 'import "../internal/tug-button";')).toEqual([]);
  });
});

describe("T02 primitive-store", () => {
  test("an environment store passes: page-zoom-store", () => {
    expect(checkPrimitiveStore(`${TW}/tug-sheet.tsx`, 'import { pageZoomStore } from "@/lib/page-zoom-store";')).toEqual([]);
    expect(isDomainStore("tugdeck/src/lib/tug-dev-log-store/tug-dev-log-store")).toBe(false);
    expect(isDomainStore("tugdeck/src/lib/property-store")).toBe(false);
    expect(isDomainStore("tugdeck/src/lib/card-modal-hold-store")).toBe(false);
  });

  test("a domain store fails: card-title-store", () => {
    expect(checkPrimitiveStore(`${TW}/tug-tab-bar.tsx`, 'import { cardTitleStore } from "../../lib/card-title-store";')).toEqual([
      { rule: "T02", path: `${TW}/tug-tab-bar.tsx`, detail: "tugdeck/src/lib/card-title-store" },
    ]);
    expect(isDomainStore("tugdeck/src/lib/deck-store-registry")).toBe(true);
    expect(isDomainStore("tugdeck/src/lib/connection-singleton")).toBe(true);
    expect(isDomainStore("tugdeck/src/lib/code-session-store/hooks/use-session-fields")).toBe(true);
    expect(isDomainStore("tugdeck/src/lib/markdown/parse")).toBe(false);
  });

  test("only top-level primitives are read", () => {
    const store = 'import { cardTitleStore } from "@/lib/card-title-store";';
    expect(checkPrimitiveStore(`${TW}/internal/tug-button.tsx`, store)).toEqual([]);
    expect(checkPrimitiveStore(`${TW}/cards/session-card.tsx`, store)).toEqual([]);
  });
});

describe("T03 prefix-placement", () => {
  test("a tug- file outside the primitive tier fails", () => {
    expect(checkPrefixPlacement(`${TW}/cards/tug-attachment-preview.tsx`)).toHaveLength(1);
  });

  test("primitives, unprefixed files and tests pass", () => {
    expect(checkPrefixPlacement(`${TW}/tug-badge.tsx`)).toEqual([]);
    expect(checkPrefixPlacement(`${TW}/internal/tug-button.tsx`)).toEqual([]);
    expect(checkPrefixPlacement(`${TW}/cards/attachment-preview.tsx`)).toEqual([]);
    expect(checkPrefixPlacement(`${TW}/__tests__/tug-bulletin-relay.test.tsx`)).toEqual([]);
  });
});

describe("V01 vocabulary", () => {
  test("a local size or density union fails", () => {
    expect(checkVocabulary(`${TW}/tug-x.tsx`, 'export type TugXSize = "sm" | "md" | "lg";')).toHaveLength(1);
    expect(checkVocabulary(`${TW}/tug-x.tsx`, 'export type TugXDensity =\n  | "cozy"\n  | "compact";')).toHaveLength(1);
    expect(checkVocabulary(`${TW}/tug-x.tsx`, 'interface P {\n  size?: "sm" | "md";\n}')).toHaveLength(1);
  });

  test("a removed spelling on a props interface fails", () => {
    const source = 'export interface TugXProps {\n  /** The label. */\n  ariaLabel?: string;\n  visible: boolean;\n}';
    expect(checkVocabulary(`${TW}/tug-x.tsx`, source).map((v) => v.detail)).toEqual([
      "a props interface declares `ariaLabel`",
      "a props interface declares `visible`",
    ]);
  });

  test("the shared vocabulary, a type scale, an object field and non-primitives pass", () => {
    expect(checkVocabulary(`${TW}/tug-x.tsx`, 'export type TugXSize = Extract<TugSize, "sm" | "md">;')).toEqual([]);
    expect(checkVocabulary(`${TW}/tug-x.tsx`, 'export type TugXSize = "3xs" | "sm" | "md";')).toEqual([]);
    expect(checkVocabulary(`${TW}/tug-x.tsx`, 'export interface TugXConfirmation {\n  ariaLabel?: string;\n}')).toEqual([]);
    expect(checkVocabulary(`${TW}/tug-x.tsx`, 'export interface TugXProps {\n  onOpen?: (e: { visible: boolean }) => void;\n}')).toEqual([]);
    expect(checkVocabulary(`${TW}/cards/x.tsx`, 'export type XSize = "sm" | "md";')).toEqual([]);
  });
});

/** A primitive that passes every structural rule. */
const CONFORMING = [
  "/**",
  " * tug-x — a conforming primitive.",
  " *",
  " * Laws: [L19] component authoring guide",
  " */",
  'import { cn } from "@/lib/utils";',
  "export interface TugXProps extends React.ComponentPropsWithoutRef<\"div\"> {",
  "  size?: TugXSize;",
  "}",
  "export const TugX = React.forwardRef<HTMLDivElement, TugXProps>(function TugX(",
  "  { className, ...rest },",
  "  ref,",
  ") {",
  '  return <div ref={ref} data-slot="tug-x" className={cn("tug-x", className)} {...rest} />;',
  "});",
].join("\n");

describe("structure C01–C09", () => {
  const rulesOf = (file: string, source: string) => checkStructure(file, source).map((v) => v.rule);

  test("names and the leading docblock are read from the file", () => {
    expect(componentName(`${TW}/tug-combo-box.tsx`)).toBe("TugComboBox");
    expect(leadingDocblock("/** a */\nconst b = 1;")).toBe("/** a */");
    expect(leadingDocblock("const b = 1;\n/** a */")).toBe("");
  });

  test("a conforming primitive passes, and non-primitives are not read", () => {
    expect(checkStructure(`${TW}/tug-x.tsx`, CONFORMING)).toEqual([]);
    expect(checkStructure(`${TW}/cards/x.tsx`, "const x = 1;")).toEqual([]);
  });

  test("a module that exports no component named for its file is held to its docblock alone", () => {
    const f = `${TW}/tug-x.tsx`;
    const doc = "/**\n * tug-x — helpers.\n *\n * Laws: [L19] component authoring guide\n */\n";
    expect(rulesOf(f, `${doc}export function roleStyle(): string { return ""; }`)).toEqual([]);
    expect(rulesOf(f, `${doc}export const TugX = React.createContext<number>(0);`)).toEqual([]);
    expect(rulesOf(f, "export function roleStyle(): string { return \"\"; }")).toEqual(["C07"]);
    expect(rulesOf(f, `${doc}export function TugX(): React.ReactElement { return <div />; }`)).toEqual([
      "C01",
      "C03",
      "C04",
      "C05",
      "C06",
    ]);
  });

  test("an alternate data-slot spelling passes", () => {
    const viaProp = CONFORMING.replace('data-slot="tug-x"', 'data-slot={dataSlot ?? "tug-x"}');
    expect(rulesOf(`${TW}/tug-x.tsx`, viaProp)).toEqual([]);
    const viaDefault = CONFORMING.replace('data-slot="tug-x"', "data-slot={slot}") + '\nconst { "data-slot": slot = "tug-x" } = props;';
    expect(rulesOf(`${TW}/tug-x.tsx`, viaDefault)).toEqual([]);
  });

  test("each missing piece fails its own rule", () => {
    const f = `${TW}/tug-x.tsx`;
    expect(rulesOf(f, CONFORMING.replace("export interface TugXProps", "interface TugXProps"))).toEqual(["C01"]);
    expect(rulesOf(f, CONFORMING.replace(' extends React.ComponentPropsWithoutRef<"div">', ""))).toEqual(["C02"]);
    const noElement = CONFORMING.replace(
      'export interface TugXProps extends React.ComponentPropsWithoutRef<"div">',
      "/**\n * Holds state for its parts.\n *\n * @no-element\n */\nexport interface TugXProps",
    )
      .replace(' data-slot="tug-x"', "")
      .replace('cn("tug-x", className)', "className");
    expect(rulesOf(f, noElement)).toEqual([]);
    expect(rulesOf(f, noElement.replace("React.forwardRef", "React.memo"))).toEqual([]);
    expect(rulesOf(f, noElement.replace(" {...rest}", ""))).toEqual(["C06"]);
    const elsewhere = CONFORMING.replace(' extends React.ComponentPropsWithoutRef<"div">', "") + "\n/** @no-element */\ninterface Other {}";
    expect(rulesOf(f, elsewhere)).toEqual(["C02"]);
    const union = CONFORMING.replace(
      "export interface TugXProps",
      "export type TugXProps = (TugXOneProps | TugXTwoProps) & TugXSharedProps;\nexport interface TugXSharedProps",
    );
    expect(rulesOf(f, union)).toEqual([]);
    expect(rulesOf(f, union.replace(' extends React.ComponentPropsWithoutRef<"div">', ""))).toEqual(["C02"]);
    expect(rulesOf(f, CONFORMING.replace("React.forwardRef", "React.memo"))).toEqual(["C03"]);
    const named = CONFORMING.replace("React.forwardRef", "React.memo").replace(' data-slot="tug-x"', "") +
      '\n// forwardRef, {...rest}\n/** data-slot="tug-x" */';
    expect(rulesOf(f, named)).toEqual(["C03", "C04"]);
    expect(rulesOf(f, CONFORMING.replace('data-slot="tug-x"', 'data-slot="tug-y"'))).toEqual(["C04"]);
    expect(rulesOf(f, CONFORMING.replace('cn("tug-x", className)', "className").replace('import { cn } from "@/lib/utils";', ""))).toEqual(["C05"]);
    expect(rulesOf(f, CONFORMING.replace(" {...rest}", ""))).toEqual(["C06"]);
    expect(rulesOf(f, CONFORMING.replace("[L19]", "[L06]"))).toEqual(["C07"]);
  });

  test("history in the leading docblock fails C08", () => {
    const f = `${TW}/tug-x.tsx`;
    for (const marker of ["Phase 3", "Spec S04", "[tugplan-x D16]", "A2.4", "`1a2b3c4d5`"]) {
      expect(rulesOf(f, CONFORMING.replace("a conforming primitive.", `a conforming primitive. ${marker}`))).toEqual(["C08"]);
    }
    expect(rulesOf(f, CONFORMING + "\n/** Spec S04, after the docblock. */")).toEqual([]);
  });

  test("a named appearance setter in useState fails C09", () => {
    const held = CONFORMING + "\nconst [charCount, setCharCount] = useState(0);";
    expect(rulesOf(`${TW}/tug-textarea.tsx`, held.replaceAll("tug-x", "tug-textarea").replaceAll("TugX", "TugTextarea"))).toEqual(["C09"]);
    expect(rulesOf(`${TW}/tug-x.tsx`, held)).toEqual([]);
  });
});

describe("L11 callbacks", () => {
  test("a user-action callback on an exported props interface fails", () => {
    const source = "export interface TugXProps {\n  onClick?: () => void;\n  onSettle?: (v: string) => void;\n}";
    expect(checkCallbacks(`${TW}/tug-x.tsx`, source).map((v) => v.detail)).toEqual([
      "a props interface declares `onClick`",
      "a props interface declares `onSettle`",
    ]);
  });

  test("an Omit, a mirror callback, a private interface and non-primitives pass", () => {
    const omitted = 'export interface TugXProps extends Omit<React.ComponentPropsWithoutRef<"button">, "onClick"> {\n  onOpenChange?: (open: boolean) => void;\n}';
    expect(checkCallbacks(`${TW}/tug-x.tsx`, omitted)).toEqual([]);
    expect(checkCallbacks(`${TW}/tug-x.tsx`, "interface RowProps {\n  onClick: () => void;\n}")).toEqual([]);
    expect(checkCallbacks(`${TW}/cards/x.tsx`, "export interface XProps {\n  onClick: () => void;\n}")).toEqual([]);
  });
});

describe("G01 gallery", () => {
  test("a top-level primitive no gallery card imports fails; an imported one passes", () => {
    const files = [
      { path: `${TW}/tug-x.tsx`, source: CONFORMING },
      { path: `${TW}/tug-y.tsx`, source: CONFORMING },
      { path: `${TW}/internal/tug-z.tsx`, source: CONFORMING },
      { path: `${TW}/cards/gallery-x.tsx`, source: 'import { TugX } from "../tug-x";' },
      { path: `${TW}/cards/session-card.tsx`, source: 'import { TugY } from "../tug-y";' },
    ];
    expect(checkGallery(files)).toEqual([
      { rule: "G01", path: `${TW}/tug-y.tsx`, detail: "no gallery card imports it" },
    ]);
  });
});

describe("ratchet", () => {
  const violations = checkFile(`${TW}/session-masthead.tsx`, 'import "./internal/tug-button";');

  test("an allowlisted violation passes and an unlisted one fails", () => {
    expect(ratchet(violations, { T01: { [`${TW}/session-masthead.tsx`]: "reason" } })).toEqual([]);
    expect(ratchet(violations, {})).toEqual([
      `T01 ${TW}/session-masthead.tsx: ${TW}/internal/tug-button`,
    ]);
  });

  test("a stale entry fails", () => {
    expect(ratchet([], { T02: { [`${TW}/tug-tab-bar.tsx`]: "reason" } })).toEqual([
      `T02 ${TW}/tug-tab-bar.tsx: allowlisted but no longer violates; remove the entry`,
    ]);
  });
});
