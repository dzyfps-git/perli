// Runs one set of real-app checks: `node scripts/checks/run.mjs c`, with ONLY=part,part in the
// environment to run some parts. It puts harness.mjs in front of the set's parts and runs that.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const set = process.argv[2];
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const built = new URL(`./${set}.built.mjs`, import.meta.url);
writeFileSync(built, `${read("./harness.mjs")}\n${read(`./${set}.mjs`)}`);
process.exitCode = spawnSync(process.execPath, [fileURLToPath(built)], { stdio: "inherit" }).status ?? 1;
