/**
 * inline-markdown-runs — read one line of model-written text as the few
 * inline marks a one-line row can show.
 *
 * Task subjects, job descriptions and goal conditions are written by the
 * model, and the model writes them the way it writes prose: paths and
 * commands in backticks, now and then a `**word**`, and every so often an
 * entity (`&amp;`) carried from wherever the text was lifted. A row that
 * prints that source verbatim shows the reader the syntax rather than the
 * sentence.
 *
 * The full markdown pipeline is the wrong tool for these rows. It is a block
 * parser, so `1. Step one` becomes a list and `# heading` a heading, and it
 * admits raw HTML, so `Handle <Tab> key` loses its `<Tab>` to the sanitizer
 * and `Check <div> wrapper` splits the line into blocks. These lines are
 * often about code, where angle brackets are text. So this reads the inline
 * grammar alone:
 *
 *  - `` `code` `` spans (any backtick run length, CommonMark's matching rule),
 *    whose content is kept verbatim;
 *  - `**strong**` / `__strong__` and `*em*` / `_em_`, with flanking rules so
 *    `a * b`, `2*3*4` and `snake_case_name` stay text;
 *  - backslash escapes of ASCII punctuation;
 *  - HTML entities, named and numeric, decoded outside code.
 *
 * Nothing else is markup: angle brackets, `#`, list markers and links are
 * text. The result is a list of runs a component renders as React text, so
 * there is no HTML string and nothing to sanitize.
 *
 * @module lib/inline-markdown-runs
 */

export type InlineMarkdownRun =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: InlineMarkdownRun[] }
  | { kind: "em"; children: InlineMarkdownRun[] };

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  times: "×",
  rarr: "→",
  larr: "←",
  copy: "©",
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Decode HTML entities; an unknown name or an invalid code point stays as written. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isPunct(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** A delimiter run can open when it is left-flanking (CommonMark 6.2). */
function leftFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isWhitespace(after)) return false;
  if (!isPunct(after)) return true;
  return isWhitespace(before) || isPunct(before);
}

function rightFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isWhitespace(before)) return false;
  if (!isPunct(before)) return true;
  return isWhitespace(after) || isPunct(after);
}

/**
 * Split `text` into code spans and the prose between them. A backtick run
 * with no closing run of the same length is literal text (CommonMark).
 */
function splitCodeSpans(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  let prose = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && text[i + 1] === "`") {
      prose += "\\`";
      i += 2;
      continue;
    }
    if (ch !== "`") {
      prose += ch;
      i += 1;
      continue;
    }
    let runEnd = i;
    while (runEnd < text.length && text[runEnd] === "`") runEnd += 1;
    const runLen = runEnd - i;
    let close = -1;
    let j = runEnd;
    while (j < text.length) {
      if (text[j] !== "`") {
        j += 1;
        continue;
      }
      let k = j;
      while (k < text.length && text[k] === "`") k += 1;
      if (k - j === runLen) {
        close = j;
        break;
      }
      j = k;
    }
    if (close === -1) {
      prose += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    let body = text.slice(runEnd, close);
    // CommonMark strips one space from each side when both are present and
    // the body is not all spaces.
    if (body.length >= 2 && body[0] === " " && body[body.length - 1] === " " && body.trim().length > 0) {
      body = body.slice(1, -1);
    }
    if (prose.length > 0) out.push({ code: false, text: prose });
    prose = "";
    out.push({ code: true, text: body });
    i = close + runLen;
  }
  if (prose.length > 0) out.push({ code: false, text: prose });
  return out;
}

/** One token: literal text, a code span, or an emphasis delimiter run. */
type Token =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "delim"; ch: "*" | "_"; len: number; canOpen: boolean; canClose: boolean };

/**
 * Tokenize one stretch of prose. `lead` / `trail` are the characters just
 * outside it — a backtick where a code span abuts it — so a delimiter
 * against a code span flanks the way it would against the span's source.
 */
function tokenizeProse(
  prose: string,
  lead: string | undefined,
  trail: string | undefined,
): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let i = 0;
  while (i < prose.length) {
    const ch = prose[i];
    if (ch === "\\" && i + 1 < prose.length && ASCII_PUNCT.test(prose[i + 1])) {
      text += prose[i + 1];
      i += 2;
      continue;
    }
    if (ch !== "*" && ch !== "_") {
      text += ch;
      i += 1;
      continue;
    }
    let end = i;
    while (end < prose.length && prose[end] === ch) end += 1;
    const before = i > 0 ? prose[i - 1] : lead;
    const after = end < prose.length ? prose[end] : trail;
    const lf = leftFlanking(before, after);
    const rf = rightFlanking(before, after);
    // `_` may not open or close inside a word, so `snake_case_name` stays text.
    const canOpen = ch === "*" ? lf : lf && (!rf || isPunct(before));
    const canClose = ch === "*" ? rf : rf && (!lf || isPunct(after));
    if (!canOpen && !canClose) {
      text += prose.slice(i, end);
      i = end;
      continue;
    }
    if (text.length > 0) tokens.push({ kind: "text", text });
    text = "";
    tokens.push({ kind: "delim", ch, len: end - i, canOpen, canClose });
    i = end;
  }
  if (text.length > 0) tokens.push({ kind: "text", text });
  return tokens;
}

