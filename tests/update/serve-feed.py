#!/usr/bin/env python3
"""serve-feed.py — the local appcast's web server, with a throttle and ranges.

`python3 -m http.server` is what stood up the local feed until a download had
to be *watched*. Two things it does not do:

  * **Throttle.** A 90 MB archive off the loopback interface arrives faster
    than a progress bar can be read, let alone paused mid-transfer. A rate in
    kilobytes per second turns the rehearsal into something a person can see
    happen.
  * **Serve ranges.** `SimpleHTTPRequestHandler` answers every GET with the
    whole file and no `Accept-Ranges`, so a transfer that stops has nothing to
    resume against — `URLSession`'s resume data is a `Range` request, and a
    server that ignores it hands back the file from the top.

Both are here for the same reason: the pause-and-resume work needs a feed you
can interrupt. Nothing about the appcast or the archive changes — this serves
the same directory the same way, only slower and in pieces when asked.

Usage:
    serve-feed.py <directory> <port> [rate-kbps]

A rate of 0 (the default) is unthrottled.
"""

from __future__ import annotations

import os
import sys
import time
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Written to the socket in one go before the throttle sleeps again. Small
# enough that a paused transfer stops promptly, large enough that a fast rate
# is not a syscall storm: a tenth of a second's worth, floored at 8 KB.
MIN_CHUNK = 8 * 1024


class FeedHandler(SimpleHTTPRequestHandler):
    """A static handler that honours `Range` and obeys a rate limit."""

    rate_bytes_per_second = 0

    def send_head(self):  # noqa: N802 — the base class's spelling
        """Answer a `Range` request with 206 and the requested slice.

        Falls through to the base class for everything else, so a plain GET is
        served exactly as it was before this file existed.
        """
        rng = self.headers.get("Range")
        if rng is None or not rng.startswith("bytes="):
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            size = os.fstat(handle.fileno()).st_size
            first, _, last = rng[len("bytes=") :].partition("-")
            # Only the `bytes=N-` and `bytes=N-M` forms; a suffix range
            # (`bytes=-N`) is not something a resume ever asks for.
            if first == "":
                handle.close()
                return super().send_head()
            start = int(first)
            end = int(last) if last else size - 1
            if start >= size or end < start:
                handle.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None
            end = min(end, size - 1)
            handle.seek(start)
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            stat = os.fstat(handle.fileno())
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.send_header("ETag", f'"{stat.st_mtime_ns:x}-{size:x}"')
            self.end_headers()
            # The base class copies to EOF; bound the copy to the slice.
            return _Slice(handle, end - start + 1)
        except (OSError, ValueError):
            handle.close()
            raise

    def send_response(self, code, message=None):
        # `Accept-Ranges` on every answer, including the whole-file one: a
        # client decides whether a transfer is resumable from the first
        # response it sees, long before it asks for a range.
        super().send_response(code, message)
        self.send_header("Accept-Ranges", "bytes")

    def copyfile(self, source, outputfile):
        rate = self.rate_bytes_per_second
        if rate <= 0:
            super().copyfile(source, outputfile)
            return
        chunk = max(MIN_CHUNK, rate // 10)
        while True:
            block = source.read(chunk)
            if not block:
                break
            outputfile.write(block)
            outputfile.flush()
            time.sleep(len(block) / rate)


class _Slice:
    """A read-only view of `handle` that stops after `remaining` bytes."""

    def __init__(self, handle, remaining: int):
        self._handle = handle
        self._remaining = remaining

    def read(self, size: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        want = self._remaining if size is None or size < 0 else min(size, self._remaining)
        block = self._handle.read(want)
        self._remaining -= len(block)
        return block

    def close(self) -> None:
        self._handle.close()


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    directory = argv[1]
    port = int(argv[2])
    rate_kbps = int(argv[3]) if len(argv) > 3 else 0

    FeedHandler.rate_bytes_per_second = rate_kbps * 1000
    handler = partial(FeedHandler, directory=directory)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    if rate_kbps > 0:
        print(f"==> Serving {directory} on 127.0.0.1:{port} at {rate_kbps} kB/s", flush=True)
    else:
        print(f"==> Serving {directory} on 127.0.0.1:{port}, unthrottled", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
