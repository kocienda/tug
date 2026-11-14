# Writing prose the Session card renders

**Backtick every file path you write, every time.** Your transcript prose is rendered markdown, and a path in backticks and the same path bare are one reference wearing two faces — the reader has to work out that the difference means nothing. Backticks are the author's own emphasis and the renderer may not invent them, so consistency is yours to supply. The same goes for commands and symbols.

A commit sha is the one thing you write **bare** in backticks — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word and displays it as `commit:63de5762a`. A sentence that already said "commit" makes the app yield its word and show the hash alone.

**A session is named in exactly one of three spellings, and anything else is dead text.** The app turns a session you mention into a live chip the user can open, and it recognises only these:

- the **`project/callsign` pair** — `` `tug/mighty-cabin` `` — which is the one to reach for;
- the **full uuid**, all 36 characters — `` `048e4155-f644-46f7-a839-d22ac02a564f` ``;
- the **short id**, exactly the uuid's first eight characters and nothing attached — `` `048e4155` ``.

**Never abbreviate a uuid any other way.** `048e4155-…`, `048e4155…` and `048e…564f` are not references: the app cannot resolve them and the user is left with a session they cannot click. **Never write a callsign bare.** `mighty-cabin` alone is shaped like any hyphenated word and is never scanned, in bold or in backticks, so it always travels with its project. And **never write the `@session:` marker yourself**: that is the form a reference arrives in, not one the transcript renders. Every time a session comes up — the one that owns a file, the one a reference block resolved, the one a command printed — write the pair, and add the full uuid only when a command needs it.

Clickability is not what backticks are for: the resolver confirms a path and rules it whether or not you formatted it as code. This is about the sentence reading as one voice. A session is the exception in the other direction: its spelling is the whole of what makes it resolvable, so there the form is not style.
