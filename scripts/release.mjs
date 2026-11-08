// Builds a signed installer and publishes it to the public releases repo, where installed
// copies of Perli look for updates. Run from a clean `main`: `npm run release -- "notes"`.
// `--dry-run` builds and writes latest.json without publishing anything.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASES_REPO = "dzyfps-git/perli-releases";

/** The file the updater reads. Its URL must match the asset `gh release create` uploads. */
export function manifest({ version, notes, signature, date = new Date() }) {
  return {
    version,
    notes,
    pub_date: date.toISOString(),
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${installerName(version)}`,
      },
    },
  };
}

export const installerName = (version) => `Perli_${version}_x64-setup.exe`;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const notes = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "";

  if (!dryRun) {
    if (run("git", ["status", "--porcelain"])) throw new Error("Commit or stash your changes first.");
    if (run("git", ["branch", "--show-current"]) !== "main") throw new Error("Releases come from main.");
  }

  const { version } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const keyPath = join(homedir(), ".tauri", "perli.key");
  if (!existsSync(keyPath)) throw new Error(`The signing key is missing: ${keyPath}`);
  const tag = `v${version}`;
  if (!dryRun && run("gh", ["release", "list", "--repo", RELEASES_REPO, "--json", "tagName", "--jq", ".[].tagName"])
    .split("\n")
    .includes(tag)) {
    throw new Error(`${tag} is already published. Raise the version in src-tauri/tauri.conf.json.`);
  }

  // npm is a .cmd file, which only a shell can start.
  execSync("npm run tauri build -- --config src-tauri/tauri.release.json", {
    stdio: "inherit",
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    },
  });

  const metadata = JSON.parse(
    run("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", "src-tauri/Cargo.toml"], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const bundle = join(metadata.target_directory, "release", "bundle", "nsis");
  const installer = join(bundle, installerName(version));
  const signature = readFileSync(`${installer}.sig`, "utf8").trim();
  const latest = join(bundle, "latest.json");
  writeFileSync(latest, JSON.stringify(manifest({ version, notes, signature }), null, 2));
  console.log(`Built ${installer}\nWrote ${latest}`);
  if (dryRun) return;

  execFileSync(
    "gh",
    ["release", "create", tag, "--repo", RELEASES_REPO, "--title", `Perli ${version}`, "--notes", notes || `Perli ${version}`,
      installer, `${installer}.sig`, latest],
    { stdio: "inherit" },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
