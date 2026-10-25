# Run dmgbuild with its disk-image plumbing routed through `diskutil image`.
#
# dmgbuild (1.6.7, the latest release) drives every image operation through
# `hdiutil`, and macOS 27 deprecates the verbs it uses — create, attach,
# detach, convert — each printing a WARNING to the build log. This driver
# replaces dmgbuild's one `hdiutil()` helper with a translation onto
# `diskutil image` / `diskutil eject`, then hands off to dmgbuild's own CLI,
# so the arguments and settings.py stay exactly as before.
#
# Where `diskutil image` does not exist (macOS before 26) the helper is left
# alone and dmgbuild runs unmodified.
#
# Invoked by build-app.sh with the interpreter dmgbuild is installed under:
#   python3 build-dmg.py -s settings.py -D ... "<Volume Name>" <output.dmg>

import math
import os
import plistlib
import re
import subprocess
import sys

import dmgbuild.core as core
from dmgbuild.__main__ import main

DISKUTIL = "/usr/sbin/diskutil"


def have_diskutil_image():
    try:
        p = subprocess.run(
            [DISKUTIL, "image"], capture_output=True, text=True, check=False
        )
    except OSError:
        return False
    return p.returncode == 0 and "disk images" in (p.stdout + p.stderr)


def run(args, plist):
    # `diskutil image` writes its progress meter to stderr; keep it out of the
    # build log and hand it back only as part of a failure's message.
    p = subprocess.run(args, capture_output=True, check=False)
    if plist and p.returncode == 0:
        return 0, plistlib.loads(p.stdout)
    return p.returncode, (p.stdout + p.stderr).decode(errors="replace")


def size_arg(size):
    # dmgbuild hands over "<float>K" (kilobytes); diskutil wants an integer.
    m = re.fullmatch(r"([0-9.]+)([A-Za-z]*)", size)
    if not m:
        return size
    return f"{math.ceil(float(m.group(1)))}{m.group(2)}"


def flags(args):
    # Split hdiutil's argument list into {"-flag": value} and positionals,
    # for the flags dmgbuild passes with a value.
    valued = {
        "-volname", "-fs", "-fsargs", "-size", "-format", "-o", "-owners",
        "-sectors", "-imagekey",
    }
    opts, rest = {}, []
    it = iter(args)
    for a in it:
        if a in valued:
            opts[a] = next(it)
        elif a.startswith("-"):
            opts[a] = True
        else:
            rest.append(a)
    return opts, rest


def diskutil_hdiutil(cmd, *args, **kwargs):
    plist = kwargs.get("plist", True)
    opts, rest = flags(args)

    if cmd == "create":
        (path,) = rest
        if opts.get("-fs", "APFS").upper() != "APFS":
            raise core.DMGError(
                core.quiet_callback,
                "diskutil image creates APFS volumes only; "
                'set filesystem = "APFS" in settings.py',
            )
        if os.path.exists(path):
            os.remove(path)
        return run(
            [
                DISKUTIL, "image", "--plist", "create", "blank",
                "--format", "RAW",
                "--size", size_arg(opts["-size"]),
                "--volumeName", opts["-volname"],
                "-fs", "APFS",
                path,
            ],
            plist,
        )

    if cmd == "attach":
        (path,) = rest
        args = [DISKUTIL, "image", "--plist", "attach"]
        if opts.get("-nobrowse"):
            args.append("--nobrowse")
        if opts.get("-owners") == "off":
            args += ["--mountOptions", "noowners"]
        return run(args + [path], plist)

    if cmd == "detach":
        (device,) = rest
        if opts.get("-force"):
            run([DISKUTIL, "unmountDisk", "force", device], False)
        return run([DISKUTIL, "eject", device], plist)

    if cmd == "resize":
        (path,) = rest
        return run([DISKUTIL, "image", "resize", "--size", "min", path], plist)

    if cmd == "convert":
        (source,) = rest
        dest = opts["-o"]
        if os.path.exists(dest):
            os.remove(dest)
        return run(
            [
                DISKUTIL, "image", "--plist", "create", "from",
                "--format", opts["-format"],
                source, dest,
            ],
            plist,
        )

    # Anything else (udifrez for a license, which settings.py does not use)
    # still goes to hdiutil.
    return HDIUTIL(cmd, *args, **kwargs)


HDIUTIL = core.hdiutil

if __name__ == "__main__":
    if have_diskutil_image():
        core.hdiutil = diskutil_hdiutil
    sys.exit(main())
