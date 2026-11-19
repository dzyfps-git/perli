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
print("s fixtures made")
