# Real-app checks

These start the release build of Perli and drive it the way a person would, then print `ok` or `FAIL` for each step. They talk to the app over CDP and page events only, so they never move your real mouse or press your real keys. Each run gets its own LOCALAPPDATA, TEMP and user name, so your own Perli settings are left alone. The window opens on the second monitor (x -1700).

## Run

1. Build first: `npx tauri build --no-bundle`. The checks find `perli.exe` through `cargo metadata`; set `PERLI_EXE` to use another one.
2. Run a set: `node scripts/checks/run.mjs c`. To run some parts only, set `ONLY`, for example `ONLY=s3,note`.

Screenshots go to `shots-<set>/` here. Nothing else stays behind.

## Sets

| Set | PR | Parts |
| --- | --- | --- |
| `a1-check.mjs` | A1 (#59) | Its own older harness: run it with `node scripts/checks/a1-check.mjs`. Parts: nested archives, method column, archive cache, mail, tags, templates, midi, picture switches |
| `a2` | A2 (#60) | mail, compare, git, gallery, columns, keep plain, pdf, diff, windows |
| `b` | B (#61) | mermaid, mail, midi, reload, git, compare, copies, index. The index part walks every drive, which takes several minutes. |
| `c` | C (#62) | cloud-sheet, sync, s3, note, pdf-scripts |
| `s` | 9A-9C (#63-#65) | open, hover, lenses, into, find, picture, pulse, tags, home, river, twins, alike, colour, fingerprint, age, stream, threads, bridge. The picture goes to the run's own folder, not your Pictures. |
| `t` | 10A, 10B (#66, #67) | tags-many, river-hidden, twins-places, home-tide, fingerprint-theme, diagram-theme, threads-stacked, stream-deep, sync-change (about 5 minutes), s3-batch (SeaweedFS), index-space (walks every drive, several minutes). |

Each set's fixtures come from `<set>-files.py`. `helpers.js` is loaded into the page for clicks, typing and reading rows.

## S3 parts

The `s3` and `note` parts need a local SeaweedFS server, and they are skipped when it isn't running.

1. Download `windows_amd64.zip` from the SeaweedFS releases on GitHub (seaweedfs/seaweedfs) and put `weed.exe` in `scripts/checks/seaweed/bin/`, or set `WEED` to where it is.
2. Start it with `python scripts/checks/seaweed.py` and leave it running. The first start makes a test key in `seaweed-run/`.

Each run starts on an empty `perli-test` bucket, and it removes the places it added, so no keys stay in Credential Manager.

## Tips

- Close a quick preview with Space. Escape is the native dialog cancel, which a key sent by a script doesn't trigger.
- Undo is a list-only key: focus the list (`P.grid().focus()`) before Ctrl+Z.
- Don't reload the page in a check. Old view ids then say "This folder is no longer open".
- Don't name a variable `key`: that hides the `key()` helper.
