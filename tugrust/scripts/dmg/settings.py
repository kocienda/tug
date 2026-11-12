# dmgbuild settings for the Tug distribution disk image.
#
# Drives the branded drag-to-Applications window a user sees on opening
# Tug.dmg: the app icon on the left, an /Applications symlink on the right,
# the arrow and "Drag Tug to Applications" caption painted into the retina
# background, as much Finder chrome hidden as Finder will honour. Coordinates
# are in the 720x498 background (origin top-left, icon centers); every word
# and icon stays in its white band, the safe area described at window_rect.
#
# Invoked by build-app.sh as:
#   dmgbuild -s settings.py \
#     -D app=<staged Tug.app> -D background=<bg.tiff> -D icon=<VolumeIcon.icns> \
#     "<Volume Name>" <output.dmg>
# The volume name and output path are dmgbuild's two positional arguments;
# everything else arrives through -D defines so a nightly build can reuse this
# file with a different staged app and volume name.

import os.path

# -- Inputs --------------------------------------------------------------------

# dmgbuild exec()s this file, so __file__ is unavailable; build-app.sh always
# supplies these via -D. The background source of truth is the repo's
# resources/dmg-background.tiff (passed via -D background=...); the fallback
# bare name only matters for ad-hoc manual runs.
application = defines.get("app", "Tug.app")
appname = os.path.basename(application)

background = defines.get("background", "dmg-background.tiff")

# The volume icon (shown on the mounted disk and in the sidebar). Same artwork
# as the app icon; generated as VolumeIcon.icns beside this file.
icon = defines.get("icon", "VolumeIcon.icns")

# -- Image format ------------------------------------------------------------

format = "UDZO"  # compressed, read-only — matches the prior hdiutil output.

# APFS, not dmgbuild's HFS+ default: build-dmg.py creates the image with
# `diskutil image create blank`, which makes APFS volumes only.
filesystem = "APFS"

# -- Contents: just the app + an Applications symlink ------------------------

files = [application]
symlinks = {"Applications": "/Applications"}

# -- Window: sized for the chrome Finder shows anyway ------------------------

# window_rect = ((x, y), (w, h)), and h includes the title bar.
#
# Finder shows chrome a disk image cannot turn off, and all of it comes off the
# bottom of the visible background, which is anchored top-left under whatever
# sits above it:
#
#   title bar    27-28 pt on macOS 11-15, 32 pt on 26, 33 pt on 27   always
#   tab bar      ~36 pt     the user's View > Show Tab Bar
#   path bar     ~28 pt     the user's View > Show Path Bar
#   status bar   ~28 pt     the user's View > Show Status Bar
#
# show_pathbar, show_status_bar and show_tab_view below are written to the
# .DS_Store and Finder ignores them in favour of those global settings. The
# worst case is 33 + 36 + 28 + 28 = 125 pt, so the window is 400 + 125 = 525 pt
# tall and the top 400 pt of the background is visible on every Mac.
#
# The background (resources/dmg-preview.svg, rendered to dmg-background.tiff)
# is laid out for that:
#
#   y   0..36    dark grey band
#   y  36..400   white band: heading, wordmark, icons, arrow, caption
#   y 400..498   dark grey band, which is what the bars cover
#
# Keep every word and icon inside x 32..688, y 50..380: 32 pt at the sides is a
# 15 pt always-shown scroll bar plus a margin. The background is 498 pt tall,
# the window less the SMALLEST title bar (27 pt), so it reaches the bottom of
# the window on every macOS and none of Finder's own fill shows below it.
#
# The background's height does not set the window's scroll bounds (measured:
# 517 pt of art under 489 pt of visible content showed no scroll bar).
#
# Per the dmgbuild docs, y runs bottom-to-top and you cannot position relative
# to the screen's top-left or centre — but the Finder clamps the window onto
# the user's display, so a large y pins it to the top-left of ANY screen. We
# anchor there (the one display-independent corner): x=100 gives a left margin
# that's always honored; the top lands just under the menu bar (a reliable top
# margin isn't possible — the clamp wins).
window_rect = ((100, 100000), (720, 525))

default_view = "icon-view"
show_icon_preview = False

show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

# Icon-view layout. Explicit icon_locations win over any arrange-by ordering.
arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
scroll_position = (0, 0)
label_pos = "bottom"
text_size = 13
icon_size = 128

# Icon centers in the content area (origin top-left): symmetric about
# the horizontal center (360), 304 pt apart, leaving the central lane for the
# painted arrow, whose shaft is on the same y. With 128 pt icons and a label
# below, the row spans about y 195..347 of the white band.
#
# Only the two user-visible items are positioned. dmgbuild's own support files
# (the .background image and .VolumeIcon.icns) are deliberately NOT listed:
# dmgbuild copies them in as invisible dotfiles and the canonical recipe leaves
# them unpositioned. Positioning them anywhere off-canvas blows out the window's
# scroll bounds (the cause of the tall/scrolling window) — keep them out of this
# dict so the window's scroll bounds stay inside the background.
icon_locations = {
    appname: (208, 259),
    "Applications": (512, 259),
}

# Drop the ".app" extension so the icon label reads "Tug", not "Tug.app"
# (on Macs that don't already force all extensions visible).
hide_extension = [appname]
