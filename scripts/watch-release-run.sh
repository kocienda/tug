#!/usr/bin/env bash
#
# Watch a Stable Release run, and say how long things are taking.
#
# `gh run watch` prints a checklist and refreshes it every few seconds. What it
# never prints is a duration — not for the run, not for the step it is sitting
# on. So a release that is working normally and a release that is wedged look
# exactly alike for six minutes, and the only honest thing a person can do is
# wait and wonder. That is the whole reason this script exists.
#
# The shape of a release run, measured rather than guessed (run 35927571530):
#
#     Build signed DMG and update archive     5m54s
#     everything else, all seventeen steps    1m45s
#
# One step is three quarters of the wall clock, and most of that step is
# `notarytool` blocking on Apple's notary service, which returns when it
# returns. Naming that is most of the feedback anybody needs: the wait is
# expected, it is outside this repository, and it is not a hang.
#
# A step is announced the moment it starts rather than when it ends. The
# running step holds the last line of the terminal with a counter that ticks
# every second, and settles in place into the same line carrying its final
# duration when it finishes — so the log is append-only and one line per step,
# and the line you are watching is the line that stays.
#
# The tick is local: it is the step's start time against this machine's clock,
# so the counter moves every second rather than once per poll, and keeps moving
# through a poll GitHub did not answer. Piped, the same information is
# reprinted periodically instead of redrawn, so a log of this is readable.
#
# Usage: watch-release-run.sh <run-id>
# Exits non-zero when the run does, replacing `gh run watch --exit-status`.

set -euo pipefail

RUN_ID="${1:?usage: watch-release-run.sh <run-id>}"
# How often to ask GitHub. This is now only what decides how soon a step's name
# appears after it starts, since the counter ticks locally, so it is set for
# that: two seconds reads as immediate. A release run is eight minutes, which
# makes this a few hundred requests against an hourly budget of five thousand —
# `gh run watch` polls every three seconds for the same reason.
INTERVAL="${TUG_RELEASE_WATCH_INTERVAL:-2}"

if [ -t 1 ]; then TTY=1; else TTY=0; fi

# Render seconds the way a person reads them.
fmt_duration() {
    local s="$1"
    if [ "$s" -lt 0 ]; then s=0; fi
    if [ "$s" -lt 60 ]; then
        printf '%ds' "$s"
    else
        printf '%dm%02ds' $((s / 60)) $((s % 60))
    fi
}

# What a step is actually doing, where the name alone would leave somebody
# watching a spinner for minutes with no idea whether to worry. Only the steps
# that take real time earn a note; annotating the two-second ones would bury
# the one that matters.
step_note() {
    case "$1" in
        "Build signed DMG and update archive")
            printf 'compiles the app, signs it, and notarizes — the notary wait is Apple'"'"'s and can run several minutes' ;;
        "Generate the appcast")
            printf 'resolves Sparkle, then signs the feed' ;;
        "Publish the versioned release")
            printf 'uploads the DMG' ;;
        "Publish the update feed")
            printf 'uploads the archive and the appcast — installed copies see the update after this' ;;
        Post*)
            printf 'post-job cleanup; the release itself is already published' ;;
        *) printf '' ;;
    esac
}

clear_line() {
    [ "$TTY" -eq 1 ] && printf '\033[2K\r'
    return 0
}

URL="$(gh run view "$RUN_ID" --json url --jq '.url' 2>/dev/null || true)"
echo "==> Watching run $RUN_ID"
[ -n "$URL" ] && echo "    $URL"
echo
echo "    A release takes roughly eight minutes. Nearly all of it is one step:"
echo "    building, signing and notarizing the DMG. Notarization waits on Apple."
echo

WATCH_STARTED="$(date +%s)"
# Step names already reported as finished, so the append-only log never repeats
# one. Newline-delimited because a bash 3.2 associative array is not available
# on a stock macOS shell.
REPORTED=$'\n'
# The step the live line is about, and when it was last reprinted for a pipe.
# A step's note is printed once, permanently, *before* the counter's first
# draw: the counter has to own the last line for a redraw to land on itself, so
# anything printed after it pushes it down and orphans the draw above.
LIVE_NAME=""
LIVE_PRINTED=0
# The last snapshot that arrived, kept so a poll GitHub did not answer costs
# freshness rather than the counter. Everything rendered from it is either
# already known — a step's name, the second it started — or computed from this
# machine's clock, so a stale snapshot still ticks correctly.
SNAPSHOT=""
LAST_POLL=0
POLL_FAILING=0

