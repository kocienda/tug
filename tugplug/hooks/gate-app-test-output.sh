#!/bin/bash
# Strip the filter off a piped `just app-test*` run, or deny it if it cannot be
# stripped cleanly.
#
# The recipe already renders a report: a per-file result table, a `Diagnostics:`
# section, a `Failures:` section carrying each failure's message and location,
# and a closing `VERDICT:` line. A green one-file run is about twenty lines.
# There is nothing to extract that the summary has not already extracted.
#
# The pipe is not merely redundant. It replaces the recipe's exit code with the
# filter's, so `just app-test X | grep -A 8 "Failures:"` on a passing run prints
# nothing and exits 1 — a green run reported as a silent failure. A fixed `-A N`
# also truncates the second failure and drops `Diagnostics:` entirely.
#
# The judgment is per command, not per command line. A shell line is split into
# top-level segments at `&&`, `||`, `;`, and newline, and only the segments that
# *are* an app-test invocation are judged. `cd tugdeck && bunx vite build | tail
# -3 && cd .. && just app-test X` is left alone: that pipe belongs to the build,
# and the app-test run is already bare. A segment whose own output is filtered
# has the filter removed in place and the rest of the chain is preserved.
#
# Denying costs a round trip every time the reflex fires, so the deny is the last
# resort: it is reached only when an app-test segment feeds something this cannot
# rewrite (a subshell, a command substitution, a redirect into a file).
#
# Machine-readable output has its own channel: TUG_APPTEST_JSON=<path> writes a
# document serialized from the same arrays the summary renders.
#
# The gate is about one report contract — the one `tests/app-test/` prints — and
# not every project has it. tugplug ships in the app bundle and travels to
# whatever project Tug is pointed at, where a `just app-test` recipe may mean
# something else entirely and its output may be exactly what a filter is for. So
# the gate first establishes that this command's project is one the contract
# applies to, and stays out of the way when it is not: an inapplicable gate must
# never fire, just as a broken gate must never block work.
#
# Anything unexpected — no jq — exits 0 and falls through to the normal
# permission flow: a broken gate must never block work.

INPUT=$(cat)

command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -n "$CMD" ] || exit 0

# Does the app-test report contract exist in the project this command runs in?
# The payload carries the session's directory; fall back to $PWD when it does
# not. Every failure to resolve exits 0.
SUBJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -n "$SUBJECT_DIR" ] || SUBJECT_DIR=$PWD
[ -d "$SUBJECT_DIR" ] || exit 0
SUBJECT_ROOT=$(git -C "$SUBJECT_DIR" rev-parse --show-toplevel 2>/dev/null) || SUBJECT_ROOT=$SUBJECT_DIR
[ -n "$SUBJECT_ROOT" ] || SUBJECT_ROOT=$SUBJECT_DIR
[ -d "$SUBJECT_ROOT/tests/app-test" ] || exit 0

# `tee` and `cat` pass the report through intact; a filter does not.
FILTER='(/usr/bin/|/bin/)?(grep|egrep|fgrep|rg|ag|head|tail|sed|awk|cut|wc|sort|uniq|tr)'

# Only the recipes that print the summary. `app-test-select` and
# `app-test-covers-check` emit plain lists and are legitimately filtered.
JUST_APPTEST="just([[:space:]]+--[[:alnum:]-]+)*[[:space:]]+app-test(-changed|-all)?([[:space:]]|\$)"
SEGMENT_HAS_APPTEST="(^|[^-[:alnum:]_/])${JUST_APPTEST}"

# The rewrite is narrower than the detection: it only fires when the invocation
# *opens* the segment (after optional `VAR=val` assignments), which is what makes
# the text before the first pipe the whole command. A subshell or a command
# substitution is detected but not rewritten.
SEGMENT_OPENS_APPTEST="^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]|]*[[:space:]]+)*${JUST_APPTEST}"

