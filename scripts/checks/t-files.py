"""Fixtures for Phase 10's real-app check (PRs 10A and 10B)."""
import ctypes
import os
import pathlib
import sys
import time

home = pathlib.Path(sys.argv[1])


def made(path, size=0, text=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if text is not None:
        path.write_text(text)
    else:
        path.write_bytes(os.urandom(size))
    return path


def dated(path, year, month=6, day=1, hour=12):
    stamp = time.mktime((year, month, day, hour, 0, 0, 0, 0, -1))
    os.utime(path, (stamp, stamp))


# Space with the index: a folder of a few parts, weighed from the list once the index is ready.
made(home / "space-root" / "big" / "a.dat", 3_000_000)
made(home / "space-root" / "big" / "inner" / "b.dat", 1_000_000)
made(home / "space-root" / "notes.txt", 10_000)

# Tags at scale: more files than the old cap of 600.
for n in range(1200):
    made(home / "tags-root" / f"t{n:04}.txt", text="x")

# The river and Show hidden: two plain files and a hidden one, all on one day.
for name in ["plain1.txt", "plain2.txt", "secret.txt"]:
    dated(made(home / "river-hidden" / name, 2_000), 2024, 3, 10)
ctypes.windll.kernel32.SetFileAttributesW(str(home / "river-hidden" / "secret.txt"), 0x2)

# Twins across places: the same file in two folders, and one of its own.
same = os.urandom(40_000)
for name in ["a/x.dat", "b/y.dat"]:
    path = home / "twins-multi" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(same)
made(home / "twins-multi" / "c" / "z.dat", 40_000)

# The tide on a home drive card: a file big enough to move the drive's free space.
made(home / "tide-src" / "big.bin", 30_000_000)
(home / "tide-dst").mkdir(parents=True, exist_ok=True)

# Fingerprints that follow the theme.
for name in ["a.txt", "b.txt", "c.pdf", "d.mp3", "e.mp3", "f.zip"]:
    made(home / "fp-root" / "docs" / name, 1_000)

# Stacked compare threads.
for side in ["cmp-a", "cmp-b"]:
    made(home / side / "same.txt", text="x")
    made(home / side / "newer.txt", text=side)
    dated(home / side / "newer.txt", 2021 if side == "cmp-a" else 2023)

# The copy stream from deeper under a pane's folder into a folder inside the other's.
for n in range(1500):
    made(home / "stream-src" / "deep" / "batch" / f"f{n:04}.dat", 20_000)
(home / "stream-dst" / "sub").mkdir(parents=True, exist_ok=True)

# A diagram that draws again in the new theme's colours.
made(home / "diagram.mmd", text="graph TD\n  A[Start] --> B{Choice}\n  B --> C[One]\n  B --> D[Two]\n")

# Sync when something changes.
made(home / "sync-from" / "a.txt", text="first")
(home / "sync-to").mkdir(parents=True, exist_ok=True)

# S3: a folder of many small files, deleted in one batch.
for n in range(30):
    made(home / "many" / f"m{n:02}.txt", text=f"file {n}")

print("t fixtures made")
