"""Fixtures for PR C's real-app check: a PDF whose total adds itself up, and two folders to sync."""
import pathlib
import sys

home = pathlib.Path(sys.argv[1])


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


def field(name, rect, extra=b""):
    return b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (" + name + b") /Rect [" + rect + b"] /F 4 /P 3 0 R /DA (/Helv 14 Tf 0 g) /MK << /BC [0 0 0] >>" + extra + b" >>"


page = b"BT /F1 14 Tf 40 250 Td (A) Tj ET BT /F1 14 Tf 40 200 Td (B) Tj ET BT /F1 14 Tf 40 150 Td (Total) Tj ET"
total = b'event.value = Number(this.getField("A").value) + Number(this.getField("B").value);'.replace(b"(", b"\\(").replace(b")", b"\\)")
(home / "calc.pdf").write_bytes(pdf([
    b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R] /CO [6 0 R] /DA (/Helv 14 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 8 0 R /Resources << /Font << /F1 7 0 R /Helv 7 0 R >> >> /Annots [4 0 R 5 0 R 6 0 R] >>",
    field(b"A", b"100 240 250 265", b" /AA << /K 10 0 R >>"),
    field(b"B", b"100 190 250 215", b" /AA << /K 10 0 R >>"),
    field(b"Total", b"100 140 250 165", b" /Ff 1 /AA << /C 9 0 R >>"),
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    b"<< /Length " + str(len(page)).encode() + b" >>\nstream\n" + page + b"\nendstream",
    b"<< /S /JavaScript /JS (" + total + b") >>",
    b"<< /S /JavaScript /JS (event.rc = true;) >>",
]))

source, target = home / "sync-from", home / "sync-to"
for folder in (source / "sub", target / "sub"):
    folder.mkdir(parents=True, exist_ok=True)
(source / "a.txt").write_text("new file")
(source / "sub" / "b.txt").write_text("the newer, longer b")
(source / "skip.tmp").write_text("left out")
(target / "sub" / "b.txt").write_text("old b")
(target / "old.txt").write_text("only in the target")
print("c fixtures made")