# Split the line into top-level segments, tracking quote state so a separator
# inside an argument does not split anything. Pipes are deliberately *not*
# separators: a pipe binds to the command it filters, which is exactly what is
# being judged. SEGS holds the commands, SEPS the separator that followed each,
# and NAKED holds each segment with its quoted spans blanked out — an invocation
# is matched against that, so `echo "just app-test x | tail"` reads as the echo
# it is rather than as a filtered test run.
SEGS=()
SEPS=()
NAKED=()
cur=""
nak=""
quote=""
i=0
len=${#CMD}
while [ "$i" -lt "$len" ]; do
    ch=${CMD:i:1}
    if [ -n "$quote" ]; then
        cur+=$ch
        nak+=" "
        [ "$ch" = "$quote" ] && quote=""
        i=$((i + 1))
        continue
    fi
    case $ch in
        "'" | '"')
            quote=$ch
            cur+=$ch
            nak+=" "
            i=$((i + 1))
            continue
            ;;
        '\')
            cur+=$ch${CMD:i+1:1}
            nak+="  "
            i=$((i + 2))
            continue
            ;;
    esac
    two=${CMD:i:2}
    if [ "$two" = "&&" ] || [ "$two" = "||" ]; then
        SEGS+=("$cur")
        NAKED+=("$nak")
        SEPS+=("$two")
        cur=""
        nak=""
        i=$((i + 2))
        continue
    fi
    # `2>&1` and `>&2` keep their `&`; only a bare `&`/`;`/newline separates.
    if { [ "$ch" = ";" ] || [ "$ch" = $'\n' ]; } ||
        { [ "$ch" = "&" ] && [ "${cur: -1}" != ">" ]; }; then
        SEGS+=("$cur")
        NAKED+=("$nak")
        SEPS+=("$ch")
        cur=""
        nak=""
        i=$((i + 1))
        continue
    fi
    cur+=$ch
    nak+=$ch
    i=$((i + 1))
done
SEGS+=("$cur")
NAKED+=("$nak")
SEPS+=("")

# Everything a filtered app-test segment is allowed to contain, outside quotes.
# The shape is matched against the quote-blanked twin, so a filter's own
# arguments can hold anything — `sed -n '/Diagnostics/,$p'` is a filter with a
# `$` in it, not a command substitution — while an unquoted `$(` still isn't
# rewritable. `2>&1` is the one shell metacharacter allowed through; it is
# removed before the shape is matched, and kept by the rewrite, since it only
# redirects a stream the summary already merges.
ARG='[^|;&`$()<>]*'
STRIPPABLE="${SEGMENT_OPENS_APPTEST%%\$}${ARG}(\\|[[:space:]]*${FILTER}${ARG})+[[:space:]]*\$"

CHANGED=0
for idx in "${!SEGS[@]}"; do
    seg=${SEGS[$idx]}
    bare_probe=${NAKED[$idx]}
    printf '%s' "$bare_probe" | grep -Eq "$SEGMENT_HAS_APPTEST" || continue
    printf '%s' "$bare_probe" | grep -Eq "\\|[[:space:]]*${FILTER}([[:space:]]|\$)" || continue

    if printf '%s' "${bare_probe//2>&1/}" | grep -Eq "$STRIPPABLE"; then
        # Everything from the first pipe on is the filter chain; drop it. The
        # cut is located in the twin — which is blanked in place, so offsets
        # still line up — and applied to the real bytes, so a `|` inside a
        # filter's quoted argument cannot be mistaken for the cut point.
        head=${bare_probe%%|*}
        bare=${seg:0:${#head}}
        bare=${bare%"${bare##*[![:space:]]}"}
        SEGS[$idx]=$bare
        CHANGED=1
        continue
    fi

    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Run the app-test command on its own, with no pipe. (A pipe elsewhere in the same chain is fine — this is only about the app-test invocation.) The recipe already prints the report — per-file results, Diagnostics, a Failures section with each failure'"'"'s message and location, and a closing VERDICT line — and a green one-file run is about twenty lines. Piping it into a filter also replaces the recipe'"'"'s exit code with the filter'"'"'s, so a passing run comes back empty and non-zero. If you want a machine-readable result instead of the text report, set TUG_APPTEST_JSON=<path> and read that file afterwards."
      }
    }'
    exit 0
done

[ "$CHANGED" = 1 ] || exit 0

# Rejoining is byte-for-byte except where a filter chain was cut off: the cut
# rtrims, so a separator that followed it needs its space back.
REWRITTEN=""
for idx in "${!SEGS[@]}"; do
    seg=${SEGS[$idx]}
    sep=${SEPS[$idx]}
    if [ -n "$sep" ] && [ "$sep" != $'\n' ] && [ -n "$seg" ] && [ "${seg: -1}" != " " ]; then
        seg+=" "
    fi
    REWRITTEN+=$seg$sep
done

REASON="Removed the output filter from the app-test command and left the rest of the line intact. The recipe already prints a finished report (per-file results, Diagnostics, a Failures section with each failure message and its location, and a closing VERDICT line), and the pipe would have replaced the exit code of the recipe with the exit code of the filter. Run app-test bare next time; for a machine-readable result set TUG_APPTEST_JSON=<path> and read that file afterwards."
jq -n --arg cmd "$REWRITTEN" --arg reason "$REASON" --argjson input "$INPUT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: $reason,
    updatedInput: ($input.tool_input + {command: $cmd})
  }
}'
