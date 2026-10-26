"""Fetch a port's tide table and write it where the service reads it."""

import json
import sys
from urllib.request import urlopen

FEED = "https://tides.example.org/ports/{port}/today.json"


def fetch(port: str) -> list[dict]:
    with urlopen(FEED.format(port=port)) as response:
        return json.load(response)["tides"]


if __name__ == "__main__":
    port = sys.argv[1]
    with open(f"tides/{port}.json", "w") as out:
        json.dump(fetch(port), out, indent=2)
