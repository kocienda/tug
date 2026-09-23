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
# Output is append-only — a completed step prints one line with its duration
# and scrolls away. The in-flight step is redrawn in place on a terminal and
# reprinted periodically when piped, so a log of this is still readable.
#
# Usage: watch-release-run.sh <run-id>
# Exits non-zero when the run does, replacing `gh run watch --exit-status`.

set -euo pipefail

RUN_ID="${1:?usage: watch-release-run.sh <run-id>}"
# How often to ask GitHub. Five seconds is well inside the API's budget for a
# run that lasts minutes, and it keeps the elapsed counter from reading as
# stalled.
INTERVAL="${TUG_RELEASE_WATCH_INTERVAL:-5}"

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
LAST_LIVE=""
LAST_LIVE_PRINTED=0

while :; do
    SNAPSHOT="$(gh run view "$RUN_ID" --json status,conclusion,jobs --jq '
        (["RUN", .status, (.conclusion // "")] | @tsv),
        (.jobs[].steps[] | ["STEP", .status, (.conclusion // ""),
           (if .startedAt == null then 0 else (.startedAt | fromdateiso8601) end),
           (if .completedAt == null then 0 else (.completedAt | fromdateiso8601) end),
           .name] | @tsv)' 2>/dev/null || true)"

    if [ -z "$SNAPSHOT" ]; then
        clear_line
        echo "    (no answer from GitHub — retrying)"
        sleep "$INTERVAL"
        continue
    fi

    RUN_STATUS=""
    RUN_CONCLUSION=""
    RUNNING_NAME=""
    RUNNING_SINCE=0
    NOW="$(date +%s)"

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

    # The in-flight step, with the elapsed counter that is the point of all
    # this. Redrawn in place on a terminal; reprinted at a slower cadence when
    # piped, so a captured log shows progress without being mostly progress.
    if [ -n "$RUNNING_NAME" ] && [ "$RUNNING_SINCE" -gt 0 ]; then
        ELAPSED=$((NOW - RUNNING_SINCE))
        NOTE="$(step_note "$RUNNING_NAME")"
        LINE="  … $RUNNING_NAME — $(fmt_duration "$ELAPSED") elapsed"
        if [ "$TTY" -eq 1 ]; then
            printf '\033[2K\r%s' "$LINE"
            # The note explains the wait, and is worth exactly one printing per
            # step: repeated under a redrawing counter it would be noise.
            if [ -n "$NOTE" ] && [ "$LAST_LIVE" != "$RUNNING_NAME" ]; then
                printf '\n    (%s)\n' "$NOTE"
            fi
            LAST_LIVE="$RUNNING_NAME"
        else
            if [ "$LAST_LIVE" != "$RUNNING_NAME" ]; then
                echo "$LINE"
                [ -n "$NOTE" ] && echo "    ($NOTE)"
                LAST_LIVE="$RUNNING_NAME"
                LAST_LIVE_PRINTED="$NOW"
            elif [ $((NOW - LAST_LIVE_PRINTED)) -ge 30 ]; then
                echo "$LINE"
                LAST_LIVE_PRINTED="$NOW"
            fi
        fi
    fi

    sleep "$INTERVAL"
done
