"""Fixtures for PR 9A's real-app check: a folder for Space to weigh, with parts of different sizes and years."""
import os
import pathlib
import sys
import time

home = pathlib.Path(sys.argv[1])
root = home / "space-root"


def made(path, size, year=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(os.urandom(size))
    if year:
        stamp = time.mktime((year, 6, 1, 12, 0, 0, 0, 0, -1))
        os.utime(path, (stamp, stamp))


made(root / "big" / "a.dat", 3_000_000, 2019)
made(root / "big" / "inner" / "b.dat", 1_000_000, 2021)
made(root / "photos" / "beach.jpg", 2_000_000, 2023)
made(root / "photos" / "hill.jpg", 900_000, 2023)
made(root / "small" / "x.txt", 4_000)
made(root / "notes.txt", 10_000)
made(root / "old.bin", 500_000, 2018)
made(root / "copy-src.txt", 2_000)
# More small things than Brain gives a node each, so some fold into one.
for n in range(14):
    made(root / f"tiny-{n:02}.log", 100 + n)


# PR 9B and 9C.
import random
import struct


def bmp(path, width, height, pixel):
    """A 24-bit BMP, which Windows' own decoder reads, so no picture library is needed."""
    stride = (width * 3 + 3) & ~3
    data = bytearray()
    for y in range(height - 1, -1, -1):
        line = bytearray()
        for x in range(width):
            red, green, blue = pixel(x, y)
            line += bytes((blue, green, red))
        data += line + b"\0" * (stride - width * 3)
    head = b"BM" + struct.pack("<IHHI", 54 + len(data), 0, 0, 54) + struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(head + data)


def dated(path, year, month=6, day=1):
    stamp = time.mktime((year, month, day, 12, 0, 0, 0, 0, -1))
    os.utime(path, (stamp, stamp))


# The Time river: three files on one day, nothing else.
for n in range(3):
    made(home / "river-root" / f"r{n}.txt", 3_000)
    dated(home / "river-root" / f"r{n}.txt", 2024, 3, 10)

# Twins: three copies of one file, oldest first in the folder itself, and one file of its own.
same = os.urandom(50_000)
for name, year in [("a.dat", 2020), ("copy1/a.dat", 2022), ("copy2/a-copy.dat", 2023)]:
    path = home / "twins-root" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(same)
    dated(path, year)
made(home / "twins-root" / "unique.dat", 50_000)

# Pictures that look alike: a gradient, the same with a little noise, and a checkerboard.
noise = random.Random(7)
bmp(home / "twins-photos" / "p1.bmp", 128, 96, lambda x, y: (x * 2, y * 2, 128))
bmp(home / "twins-photos" / "p2.bmp", 128, 96, lambda x, y: tuple(max(0, min(255, v + noise.randint(-6, 6))) for v in (x * 2, y * 2, 128)))
bmp(home / "twins-photos" / "p3.bmp", 128, 96, lambda x, y: (255, 255, 255) if (x // 16 + y // 16) % 2 else (0, 0, 0))

# The Colour wall: names in one order, colours in another.
for name, colour in [("a-blue", (40, 70, 220)), ("b-grey", (128, 128, 128)), ("c-red", (220, 40, 40)), ("d-green", (40, 180, 60))]:
    bmp(home / "colour-root" / f"{name}.bmp", 64, 64, lambda x, y, colour=colour: colour)

# Fingerprints: a folder of other things, and one with a picture, which keeps its stack.
for name in ["a.txt", "b.txt", "c.pdf", "d.mp3", "e.mp3", "f.zip"]:
    made(home / "fp-root" / "docs" / name, 1_000)
bmp(home / "fp-root" / "pics" / "x.bmp", 32, 32, lambda x, y: (200, 120, 40))

# The copy stream and the sync bridge: enough small files for a job to take a few seconds.
for n in range(1500):
    made(home / "stream-src" / "batch" / f"f{n:04}.dat", 20_000)
(home / "stream-dst").mkdir(parents=True, exist_ok=True)

# Compare threads: two names on both sides, one only on each.
for side in ["cmp-a", "cmp-b"]:
    made(home / side / "same.txt", 0)
    (home / side / "same.txt").write_text("x")
    dated(home / side / "same.txt", 2022)
    (home / side / "newer.txt").write_text(side)
    dated(home / side / "newer.txt", 2021 if side == "cmp-a" else 2023)
    (home / side / f"only-{side[-1]}.txt").write_text(side)

print("s fixtures made")
