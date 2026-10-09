import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const THEMES_DIR = path.join(ROOT, "styles", "themes");
const OUT_FILE = path.join(ROOT, "src", "generated", "tug-token-names.ts");

export function collectCssFiles(): string[] {
  const files: string[] = [];
  for (const name of fs.readdirSync(THEMES_DIR)) {
    if (name.endsWith(".css")) {
      files.push(path.join(THEMES_DIR, name));
    }
  }
  return files;
}

export function extractTokenNames(cssText: string): string[] {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, " ");
  const matches = withoutComments.matchAll(/--(?:tug7|tugc|tugx|tug)-[a-zA-Z0-9-]+(?=\s*:)/g);
  const names: string[] = [];
  for (const match of matches) {
    names.push(match[0]);
  }
  return names;
}

export function main(): void {
  const all = new Set<string>();
  for (const file of collectCssFiles()) {
    const text = fs.readFileSync(file, "utf-8");
    for (const name of extractTokenNames(text)) {
      all.add(name);
    }
  }
  const names = [...all].sort();
  const out = [
    "/**",
    " * tug-token-names.ts — GENERATED token inventory for Theme Accessibility.",
    " * Source scan: styles/themes/*.css",
    " */",
    "",
    "export const TUG_TOKEN_NAMES: readonly string[] = [",
    ...names.map((name) => `  \"${name}\",`),
    "];",
    "",
  ].join("\n");
  fs.writeFileSync(OUT_FILE, out, "utf-8");
  console.log(`Generated ${names.length} --tug7-/--tugc-/--tugx-/--tug- names -> ${path.relative(ROOT, OUT_FILE)}`);
}

if (import.meta.main) {
  main();
}