while :; do
    NOW="$(date +%s)"

    if [ $((NOW - LAST_POLL)) -ge "$INTERVAL" ]; then
        FRESH="$(gh run view "$RUN_ID" --json status,conclusion,jobs --jq '
            (["RUN", .status, (.conclusion // "")] | @tsv),
            (.jobs[].steps[] | ["STEP", .status, (.conclusion // "-"),
               (if .startedAt == null then 0 else (.startedAt | fromdateiso8601) end),
               (if .completedAt == null then 0 else (.completedAt | fromdateiso8601) end),
               .name] | @tsv)' 2>/dev/null || true)"
        LAST_POLL="$(date +%s)"
        if [ -n "$FRESH" ]; then
            SNAPSHOT="$FRESH"
            POLL_FAILING=0
        elif [ "$POLL_FAILING" -eq 0 ]; then
            # Once per outage, not once per poll. The counter keeps ticking
            # through it, so this says the step list is stale, not that
            # anything is stuck.
            POLL_FAILING=1
            clear_line
            echo "    (no answer from GitHub — still counting, retrying)"
        fi
    fi

    if [ -z "$SNAPSHOT" ]; then
        sleep 1
        continue
    fi

    RUN_STATUS=""
    RUN_CONCLUSION=""
    RUNNING_NAME=""
    RUNNING_SINCE=0

    # Tab is IFS *whitespace*, so `read` collapses a run of tabs into one
    # delimiter and drops empty fields on the floor. A step that has not
    # finished has no conclusion, so that field is the one that goes empty, and
    # every field after it shifts left by one: the name lands in D and NAME
    # comes out blank. That is why the in-flight line below never drew for the
    # whole life of this script. The `// "-"` above is the fix -- no field is
    # ever empty -- and it has to stay that way for any field added here.
    while IFS=$'\t' read -r KIND A B C D NAME; do
        case "$KIND" in
            RUN)
                RUN_STATUS="$A"
                RUN_CONCLUSION="$B"
                ;;
            STEP)
                if [ "$A" = "completed" ]; then
                    case "$REPORTED" in
                        *$'\n'"$NAME"$'\n'*) ;;
                        *)
                            REPORTED="$REPORTED$NAME"$'\n'
                            DUR=$((D - C))
                            [ "$C" -eq 0 ] && DUR=0
                            MARK="✓"
                            [ "$B" = "success" ] || MARK="✗"
                            [ "$B" = "skipped" ] && MARK="–"
                            clear_line
                            printf '  %s %-48s %8s\n' \
                                "$MARK" "$NAME" "$(fmt_duration "$DUR")"
                            ;;
                    esac
                elif [ "$A" = "in_progress" ]; then
                    RUNNING_NAME="$NAME"
                    RUNNING_SINCE="$C"
                fi
                ;;
        esac
    done <<< "$SNAPSHOT"

    if [ "$RUN_STATUS" = "completed" ]; then
        clear_line
        TOTAL=$((NOW - WATCH_STARTED))
        echo
        if [ "$RUN_CONCLUSION" = "success" ]; then
            echo "==> Release run succeeded (watched for $(fmt_duration "$TOTAL"))"
            [ -n "$URL" ] && echo "    $URL"
            exit 0
        fi
        echo "==> Release run $RUN_CONCLUSION (watched for $(fmt_duration "$TOTAL"))"
        [ -n "$URL" ] && echo "    $URL"
        if [ "$RUN_CONCLUSION" = "failure" ]; then
            echo
            echo "--- failing step log (tail) ---"
            gh run view "$RUN_ID" --log-failed 2>/dev/null | tail -40 || true
        fi
        exit 1
    fi

    # The in-flight step: announced on the first poll that sees it, then ticked
    # once a second in the column the settled line will use, so the counter
    # turns into the duration in place. This is the point of the whole script —
    # a release that is working and a release that is wedged differ only in
    # whether this number is moving.
    if [ -n "$RUNNING_NAME" ] && [ "$RUNNING_SINCE" -gt 0 ]; then
        ELAPSED=$((NOW - RUNNING_SINCE))
        if [ "$TTY" -eq 1 ]; then
            if [ "$LIVE_NAME" != "$RUNNING_NAME" ]; then
                NOTE="$(step_note "$RUNNING_NAME")"
                [ -n "$NOTE" ] && printf '    (%s: %s)\n' "$RUNNING_NAME" "$NOTE"
                LIVE_NAME="$RUNNING_NAME"
            fi
            printf '\033[2K\r  … %-48s %8s' \
                "$RUNNING_NAME" "$(fmt_duration "$ELAPSED")"
        else
            if [ "$LIVE_NAME" != "$RUNNING_NAME" ]; then
                NOTE="$(step_note "$RUNNING_NAME")"
                printf '  … %-48s %8s\n' "$RUNNING_NAME" "$(fmt_duration "$ELAPSED")"
                [ -n "$NOTE" ] && echo "    ($NOTE)"
                LIVE_NAME="$RUNNING_NAME"
                LIVE_PRINTED="$NOW"
            elif [ $((NOW - LIVE_PRINTED)) -ge 30 ]; then
                printf '  … %-48s %8s\n' "$RUNNING_NAME" "$(fmt_duration "$ELAPSED")"
                LIVE_PRINTED="$NOW"
            fi
        fi
    fi

    sleep 1
done
