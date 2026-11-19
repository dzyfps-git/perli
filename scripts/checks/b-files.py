"""Fixtures for the PR B real-app check, made in the folder given."""
import os
import struct
import subprocess
import sys

home = sys.argv[1]
probe = sys.argv[2]


def put(rel, data, mode="w"):
    path = os.path.join(home, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode + ("b" if isinstance(data, bytes) else ""), **({} if isinstance(data, bytes) else {"encoding": "utf-8", "newline": "\n"})) as f:
        f.write(data)
    return path


# Diagrams
put("diagram.mmd", "flowchart LR\n  A[Start] --> B{Pick}\n  B -->|yes| C[Done]\n  B -->|no| A\n")
put("notes.md", "# Notes\n\nA diagram:\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n  Bob-->>Alice: Hello\n```\n\nA bad one:\n\n```mermaid\nflowchart LR\n  A --> B\n  B --> ((C\n```\n")

# Mail: HTML only, and an attachment name in RFC 2231 pieces
put("html.eml", "From: a@example.com\r\nTo: b@example.com\r\nSubject: Html mail\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
    "<html><body><h1 style=\"color:#c33\">Laid out</h1><table border=1><tr><td>cell one</td><td>cell two</td></tr></table>"
    "<script>document.title='ran'</script><p>Plain words here.</p></body></html>\r\n")
put("pieces.eml", "From: a@example.com\r\nTo: b@example.com\r\nSubject: Pieces\r\nMIME-Version: 1.0\r\n"
    "Content-Type: multipart/mixed; boundary=\"XX\"\r\n\r\n--XX\r\nContent-Type: text/plain\r\n\r\nSee the file.\r\n"
    "--XX\r\nContent-Type: text/plain\r\nContent-Disposition: attachment;\r\n filename*0*=UTF-8''r%C3%A9sum;\r\n filename*1*=%C3%A9%20long.txt\r\n\r\nhi\r\n--XX--\r\n")

# Texts: a long one to scroll, and another to change beside it
put("texts/long.txt", "".join(f"line {n}\n" for n in range(1, 3001)))
put("texts/other.txt", "first\n")

# Git: a file deep inside, committed
repo = os.path.join(home, "repo")
put("repo/sub/inner/deep.txt", "deep\n")
put("repo/top.txt", "top\n")
git = ["git", "-C", repo, "-c", "user.name=check", "-c", "user.email=check@example.com"]
subprocess.run(git[:3] + ["init", "-q"], check=True)
subprocess.run(git + ["add", "-A"], check=True)
subprocess.run(git + ["commit", "-q", "-m", "first"], check=True)


# MIDI: two tracks of 60,000 notes each
def varlen(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.insert(0, (n & 0x7F) | 0x80)
        n >>= 7
    return bytes(out)


def track(channel, notes):
    body = bytearray(varlen(0) + bytes([0xC0 | channel, channel * 8]))
    for i in range(notes):
        pitch = 40 + (i * 7 + channel * 5) % 40
        body += varlen(0) + bytes([0x90 | channel, pitch, 90]) + varlen(30) + bytes([0x80 | channel, pitch, 0])
    body += varlen(0) + b"\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(body)) + bytes(body)


put("song.mid", b"MThd" + struct.pack(">IHHH", 6, 1, 2, 480) + track(0, 60000) + track(1, 60000))

# Compare: the same tree twice, same times, so only a deep edit tells them apart
for side in ("left", "right"):
    for rel, text in (("top.txt", "top\n"), ("deep/sub/f.txt", "same\n")):
        path = put(f"cmp/{side}/{rel}", text)
        os.utime(path, (1_700_000_000, 1_700_000_000))

# Copies: a pair of small ones, a pair of big ones
for name in ("a1.bin", "a2.bin"):
    put(f"copies/{name}", b"A" * 10_000)
for name in ("b1.bin", "b2.bin"):
    put(f"copies/{name}", b"B" * 100_000)

# The index probe: a name nothing else has
put(f"probe/{probe}.txt", "probe\n")
print("files ready")