/** Fold tokens into runs: pair each closer with the nearest matching opener. */
function foldEmphasis(tokens: Token[]): InlineMarkdownRun[] {
  type Frame = { opener: Extract<Token, { kind: "delim" }> | null; runs: InlineMarkdownRun[] };
  const stack: Frame[] = [{ opener: null, runs: [] }];
  const pushText = (runs: InlineMarkdownRun[], text: string): void => {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === "text") last.text += text;
    else runs.push({ kind: "text", text });
  };
  const literal = (d: Extract<Token, { kind: "delim" }>): string => d.ch.repeat(d.len);

  for (const tok of tokens) {
    const top = stack[stack.length - 1];
    if (tok.kind === "text") {
      pushText(top.runs, tok.text);
      continue;
    }
    if (tok.kind === "code") {
      top.runs.push({ kind: "code", text: tok.text });
      continue;
    }
    // Close the nearest open frame of the same character and size class.
    let matched = -1;
    if (tok.canClose) {
      for (let s = stack.length - 1; s > 0; s--) {
        const o = stack[s].opener;
        if (o !== null && o.ch === tok.ch && (o.len >= 2) === (tok.len >= 2)) {
          matched = s;
          break;
        }
      }
    }
    if (matched > 0) {
      // Frames above the match never closed: their delimiters were text.
      while (stack.length - 1 > matched) {
        const dead = stack.pop() as Frame;
        const parent = stack[stack.length - 1].runs;
        pushText(parent, literal(dead.opener as Extract<Token, { kind: "delim" }>));
        for (const r of dead.runs) {
          if (r.kind === "text") pushText(parent, r.text);
          else parent.push(r);
        }
      }
      const frame = stack.pop() as Frame;
      const opener = frame.opener as Extract<Token, { kind: "delim" }>;
      const parent = stack[stack.length - 1].runs;
      if (frame.runs.length === 0) {
        pushText(parent, literal(opener) + literal(tok));
      } else {
        parent.push({ kind: opener.len >= 2 ? "strong" : "em", children: frame.runs });
      }
      continue;
    }
    if (tok.canOpen && (tok.len === 1 || tok.len === 2)) {
      stack.push({ opener: tok, runs: [] });
      continue;
    }
    pushText(top.runs, literal(tok));
  }
  while (stack.length > 1) {
    const dead = stack.pop() as Frame;
    const parent = stack[stack.length - 1].runs;
    pushText(parent, literal(dead.opener as Extract<Token, { kind: "delim" }>));
    for (const r of dead.runs) {
      if (r.kind === "text") pushText(parent, r.text);
      else parent.push(r);
    }
  }
  return stack[0].runs;
}

function decodeRuns(runs: InlineMarkdownRun[]): InlineMarkdownRun[] {
  return runs.map((r) => {
    if (r.kind === "text") return { kind: "text", text: decodeHtmlEntities(r.text) };
    if (r.kind === "code") return r;
    return { kind: r.kind, children: decodeRuns(r.children) };
  });
}

/**
 * Read `text` as inline markdown runs. Total: any input yields runs whose
 * visible text is the input less the markup it consumed.
 */
export function inlineMarkdownRuns(text: string): InlineMarkdownRun[] {
  const parts = splitCodeSpans(text);
  const tokens: Token[] = [];
  parts.forEach((part, index) => {
    if (part.code) {
      tokens.push({ kind: "code", text: part.text });
      return;
    }
    const lead = index > 0 ? "`" : undefined;
    const trail = index < parts.length - 1 ? "`" : undefined;
    tokens.push(...tokenizeProse(part.text, lead, trail));
  });
  return decodeRuns(foldEmphasis(tokens));
}

/** The text a reader sees for `runs` — for an aria-label or a copy. */
export function inlineMarkdownPlainText(text: string): string {
  const flat = (runs: InlineMarkdownRun[]): string =>
    runs
      .map((r) => (r.kind === "text" || r.kind === "code" ? r.text : flat(r.children)))
      .join("");
  return flat(inlineMarkdownRuns(text));
}
