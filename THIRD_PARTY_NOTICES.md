# Third-Party Notices

This file documents copyright notices for third-party code and patterns adopted
in this repository, per [L21](tuglaws/tuglaws.md). Each entry identifies
the source, what was adopted, and the required copyright notice. Entries at the
end of this file cover third-party **binaries and libraries shipped inside
`Tug.app`** rather than code or patterns adopted into this checkout; each names
where in the bundle it lands.

---

## fzf

**Source:** https://github.com/junegunn/fzf
**What was adopted:** Scoring constants and two-phase matching architecture from fzf's FuzzyMatchV2 algorithm — boundary bonus (+8 after word separators), consecutive match bonus (+8), camelCase transition bonus (+7), first character bonus (+8), gap penalties (−3 first, −1 extension), base match score (+16). Also adopted the pre-filter + DP scorer two-phase design (cheap subsequence check eliminates non-matches before expensive dynamic programming). The path-aware structural layer (basename-first scoring with tier bonus) was informed by VS Code and Sublime Text rather than fzf.
**Used in:** `tugrust/crates/tugcast/src/feeds/fuzzy_scorer.rs` (file completion scoring)

```
MIT License

Copyright (c) 2013-2025 Junegunn Choi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Excalidraw

**Source:** https://github.com/excalidraw/excalidraw
**What was adopted:** Architectural patterns that informed the Tuglaws and the tug framework architecture: single-render-root discipline (L01), external-state-via-subscription pattern (L02), appearance-changes-via-DOM-not-state separation (L06), bypass-React-during-gesture-and-sync-on-commit pattern (L08, `MutationTransaction` snapshot/commit model), narrow-per-domain React contexts, typed-action dispatch vocabulary, and component authoring conventions (L19). Excalidraw's canvas-based rendering architecture, state management approach, and component organization were studied extensively during the initial design of the tug framework. The three-zone architecture (appearance / local data / structure) is an adaptation of Excalidraw's separation of gesture-zone work from React-state commits into a form that fits the tug framework's design target.
**Used in:** `tuglaws/framework-architecture.md` (zone architecture, subscribable stores, gesture bypass, narrow contexts, typed-action dispatch), `tuglaws/tuglaws.md` (design principles), tugdeck component architecture

```
MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Monaco Editor

