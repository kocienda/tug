# Writing prose the Session card renders

**Backtick every file path you write, every time.** Your transcript prose is rendered markdown, and a path in backticks and the same path bare are one reference wearing two faces — the reader has to work out that the difference means nothing. Backticks are the author's own emphasis and the renderer may not invent them, so consistency is yours to supply. The same goes for commands and symbols.

A commit sha is the one thing you write **bare** in backticks — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word and displays it as `commit:63de5762a`. A sentence that already said "commit" makes the app yield its word and show the hash alone.

Clickability is not what backticks are for: the resolver confirms a path and rules it whether or not you formatted it as code. This is about the sentence reading as one voice.
