#!/usr/bin/env bash
# appcast-add-floor.sh — state the release's Claude Code floor on its appcast item.
#
# A Tug release can raise the oldest Claude Code it runs against. The running
# Tug has to know that before it installs the update, and the only thing it has
# read about the incoming version at that point is the appcast item. So the
# item carries the floor as one element of Tug's own:
#
#   <tug:minimumClaudeCodeVersion>2.1.285</tug:minimumClaudeCodeVersion>
#
# Sparkle keeps every item child it does not recognize as a string in
# `SUAppcastItem.propertiesDictionary`, keyed by the element's name as written,
# which is where the host reads it (`UpdateSnapshot.claudeCodeFloor(in:)`). An
# item without the element reads as "no floor stated".
#
# Usage:
#   appcast-add-floor.sh <appcast.xml> [<floor-file>]
#
# The floor file defaults to capabilities/FLOOR, the one place the number is
# written. The appcast is edited in place.
#
# What this does not disturb: Sparkle verifies `sparkle:edSignature`, which is
# a signature over the *archive's* bytes, carried as an attribute of the
# enclosure. Adding a sibling element changes nothing it covers. A *signed
# feed* is different — generate_appcast appends a signature over the feed's own
# text when the app sets SURequireSignedFeed, and any edit after that would
# break it. Tug does not sign its feed; if that ever changes this script
# refuses rather than publish a feed every installed app would reject.
set -euo pipefail

ELEMENT="tug:minimumClaudeCodeVersion"
NAMESPACE="https://github.com/kocienda/tug/xml-namespaces/tug"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "usage: $(basename "$0") <appcast.xml> [<floor-file>]" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

APPCAST="$1"
FLOOR_FILE="${2:-$REPO_ROOT/capabilities/FLOOR}"

if [ ! -f "$APPCAST" ]; then
    echo "error: appcast not found: $APPCAST" >&2
    exit 1
fi
if [ ! -f "$FLOOR_FILE" ]; then
    echo "error: floor file not found: $FLOOR_FILE" >&2
    exit 1
fi

FLOOR="$(tr -d '[:space:]' < "$FLOOR_FILE")"
if ! printf '%s' "$FLOOR" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "error: $FLOOR_FILE holds '$FLOOR', not a version like 2.1.285" >&2
    exit 1
fi

if grep -q 'sparkle-signatures:' "$APPCAST"; then
    echo "error: $APPCAST is a signed feed — adding the floor would invalidate its signature" >&2
    exit 1
fi

/usr/bin/python3 - "$APPCAST" "$FLOOR" "$ELEMENT" "$NAMESPACE" <<'PY'
import re
import sys
import xml.dom.minidom

path, floor, element, namespace = sys.argv[1:5]
prefix = element.split(":")[0]

with open(path, encoding="utf-8") as handle:
    text = handle.read()

# The feed is edited as text, not re-serialized: a parser would be free to
# rename the sparkle prefix or reorder attributes, and the point is to add one
# line and leave every other byte as generate_appcast wrote it.
if f"<{element}>" in text:
    sys.exit(f"error: {path} already carries a <{element}>")

rss = re.search(r"<rss\b[^>]*>", text)
if rss is None:
    sys.exit(f"error: {path} has no <rss> element")
if f"xmlns:{prefix}=" not in rss.group(0):
    opened = rss.group(0)[:-1] + f' xmlns:{prefix}="{namespace}">'
    text = text[: rss.start()] + opened + text[rss.end() :]

closes = [match.start() for match in re.finditer(r"[ \t]*</item>", text)]
if len(closes) != 1:
    sys.exit(f"error: {path} has {len(closes)} items; the feed carries exactly one")
at = closes[0]
indent = re.match(r"[ \t]*", text[at:]).group(0)
text = text[:at] + f"{indent}    <{element}>{floor}</{element}>\n" + text[at:]

# Read it back the way a consumer would before anything is written: the feed
# must still parse, and the item must hold the element with the floor in it.
document = xml.dom.minidom.parseString(text.encode("utf-8"))
items = document.getElementsByTagName("item")
found = [
    node.firstChild.data
    for node in items[0].childNodes
    if node.nodeType == node.ELEMENT_NODE and node.nodeName == element
]
if found != [floor]:
    sys.exit(f"error: the edited feed does not carry <{element}>{floor}")

with open(path, "w", encoding="utf-8") as handle:
    handle.write(text)
PY

echo "==> Claude Code floor: $FLOOR (<$ELEMENT>)"
