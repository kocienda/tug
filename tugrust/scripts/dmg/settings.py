# dmgbuild settings for the Tug distribution disk image.
#
# Drives the branded drag-to-Applications window a user sees on opening
# Tug.dmg: the app icon on the left, an /Applications symlink on the right,
# the arrow and "Drag Tug to Applications" caption painted into the retina
# background, all Finder chrome hidden. Coordinates follow the plan's DMG
# geometry (720x460 content area, origin top-left, icon centers).
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

# -- Window: hidden chrome, sized exactly to the background ------------------

# window_rect = ((x, y), (w, h)); 720x460 matches the background art exactly.
# Per the dmgbuild docs, y runs bottom-to-top and you cannot position relative
# to the screen's top-left or centre — but the Finder clamps the window onto
# the user's display, so a large y pins it to the top-left of ANY screen. We
# anchor there (the one display-independent corner): x=100 gives a left margin
# that's always honored; the top lands just under the menu bar (a reliable top
# margin isn't possible — the clamp wins).
window_rect = ((100, 100000), (720, 460))

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

# Icon centers in the 720x460 content area (origin top-left): symmetric about
# the horizontal center (360), 304 pt apart, leaving the central lane for the
# painted arrow. See the plan's DMG coordinate table.
#
# Only the two user-visible items are positioned. dmgbuild's own support files
# (the .background image and .VolumeIcon.icns) are deliberately NOT listed:
# dmgbuild copies them in as invisible dotfiles and the canonical recipe leaves
# them unpositioned. Positioning them anywhere off-canvas blows out the window's
# scroll bounds (the cause of the tall/scrolling window) — keep them out of this
# dict so the window clips exactly to the 720x460 background.
icon_locations = {
    appname: (208, 250),
    "Applications": (512, 250),
}

# Drop the ".app" extension so the icon label reads "Tug", not "Tug.app"
# (on Macs that don't already force all extensions visible).
hide_extension = [appname]