**Source:** https://github.com/microsoft/monaco-editor
**What was adopted:** PrefixSumComputer architecture (Float64Array prefix sum with lazy recomputation and validity watermark, binary search for offset-to-index mapping); RenderedLinesCollection sliding window pattern (contiguous range of DOM nodes mapped to document positions, enter/exit diffing on scroll, overscan for smooth scrolling); viewport-first rendering discipline (never compute what isn't visible, progressive background processing).
**Used in:** `tugdeck/src/lib/block-height-index.ts`, `tugdeck/src/lib/rendered-block-window.ts`, `tugdeck/src/components/tugways/tug-markdown-view.tsx`

```
The MIT License (MIT)

Copyright (c) 2016 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## WebKit

**Source:** https://github.com/WebKit/WebKit
**What was adopted:** Visible units architecture from `Source/WebCore/editing/visible_units.h` — the separation of position boundary queries (startOfWord, endOfWord, startOfLine, endOfLine, startOfParagraph, endOfParagraph, startOfDocument, endOfDocument) from editing operations, so that deletion, movement, and selection extension at any granularity reduce to "find boundary, act on range." Also informed by `document.execCommand` architecture (the mapping of command names to editing operations through a unified dispatch surface). Both originated in the same 2004-era Apple contributions to KHTML/WebKit.
**Used in:** `tugdeck/src/lib/tug-text-editing-operations.ts` (TEOI operation taxonomy and visible units layer design), `tugdeck/src/lib/tug-text-engine.ts` (editing engine)

```
Copyright (C) 2004 Apple Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY APPLE INC. ``AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL APPLE INC. OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## Lexical

**Source:** https://github.com/facebook/lexical
**What was adopted:** "Let the browser mutate, diff afterward" architecture — using MutationObserver as the primary input path for typing rather than intercepting beforeinput events. DOM reconciler pattern: model is source of truth, reconciler syncs model → DOM, skips composing nodes during IME to avoid disrupting browser composition UI.
**Used in:** `tugdeck/src/lib/tug-text-engine.ts` (MutationObserver input path, DOM reconciler)

```
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## CodeMirror 6

**Source:** https://code.haverbeke.berlin/codemirror/dev (moved from https://github.com/codemirror/dev)
**What was adopted:** (1) Flat document model with offset-based positions as the universal coordinate system (flat offsets map 1:1 to document positions, all operations expressed in terms of offset ranges); own undo stack with immutable snapshots and time-based merge heuristic for consecutive edits — both informed the existing engine. (2) The CodeMirror 6 packages themselves (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, plus extensions added in later spike steps) as a runtime dependency for the new `TugEdit` substrate component, where the entire `EditorView`, state, decoration, transaction, and keymap machinery is consumed directly. See `dash/text-editing-base.md` for the substrate adoption rationale.
**Used in:** `tugdeck/src/lib/tug-text-engine.ts` (flat offset position model, undo stack with merge window); `tugdeck/src/components/tugways/tug-edit.tsx` and adjacent extension modules under `tugdeck/src/components/tugways/` (CodeMirror 6 EditorView substrate)

```
MIT License

Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin>,
Adrian Heine <mail@adrianheine.de>, and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ProseMirror

**Source:** https://github.com/ProseMirror/prosemirror
**What was adopted:** Schema-constrained document model concept — the idea that the document enforces structural invariants (our text-atom-text invariant: segments always alternate, atoms always separated by text nodes, document always starts and ends with text). Normalization as a model-level guarantee rather than ad-hoc fixup.
**Used in:** `tugdeck/src/lib/tug-text-engine.ts` (text-atom-text invariant, `normalizeSegments`)

```
MIT License

Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## use-stick-to-bottom

**Source:** https://github.com/stackblitz-labs/use-stick-to-bottom
**What was adopted:** ResizeObserver-driven auto-scroll architecture; `ignoreScrollToTop` pattern for filtering programmatic scroll events; `wheel` event `deltaY < 0` for detecting user scroll-up intent; `resizeDifference` flag for ignoring scroll events caused by content resize; near-bottom threshold concept (50-70px) for re-engagement detection.
**Used in:** `tugdeck/src/lib/smart-scroll.ts` (ResizeObserver-driven auto-scroll with user-intent detection)

```
MIT License

Copyright (c) 2024 StackBlitz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## IBM Plex

**Source:** https://github.com/IBM/plex (npm: `@ibm/plex-*`)
**What was adopted:** IBM Plex font files (woff2) bundled in `tugdeck/public/fonts/`, used as the primary UI typeface family. Core families — IBM Plex Sans, IBM Plex Mono, IBM Plex Sans Condensed — plus the non-Latin script companions IBM Plex Sans Arabic, Hebrew, Thai, and Devanagari, and the CJK families IBM Plex Sans JP and KR (shipped as IBM's pre-split unicode-range subsets so the browser fetches only on-screen subsets). The two proportional Latin families carry the full upright 100–700 range; Plex Mono carries 400–700. All faces are vendored reproducibly via `tugdeck/scripts/fetch-fonts.ts` (`just fetch-fonts` / `just fetch-fonts --cjk`), pinned to the versions in that script's manifest.
**Used in:** `tugdeck/public/fonts.css` + `tugdeck/public/fonts-cjk.css` `@font-face` declarations; `--tug-font-family-sans` / `--tug-font-family-mono` / `--tug-font-family-condensed` token stacks in `tugdeck/styles/themes/*.css`.

```
SIL Open Font License Version 1.1

Copyright © 2017 IBM Corp. with Reserved Font Name "Plex".

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

(Full per-family license text in tugdeck/public/fonts/licenses/plex-sans-*-OFL.txt)
```

---

## Datatype

**Source:** https://github.com/franktisellano/datatype (tag `v1.2.0`)
**What was adopted:** The Datatype variable font file (`Datatype-Variable.woff2`) bundled in `tugdeck/public/fonts/`. Its OpenType ligatures substitute a literal text expression with an inline chart glyph — `{p:75}` a pie, `{b:…}` a bar row, `{l:…}` a static sparkline — on two variable axes (wdth 50–150, wght 100–900). Vendored reproducibly via `tugdeck/scripts/fetch-fonts.ts --datatype` (`just fetch-fonts --datatype`), pinned to the tag in that script.
**Used in:** `tugdeck/public/fonts.css` `@font-face` declaration; the `--tug-font-family-chart` token stack in `tugdeck/styles/themes/*.css`; `tugdeck/src/components/tugways/tug-chart-glyph.tsx`.

```
SIL Open Font License Version 1.1

Copyright © 2025 Frank Tisellano with Reserved Font Name "Datatype".

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

(Full license text in tugdeck/public/fonts/licenses/datatype-OFL.txt)
```

---

## Smoothie Charts

**Source:** https://github.com/joewalnes/smoothie (http://smoothiecharts.org/)
**What was adopted:** The time-to-x scrolling algorithm for real-time charts — a data point at time `T` is drawn at `width − (now − T) · rate`, so the newest sample pins to the right edge and older samples trail left in real time. `tugdeck/src/components/tugways/tug-sparkline.tsx` reimplements this mapping, substituting a continuous WAAPI `translateX` for Smoothie's per-frame requestAnimationFrame redraw (to satisfy tuglaw L13). No source was copied verbatim.
**Used in:** `tugdeck/src/components/tugways/tug-sparkline.tsx` (the PULSE strip's activity sparkline).

```
MIT License

Copyright (c) 2010-2013, Joe Walnes
              2013-2018, Drew Noakes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## Robert Penner's easing equations

**Source:** http://robertpenner.com/easing/ — as carried, in the form adopted here, by UpKit's `UPUnitFunction` (Ken Kocienda, 2020)
**What was adopted:** The closed forms of the `back`, `bounce`, `circ`, `elastic`, `expo`, and `sine` easing equations, ported to TypeScript as unit functions. The exponent-and-ease-factor curve family (`unitCurve`, from UpKit's `unit_curve_value`), the critically damped spring, and the `linear()` sampling are not Penner's.
**Used in:** `tugdeck/src/lib/unit-functions.ts` (timing curves for deck motion)

```
Copyright © 2001 Robert Penner

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## pdf.js

**Source:** https://github.com/mozilla/pdf.js (`pdfjs-dist`)
**What was adopted:** The library itself, as a runtime dependency — document parsing, page rasterization, and the text layer. Only the core display API is used; pdf.js's own viewer application, toolbar, and stylesheets are not. The `legacy` build is the one the deck loads, because the modern build calls `Map.prototype.getOrInsertComputed`, which the WebKit at the app's macOS floor does not implement.
**Used in:** `tugdeck/src/lib/pdf-runtime.ts`, `tugdeck/src/components/tugways/cards/pdf-view.tsx` (the viewer card's PDF surface)

```
Copyright 2012 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## tmux

**Source:** https://github.com/tmux/tmux
**What was adopted:** The program itself, shipped as a binary. `Tug.app` bundles a relocatable, statically-linked tmux built from pinned upstream source by `tugrust/scripts/fetch-tmux.sh`, so a session's terminal multiplexing works on machines with no Homebrew tmux. Unmodified.
**Distribution:** `Tug.app/Contents/Resources/bin/tmux`; this license text is also staged into the bundle at `Contents/Resources/third-party-licenses/tmux-LICENSE.txt`.

```
Copyright (c) Various Authors

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF MIND, USE, DATA OR PROFITS, WHETHER
IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## libevent

**Source:** https://github.com/libevent/libevent
**What was adopted:** The library itself, as a static dependency of the bundled tmux. `fetch-tmux.sh` builds libevent 2.1.12-stable as a static archive (`--disable-shared --disable-openssl`) and links it into the shipped `tmux` binary. Unmodified.
**Distribution:** linked into `Tug.app/Contents/Resources/bin/tmux`; license text staged at `Contents/Resources/third-party-licenses/libevent-LICENSE.txt`.

```
Libevent is available for use under the following license, commonly known
as the 3-clause (or "modified") BSD license:

==============================
Copyright (c) 2000-2007 Niels Provos <provos@citi.umich.edu>
Copyright (c) 2007-2012 Niels Provos and Nick Mathewson

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. The name of the author may not be used to endorse or promote products
   derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
==============================

Portions of Libevent are based on works by others, also made available by
them under the three-clause BSD license above.  The copyright notices are
available in the corresponding source files; the license is as above.  Here's
a list:

log.c:
   Copyright (c) 2000 Dug Song <dugsong@monkey.org>
   Copyright (c) 1993 The Regents of the University of California.

strlcpy.c:
   Copyright (c) 1998 Todd C. Miller <Todd.Miller@courtesan.com>

win32select.c:
   Copyright (c) 2003 Michael A. Davis <mike@datanerds.net>

evport.c:
   Copyright (c) 2007 Sun Microsystems

ht-internal.h:
   Copyright (c) 2002 Christopher Clark

minheap-internal.h:
   Copyright (c) 2006 Maxim Yegorushkin <maxim.yegorushkin@gmail.com>

==============================

The arc4module is available under the following, sometimes called the
"OpenBSD" license:

   Copyright (c) 1996, David Mazieres <dm@uun.org>
   Copyright (c) 2008, Damien Miller <djm@openbsd.org>

   Permission to use, copy, modify, and distribute this software for any
   purpose with or without fee is hereby granted, provided that the above
   copyright notice and this permission notice appear in all copies.

   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

==============================

The Windows timer code is based on code from libutp, which is
distributed under this license, sometimes called the "MIT" license.


Copyright (c) 2010 BitTorrent, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## ncurses

**Source:** https://invisible-island.net/ncurses/
**What was adopted:** The library itself, as a static dependency of the bundled tmux. `fetch-tmux.sh` builds ncurses 6.5 wide-character as a static archive (`--without-shared --enable-widec`) and links it into the shipped `tmux` binary, along with a trimmed terminfo database (`tmux-256color`, `xterm-256color`, and friends) copied from that build. Unmodified.
**Distribution:** linked into `Tug.app/Contents/Resources/bin/tmux`; terminfo entries under `Contents/Resources/terminfo/`; license text staged at `Contents/Resources/third-party-licenses/ncurses-LICENSE.txt`.

```
Copyright 2018-2022,2023 Thomas E. Dickey
Copyright 1998-2017,2018 Free Software Foundation, Inc.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, distribute with modifications, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE ABOVE COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Except as contained in this notice, the name(s) of the above copyright
holders shall not be used in advertising or otherwise to promote the
sale, use or other dealings in this Software without prior written
authorization.

-- vile:txtmode fc=72
-- $Id: COPYING,v 1.12 2023/01/07 17:55:53 tom Exp $
```

---

## utf8proc

**Source:** https://github.com/JuliaStrings/utf8proc
**What was adopted:** The library itself, as a static dependency of the bundled tmux. `fetch-tmux.sh` builds utf8proc 2.9.0 as a static archive and links it into the shipped `tmux` binary (`./configure --enable-utf8proc`), which is what gives correct Unicode and emoji cell widths in a session's terminal. Unmodified.
**Distribution:** linked into `Tug.app/Contents/Resources/bin/tmux`; license text staged at `Contents/Resources/third-party-licenses/utf8proc-LICENSE.txt`.

```
## utf8proc license ##

**utf8proc** is a software package originally developed
by Jan Behrens and the rest of the Public Software Group, who
deserve nearly all of the credit for this library, that is now maintained by the Julia-language developers.  Like the original utf8proc,
whose copyright and license statements are reproduced below, all new
work on the utf8proc library is licensed under the [MIT "expat"
license](http://opensource.org/licenses/MIT):

*Copyright &copy; 2014-2021 by Steven G. Johnson, Jiahao Chen, Tony Kelman, Jonas Fonseca, and other contributors listed in the git history.*

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

## Original utf8proc license ##

*Copyright (c) 2009, 2013 Public Software Group e. V., Berlin, Germany*

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

## Unicode data license ##

This software contains data (`utf8proc_data.c`) derived from processing
the Unicode data files. The following license applies to that data:

**COPYRIGHT AND PERMISSION NOTICE**

*Copyright (c) 1991-2007 Unicode, Inc. All rights reserved. Distributed
under the Terms of Use in http://www.unicode.org/copyright.html.*

Permission is hereby granted, free of charge, to any person obtaining a
copy of the Unicode data files and any associated documentation (the "Data
Files") or Unicode software and any associated documentation (the
"Software") to deal in the Data Files or Software without restriction,
including without limitation the rights to use, copy, modify, merge,
publish, distribute, and/or sell copies of the Data Files or Software, and
to permit persons to whom the Data Files or Software are furnished to do
so, provided that (a) the above copyright notice(s) and this permission
notice appear with all copies of the Data Files or Software, (b) both the
above copyright notice(s) and this permission notice appear in associated
documentation, and (c) there is clear notice in each modified Data File or
in the Software as well as in the documentation associated with the Data
File(s) or Software that the data or software has been modified.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS
INCLUDED IN THIS NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR
CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF
USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THE DATA FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

Unicode and the Unicode logo are trademarks of Unicode, Inc., and may be
registered in some jurisdictions. All other trademarks and registered
trademarks mentioned herein are the property of their respective owners.
```
