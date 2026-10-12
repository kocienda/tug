/**
 * file-type-names.ts — what a kind of file is CALLED, in words a person uses.
 *
 * `file-kinds.ts` answers which card a path opens into; this module answers
 * what to call the thing when a surface has to say so out loud. They are
 * separate questions: `.md` and `.rs` open the same card and are not the same
 * kind of file to a reader, while `.png` and `.heic` open the same card and
 * are both, simply, images.
 *
 * A name carries a **key** as well as its words. The key is the bucket a file
 * counts into, so every image extension folds into one "3 Images" rather than
 * scattering into "1 PNG · 1 JPG · 1 HEIC", and `.ts` and `.tsx` are both
 * TypeScript. Counting is the whole reason the key exists — a caller tallying
 * a directory groups on it and then renders {@link countedFileType}.
 *
 * The table is a courtesy, not a closed allowlist: an extension it does not
 * know keeps its own uppercased extension, which is what the user calls that
 * file anyway. Only a file with no extension at all falls back to the card
 * family, and that family is always Text.
 *
 * @module lib/file-type-names
 */

import { extensionOf, VIEWABLE_EXTENSIONS } from "./file-kinds";

/** The name of a kind of file: the bucket it counts into, and its words. */
export interface FileTypeName {
  /** The bucket files of this type count into — every image shares one. */
  readonly key: string;
  /** What one of them is called. */
  readonly one: string;
  /** What several of them are called. */
  readonly many: string;
}

/** A name whose plural is its singular ("Markdown", "Text"), unless given. */
function named(key: string, one: string, many: string = one): FileTypeName {
  return { key, one, many };
}

const IMAGE = named("image", "Image", "Images");
const PDF = named("pdf", "PDF", "PDFs");
const TEXT = named("text", "Text");

const MARKDOWN = named("markdown", "Markdown");
const TYPESCRIPT = named("typescript", "TypeScript");
const JAVASCRIPT = named("javascript", "JavaScript");
const C = named("c", "C");
const CPP = named("cpp", "C++");
const OBJC = named("objc", "Objective-C");
const SHELL = named("shell", "Shell");

/**
 * The extensions that have a name of their own, lowercase and without the dot.
 *
 * Image and PDF extensions are absent on purpose — they are derived from
 * {@link VIEWABLE_EXTENSIONS} below, so a type added to the deck's viewer
 * allowlist is named the moment it is viewable and cannot be added in one
 * place and forgotten in the other.
 */
const NAMED_EXTENSIONS: Readonly<Record<string, FileTypeName>> = {
  md: MARKDOWN,
  markdown: MARKDOWN,
  mdx: MARKDOWN,
  txt: TEXT,
  text: TEXT,
  log: TEXT,
  ts: TYPESCRIPT,
  tsx: TYPESCRIPT,
  js: JAVASCRIPT,
  jsx: JAVASCRIPT,
  mjs: JAVASCRIPT,
  cjs: JAVASCRIPT,
  swift: named("swift", "Swift"),
  rs: named("rust", "Rust"),
  py: named("python", "Python"),
  go: named("go", "Go"),
  rb: named("ruby", "Ruby"),
  java: named("java", "Java"),
  kt: named("kotlin", "Kotlin"),
  cs: named("csharp", "C#"),
  php: named("php", "PHP"),
  lua: named("lua", "Lua"),
  c: C,
  h: C,
  cc: CPP,
  cpp: CPP,
  cxx: CPP,
  hh: CPP,
  hpp: CPP,
  hxx: CPP,
  m: OBJC,
  mm: OBJC,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  html: named("html", "HTML"),
  htm: named("html", "HTML"),
  astro: named("astro", "Astro"),
  css: named("css", "CSS"),
  json: named("json", "JSON"),
  yaml: named("yaml", "YAML"),
  yml: named("yaml", "YAML"),
  toml: named("toml", "TOML"),
  xml: named("xml", "XML"),
  csv: named("csv", "CSV"),
  sql: named("sql", "SQL"),
  svg: IMAGE,
};

/** The name for a viewable extension, from the deck's own viewer allowlist. */
function viewableName(extension: string): FileTypeName | null {
  const kind = VIEWABLE_EXTENSIONS[extension];
  if (kind === "image") return IMAGE;
  if (kind === "pdf") return PDF;
  return null;
}

/**
 * What to call the kind of file at `path`.
 *
 * A path with no extension — an extensionless script, a dotfile like `.env` —
 * and a buffer with no path at all are both Text: that is the card they open
 * into and, for a dotfile or a `Makefile`, what they honestly are. An
 * extension nobody here has named keeps itself, uppercased, which is the name
 * its owner would give it.
 */
export function fileTypeName(path: string | null): FileTypeName {
  if (path === null) return TEXT;
  const extension = extensionOf(path);
  if (extension === null) return TEXT;
  return (
    NAMED_EXTENSIONS[extension] ??
    viewableName(extension) ??
    named(extension, extension.toUpperCase())
  );
}

/** `"4 Markdown"`, `"1 Image"`, `"2 Images"` — a tally in the type's words. */
export function countedFileType(name: FileTypeName, count: number): string {
  return `${count} ${count === 1 ? name.one : name.many}`;
}
