#!/usr/bin/env python3
"""Seed the local Saladbooru review gallery with synthetic images and tags."""

import json
import pathlib
import struct
import time
import urllib.error
import urllib.request
import zlib
from typing import TypedDict, cast


class Post(TypedDict):
    """Image fields used when validating the seeded gallery."""

    name: str


class PostsResponse(TypedDict):
    """Image list returned by the gallery API."""

    items: list[Post]


ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
REVIEW = DATA / "tag-review"
IMAGES = REVIEW / "images"
BASE = "http://127.0.0.1:18080"
DIGITS = (
    "111101101101111",
    "010110010010111",
    "111001111100111",
    "111001111001111",
    "101101111001001",
    "111100111001111",
    "111100111101111",
    "111001001001001",
    "111101111101111",
    "111101111001111",
)
SIZES = ((120, 200), (200, 120), (144, 144), (96, 240), (240, 96))
CHARACTERS = (
    "Aiko",
    "Ren",
    "Mina",
    "Sora",
    "Yui",
    "Kai",
    "Nami",
    "Rin",
    "Haru",
    "Momo",
    "Tao",
    "Aya",
)
OTHERS = ("night", "sketch", "blue", "sunset", "garden", "retro")


def png(index: int) -> bytes:
    """Build a visibly distinct synthetic PNG for the review grid."""
    width, height = SIZES[index % len(SIZES)]
    bg = ((index * 41) % 155 + 50, (index * 67) % 150 + 50, (index * 97) % 135 + 65)
    accent = tuple(255 - channel for channel in bg)
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            color = (
                accent
                if ((x + (y // 9) * 7 + index) // 30) % 7 == 0
                or (x - width // 2) ** 2 + (y - height // 3) ** 2
                < (min(width, height) // 5) ** 2
                else bg
            )
            raw.extend(color)
    number = f"{index:04d}"
    scale = 4
    origin_x = (width - 4 * 4 * scale) // 2
    origin_y = height - 5 * scale - 12
    for digit_index, char in enumerate(number):
        pixels = DIGITS[int(char)]
        for row in range(5):
            for col in range(3):
                if pixels[row * 3 + col] != "1":
                    continue
                for dy in range(scale):
                    for dx in range(scale):
                        x = origin_x + (digit_index * 4 + col) * scale + dx
                        y = origin_y + row * scale + dy
                        offset = y * (width * 3 + 1) + 1 + x * 3
                        raw[offset : offset + 3] = b"\xff\xff\xff"

    def chunk(kind: bytes, data: bytes) -> bytes:
        """Encode a PNG chunk with its checksum."""
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def tags(index: int) -> list[str]:
    """Return deterministic example tags for one image."""
    result = [f"Work {index % 20 + 1:02d}"]
    if index % 7:
        result.append(CHARACTERS[(index // 3) % len(CHARACTERS)])
    if index % 3 == 0:
        result.append(OTHERS[(index // 11) % len(OTHERS)])
    if index % 9 == 0:
        result.append("portrait")
    if index % 17 == 0:
        result.append("nsfw")
    return result


def request(path: str, data: bytes | None = None) -> object:
    """Send a JSON request to the local review gallery."""
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers=headers,
        method="PUT" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Review API request failed: HTTP {error.code}") from None


def main() -> None:
    """Seed missing review images and their initial tags."""
    if any(path.is_symlink() for path in (DATA, REVIEW, IMAGES)):
        raise RuntimeError("Review data directory must not be a symlink")
    IMAGES.mkdir(parents=True, exist_ok=True)
    # Interrupted initial seeding is not repaired; add a marker if needed.
    created: set[str] = set()
    for index in range(1000):
        path = IMAGES / f"review-{index:04d}.png"
        if path.is_symlink():
            raise RuntimeError(f"Unsafe review file: {path.name}")
        if not path.exists():
            with path.open("xb") as image:
                image.write(png(index))
            created.add(path.name)
    items: list[Post] = []
    for attempt in range(30):
        try:
            items = cast(PostsResponse, request("/api/posts"))["items"]
            break
        except OSError:
            if attempt == 29:
                raise RuntimeError("Review API did not become ready") from None
            time.sleep(1)
    names = {item["name"] for item in items}
    if len(items) != 1000 or names != {
        f"review-{index:04d}.png" for index in range(1000)
    }:
        raise RuntimeError(
            "Review gallery must contain only the 1,000 generated images"
        )
    if created:
        for index in range(1000):
            name = f"review-{index:04d}.png"
            if name in created:
                request(
                    "/api/posts/" + name + "/tags",
                    json.dumps({"tags": tags(index)}).encode(),
                )
    print(f"Review seed ready: 1000 images ({len(created)} new; existing tags kept)")


if __name__ == "__main__":
    main()
