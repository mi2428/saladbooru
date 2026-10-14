"""Create a reproducible gallery of solid-color images for screenshots."""

import json
import os
import random
import struct
import zlib
from pathlib import Path


def png(index: int) -> bytes:
    width = 80 + (index * 73) % 400
    height = 80 + (index * 139) % 400
    color = bytes(
        ((index * 41) % 206 + 25, (index * 67) % 211 + 22, (index * 97) % 199 + 30)
    )

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress((b"\x00" + color * width) * height))
        + chunk(b"IEND", b"")
    )


data = Path(__file__).resolve().parent.parent / "data"
demo = data / "screenshot-300-solid-varied"
if data.is_symlink() or demo.exists() or demo.is_symlink():
    raise SystemExit("Demo data already exists or the data directory is a symlink")

rng = random.Random(300)
slots = [1] * 75 + [2] * 135 + [3] * 90
rng.shuffle(slots)
assigned: list[list[str]] = [[] for _ in slots]
numbers = list(range(1, 31))
rng.shuffle(numbers)
for number in numbers:
    choices = [index for index, left in enumerate(slots) if left]
    rng.shuffle(choices)
    choices.sort(key=lambda index: slots[index], reverse=True)
    count = 36 - number
    assert len(choices) >= count
    for index in choices[:count]:
        assigned[index].append(f"Tag{number}")
        slots[index] -= 1
assert not any(slots)

demo.mkdir(mode=0o700)
images = demo / "images"
images.mkdir()
tags = {}
for index in range(300):
    name = f"demo-{index:03d}.png"
    (images / name).write_bytes(png(index))
    tags[name] = assigned[index]

fd = os.open(demo / "tags.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as output:
    json.dump(tags, output)
print("Demo data ready: 300 unique widths and heights, solid colors, ranked tags")
