"""Fixtures for the Office phase's real-app check: documents made from Office's own templates,
one marked as from the internet, one under a password, an RTF and a damaged document."""
import os
import pathlib
import shutil
import subprocess
import sys
import zipfile

home = pathlib.Path(sys.argv[1])
office = home / "office"
office.mkdir(parents=True, exist_ok=True)
templates = pathlib.Path(r"C:\Program Files\Microsoft Office\root\Templates\1033")
repo = pathlib.Path(__file__).resolve().parents[2]

# A template saved as a plain document: only its content type says "template".
TYPES = {
    b"wordprocessingml.template.main+xml": b"wordprocessingml.document.main+xml",
    b"spreadsheetml.template.main+xml": b"spreadsheetml.sheet.main+xml",
    b"presentationml.template.main+xml": b"presentationml.presentation.main+xml",
}


def as_document(template, target):
    with zipfile.ZipFile(templates / template) as source, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "[Content_Types].xml":
                for old, new in TYPES.items():
                    data = data.replace(old, new)
            out.writestr(item.filename, data)
    return target


as_document("EssentialReport.dotx", office / "report.docx")
as_document("LoanAmortization.xltx", office / "budget.xlsx")
as_document("Training.potx", office / "deck.pptx")
as_document("StudentReport.dotx", office / "second.docx")

# The same report, downloaded: the mark of the web says it came from the internet.
shutil.copy(office / "report.docx", office / "download.docx")
with open(str(office / "download.docx") + ":Zone.Identifier", "w", newline="") as mark:
    mark.write("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.invalid/report.docx\r\n")

# The report under the password "kiwi", locked the way Office 2010 and later lock files.
env = {**os.environ, "PERLI_LOCKED_IN": str(office / "report.docx"), "PERLI_LOCKED_OUT": str(office / "locked.docx")}
subprocess.run(
    ["cargo", "test", "--quiet", "writes_a_locked_sample", "--", "--ignored"],
    cwd=repo / "src-tauri",
    env=env,
    check=True,
    stdout=subprocess.DEVNULL,
)

(office / "notes.rtf").write_text(r"{\rtf1\ansi{\fonttbl\f0 Segoe UI;}\f0\fs28 Perli check: an \b RTF\b0 note.\par}")
# Not a document at all, under a document's name.
(office / "broken.docx").write_bytes(b"PK\x03\x04" + os.urandom(3000))
