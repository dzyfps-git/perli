"""Fixtures for the PR A2 real-app check, made in the home folder given."""
import os
import shutil
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

home = Path(sys.argv[1])
here = Path(__file__).parent
home.mkdir(parents=True, exist_ok=True)
(home / "a.txt").write_text("a")
OLD = time.time() - 86400

# A mail with a text file and a mail attached.
inner = (
    b"From: Kim <kim@example.test>\r\nTo: Sam <sam@example.test>\r\nSubject: Inner mail\r\n"
    b"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe mail inside.\r\n"
)
(home / "mail.eml").write_bytes(
    b"From: Sam <sam@example.test>\r\nTo: Lee <lee@example.test>\r\nSubject: Check mail\r\n"
    b"Date: Sun, 15 Nov 2026 10:00:00 -0500\r\nMIME-Version: 1.0\r\n"
    b'Content-Type: multipart/mixed; boundary="cut"\r\n\r\n'
    b"--cut\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello there.\r\n"
    b'--cut\r\nContent-Type: text/plain; name="hello.txt"\r\nContent-Disposition: attachment; filename="hello.txt"\r\n'
    b"Content-Transfer-Encoding: base64\r\n\r\naGVsbG8gZnJvbSB0aGUgbWFpbA==\r\n"
    b'--cut\r\nContent-Type: message/rfc822; name="inner.eml"\r\nContent-Disposition: attachment; filename="inner.eml"\r\n\r\n'
    + inner
    + b"\r\n--cut--\r\n"
)

# Two folders to compare: same, only here, newer, alike in size and time but not in bytes,
# a folder that differs deep inside, and enough rows to scroll.
left, right = home / "left", home / "right"
for side in (left, right):
    (side / "deep" / "inner").mkdir(parents=True, exist_ok=True)
    (side / "same.txt").write_text("same")
    (side / "newer.txt").write_text("newer")
    for n in range(150):
        (side / f"zz-n{n:03}.txt").write_text(str(n))
(left / "only-left.txt").write_text("only")
(left / "twin.bin").write_bytes(b"AAAA")
(right / "twin.bin").write_bytes(b"BBBB")
(left / "deep" / "inner" / "x.txt").write_text("left side")
(right / "deep" / "inner" / "x.txt").write_text("right side, longer")
for path in [*left.rglob("*"), *right.rglob("*")]:
    os.utime(path, (OLD, OLD))
os.utime(left / "newer.txt", (OLD + 3600, OLD + 3600))

# A git repo: one file committed, one not.
repo = home / "repo"
repo.mkdir(exist_ok=True)
(repo / "kept.txt").write_text("kept\n")
(repo / "new.txt").write_text("new\n")
git = lambda *args: subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
git("init", "-q")
git("config", "user.email", "check@example.test")
git("config", "user.name", "Check")
git("add", "kept.txt")
git("commit", "-q", "-m", "first")

# Columns: a folder holding a folder and files.
cols = home / "cols"
(cols / "sub" / "deeper").mkdir(parents=True, exist_ok=True)
(cols / "f1.txt").write_text("first file in columns")
(cols / "f2.txt").write_text("second")
(cols / "sub" / "inner.txt").write_text("inner")

# Looks: a folder whose look goes inside, and folders under it.
(home / "looks" / "child" / "deep").mkdir(parents=True, exist_ok=True)
(home / "looks" / "other").mkdir(parents=True, exist_ok=True)

# Gallery: a tall and a wide video, and a big picture.
gal = home / "gal"
gal.mkdir(exist_ok=True)
# The videos are made by hand and kept out of the repo; without them only the gallery part misses them.
for name in ("tall.mp4", "wide.mp4"):
    if (here / "vid" / name).exists():
        shutil.copy(here / "vid" / name, gal / name)

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

W, H = 1600, 1200
row = lambda y: b"\x00" + bytes(v for x in range(W) for v in ((x * 255) // W, (y * 255) // H, ((x ^ y) & 255)))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(row(y) for y in range(H)), 1)) + chunk(b"IEND", b"")
(gal / "big.png").write_bytes(png)

# Two long texts, 5000 of 30000 lines changed.
lines = [f"line {i} of the long text" for i in range(30000)]
(home / "big-a.txt").write_text("\n".join(lines) + "\n")
(home / "big-b.txt").write_text("\n".join(l + " changed" if i % 6 == 0 else l for i, l in enumerate(lines)) + "\n")

# A PDF form of two pages: a text field, a check box, a link to page 2 and a web link.
def pdf(objects):
    out = b"%PDF-1.7\n"
    offsets = []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out

def stream(data, extra=b""):
    return b"<< /Length " + str(len(data)).encode() + extra + b" >>\nstream\n" + data + b"\nendstream"

page1 = b"BT /F1 20 Tf 72 720 Td (A form to fill) Tj ET BT /F1 12 Tf 72 640 Td (Name:) Tj ET BT /F1 12 Tf 72 490 Td (Go to page 2) Tj ET BT /F1 12 Tf 72 450 Td (Open the web site) Tj ET"
page2 = b"BT /F1 20 Tf 72 720 Td (Page two) Tj ET"
box = b" /Type /XObject /Subtype /Form /BBox [0 0 20 20]"
(home / "form.pdf").write_bytes(pdf([
    b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R /Resources << /Font << /F1 7 0 R >> >> /Annots [5 0 R 6 0 R 10 0 R 11 0 R] >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V () /Rect [120 630 400 655] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) /MK << /BG [0.95 0.95 1] >> >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Off /AS /Off /Rect [72 560 92 580] /F 4 /P 3 0 R /MK << /CA (4) >> /AP << /N << /Yes 12 0 R /Off 13 0 R >> >> >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(page1),
    stream(page2),
    b"<< /Type /Annot /Subtype /Link /Rect [70 485 200 505] /Border [0 0 0] /Dest [4 0 R /XYZ 0 792 null] >>",
    b"<< /Type /Annot /Subtype /Link /Rect [70 445 220 465] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>",
    stream(b"0 g 4 4 12 12 re f", box),
    stream(b"", box),
]))
print("ok")
