"""Fixtures for the PR A1 real-app check, made in the folders given: home, then templates."""
import io
import struct
import sys
import zipfile
import zlib
from pathlib import Path

home, templates = Path(sys.argv[1]), Path(sys.argv[2])
home.mkdir(parents=True, exist_ok=True)
templates.mkdir(parents=True, exist_ok=True)

(home / "a.txt").write_text("a")

# An archive inside an archive, a folder named like one, and a rare method.
inner = io.BytesIO()
with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("docs/a.txt", "alpha")
with zipfile.ZipFile(home / "outer.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("in/b.zip", inner.getvalue())
    z.writestr("x.zip/y.txt", "why")
    z.writestr(zipfile.ZipInfo("bz.txt"), "squeezed " * 50, compress_type=zipfile.ZIP_BZIP2)

# A mail with one attachment.
(home / "mail.eml").write_bytes(
    b"From: Sam <sam@example.test>\r\nTo: Lee <lee@example.test>\r\nSubject: Check mail\r\n"
    b"Date: Sun, 15 Nov 2026 10:00:00 -0500\r\nMIME-Version: 1.0\r\n"
    b'Content-Type: multipart/mixed; boundary="cut"\r\n\r\n'
    b"--cut\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello there.\r\n"
    b'--cut\r\nContent-Type: text/plain; name="hello.txt"\r\nContent-Disposition: attachment; filename="hello.txt"\r\n'
    b"Content-Transfer-Encoding: base64\r\n\r\naGVsbG8gZnJvbSB0aGUgbWFpbA==\r\n--cut--\r\n"
)

# A song of 300 notes, half a second apart: two and a half minutes, so the roll asks in windows.
def varlen(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.insert(0, (n & 0x7F) | 0x80)
        n >>= 7
    return bytes(out)

track = b""
for i in range(300):
    key = 48 + (i * 7) % 36
    track += varlen(0 if i == 0 else 240) + bytes([0x90, key, 90]) + varlen(240) + bytes([0x80, key, 0])
track += b"\x00\xff\x2f\x00"
(home / "song.mid").write_bytes(b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480) + b"MTrk" + struct.pack(">I", len(track)) + track)

# A small picture.
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

rows = b"".join(b"\x00" + b"".join(bytes([x * 4, y * 4, 128]) for x in range(64)) for y in range(64))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
(home / "pic.png").write_bytes(png)

# Own templates: a folder that asks a name, and a plain file.
project = templates / "Project {name}"
project.mkdir(exist_ok=True)
(project / "{name} notes.txt").write_text("notes")
(templates / "plain.txt").write_text("plain")
print("ok")
