"""Starts a local SeaweedFS S3 server on 127.0.0.1:8333 for the s3 and note parts of check c, with
a test key of its own made on the first run. Runs until stopped.

Get windows_amd64.zip from the SeaweedFS releases on GitHub (seaweedfs/seaweedfs) and put weed.exe
in seaweed/bin/ beside this file, or point WEED at it.
"""
import json
import os
import pathlib
import secrets
import subprocess

here = pathlib.Path(__file__).parent
run = here / "seaweed-run"
(run / "data").mkdir(parents=True, exist_ok=True)
key = run / "key.json"
if not key.exists():
    pair = {"keyId": "PERLITEST" + secrets.token_hex(4).upper(), "secret": secrets.token_urlsafe(30)}
    key.write_text(json.dumps(pair), encoding="utf-8")
    access = {"accessKey": pair["keyId"], "secretKey": pair["secret"]}
    identity = {"name": "perli-check", "credentials": [access], "actions": ["Admin", "Read", "Write", "List", "Tagging"]}
    (run / "s3.json").write_text(json.dumps({"identities": [identity]}), encoding="utf-8")

weed = os.environ.get("WEED", str(here / "seaweed" / "bin" / "weed.exe"))
subprocess.run(
    [
        weed, "server", "-ip=127.0.0.1", "-ip.bind=127.0.0.1", f"-dir={run / 'data'}",
        # The default 30 GB volumes leave a small disk with "No writable volumes".
        "-master.port=9333", "-master.volumeSizeLimitMB=256", "-volume.port=8080", "-volume.max=40",
        "-filer", "-filer.port=8888", "-s3", "-s3.port=8333", f"-s3.config={run / 's3.json'}",
    ],
    check=False,
)
