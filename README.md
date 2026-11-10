# Perli

A modern, lightweight file explorer for Windows, built with Tauri, Rust and Solid.

Priorities, in order: safety, features, speed.

## Third-party code

The code that sends special places back to File Explorer and answers "Show in folder"
(`src-tauri/src/explorer.rs`) is ported from the launcher of [Files](https://github.com/files-community/Files),
Copyright (c) Files Community, under the MIT License. The full notice is at the top of that file.
