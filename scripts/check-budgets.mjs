// Fails when the NSIS installer is over budget. Run after `npm run tauri build`.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const budgets = JSON.parse(readFileSync("budgets.json", "utf8"));
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml"],
    { encoding: "utf8" },
  ),
);

const nsisDir = join(metadata.target_directory, "release", "bundle", "nsis");
const installer = readdirSync(nsisDir).find((name) => name.endsWith(".exe"));
if (!installer) throw new Error(`No installer found in ${nsisDir}`);

const sizeMB = statSync(join(nsisDir, installer)).size / 1024 / 1024;
console.log(`Installer: ${sizeMB.toFixed(2)} MB (budget ${budgets.installerMB} MB)`);
if (sizeMB > budgets.installerMB) {
  console.error("OVER BUDGET: installer size");
  process.exit(1);
}
