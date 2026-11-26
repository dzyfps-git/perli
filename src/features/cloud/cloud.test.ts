import assert from "node:assert/strict";
import test from "node:test";
import { isPerliCloud, isPlaceRoot, placeName, s3Missing, s3Setup, S3_PRESETS, serverMissing, serverName, serverSetup } from "./cloud.ts";

const preset = (id: string) => S3_PRESETS.find((one) => one.id === id)!;
const fields = { value: "", endpoint: "", bucket: " photos ", keyId: "KEY", pathStyle: false };

test("cloud paths are told from others and name their place", () => {
  assert.equal(isPerliCloud("\\\\Perli Cloud"), true);
  assert.equal(isPerliCloud("\\\\perli cloud\\Work\\a"), true);
  assert.equal(isPerliCloud("\\\\Perli Cloudy\\a"), false);
  assert.equal(isPerliCloud("C:\\Perli Cloud"), false);
  assert.equal(placeName("\\\\Perli Cloud\\Work\\a\\b"), "Work");
  assert.equal(placeName("\\\\Perli Cloud\\"), undefined);
  assert.equal(isPlaceRoot("\\\\Perli Cloud\\Work"), true);
  assert.equal(isPlaceRoot("\\\\Perli Cloud\\Work\\a"), false);
  assert.equal(isPlaceRoot("\\\\Perli Cloud"), false);
});

test("an S3 form makes the address each service wants", () => {
  assert.equal(s3Setup(preset("aws"), { ...fields, value: "eu-west-1" }).endpoint, "https://s3.eu-west-1.amazonaws.com");
  assert.equal(s3Setup(preset("aws"), fields).region, "us-east-1");
  const r2 = s3Setup(preset("r2"), { ...fields, value: "abc123" });
  assert.deepEqual([r2.endpoint, r2.region, r2.bucket], ["https://abc123.r2.cloudflarestorage.com", "auto", "photos"]);
  const minio = s3Setup(preset("minio"), { ...fields, endpoint: "http://localhost:9000/" });
  assert.deepEqual([minio.endpoint, minio.pathStyle], ["http://localhost:9000", true]);
  assert.equal(s3Setup(preset("custom"), { ...fields, endpoint: "s3.example.com" }).endpoint, "https://s3.example.com");
  assert.equal(s3Missing(preset("r2"), fields, "secret"), "Type the Account ID");
  assert.equal(s3Missing(preset("aws"), fields, ""), "Type the access key and its secret");
  assert.equal(s3Missing(preset("aws"), fields, "secret"), undefined);
});

test("a server sheet's fields become the setup the server is tried with", () => {
  const fields = { host: " nas.local ", port: "", user: " me ", folder: "\\srv\\files", keyFile: '"C:\\keys\\id_ed25519"' };
  assert.equal(serverMissing("sftp", { ...fields, host: " " }), "Type the server's name or address");
  assert.equal(serverMissing("sftp", { ...fields, port: "70000" }), "A port is a number from 1 to 65535");
  assert.equal(serverMissing("sftp", { ...fields, port: "2222" }), undefined);
  const sftp = serverSetup("sftp", fields, "SHA256:abc");
  assert.equal(sftp.kind, "sftp");
  assert.deepEqual(sftp.server, { host: "nas.local", port: 0, user: "me", folder: "/srv/files", secure: false, keyFile: "C:\\keys\\id_ed25519", hostKey: "SHA256:abc" });
  const ftps = serverSetup("ftps", fields, "SHA256:abc");
  assert.equal(ftps.kind, "ftp");
  assert.equal(ftps.server.secure, true);
  assert.equal(ftps.server.keyFile, "", "a key file is for SFTP only");
  assert.equal(ftps.server.hostKey, "");
  assert.equal(serverSetup("webDav", fields).server.folder, "", "WebDAV's folder is in its address");
  assert.equal(serverName("https://cloud.example.com/remote.php/dav"), "cloud.example.com");
  assert.equal(serverName("nas.local:2222"), "nas.local");
});
