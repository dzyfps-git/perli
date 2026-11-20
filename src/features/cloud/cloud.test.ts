import assert from "node:assert/strict";
import test from "node:test";
import { isPerliCloud, isPlaceRoot, placeName, s3Missing, s3Setup, S3_PRESETS } from "./cloud.ts";

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
