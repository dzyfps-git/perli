//! File names: which are legal and how to pick a free one.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::sys;

const BAD_CHARACTERS: &str = "<>:\"/\\|?*";
const LONGEST_NAME: usize = 255;
const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];

/// Explains why Windows would refuse `name`, or would make it unreachable by normal paths.
pub fn check(name: &str) -> Result<(), &'static str> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("Type a name.");
    }
    if name.chars().any(|c| BAD_CHARACTERS.contains(c) || c < ' ') {
        return Err("A name can't contain < > : \" / \\ | ? *");
    }
    if name.ends_with(['.', ' ']) {
        return Err("A name can't end with a dot or a space.");
    }
    if name.encode_utf16().count() > LONGEST_NAME {
        return Err("That name is too long.");
    }
    if is_reserved(name) {
        return Err("Windows keeps that name for itself.");
    }
    Ok(())
}

/// Explains why `path` can't take `name`. Changing only the case of a name is fine.
pub fn check_rename(path: &Path, name: &str) -> Result<(), &'static str> {
    check(name)?;
    let target = path.with_file_name(name);
    match sys::stat(&target) {
        Ok(Some(_)) if !sys::same_file(path, &target).unwrap_or(false) => {
            Err("That name is already taken.")
        }
        _ => Ok(()),
    }
}

/// Windows keeps device names even when they have an extension.
fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end().to_uppercase();
    let numbered = |word: &str| {
        stem.strip_prefix(word).is_some_and(|rest| {
            matches!(rest, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        })
    };
    RESERVED.contains(&stem.as_str()) || numbered("COM") || numbered("LPT")
}

/// Splits off the extension. A folder's name is all stem.
fn split(name: &OsStr, is_dir: bool) -> (OsString, OsString) {
    let path = Path::new(name);
    match path.extension().filter(|_| !is_dir) {
        Some(extension) => {
            let mut dotted = OsString::from(".");
            dotted.push(extension);
            (path.file_stem().unwrap_or(name).to_os_string(), dotted)
        }
        None => (name.to_os_string(), OsString::new()),
    }
}

/// A name that can't be checked counts as free, because the write that follows reports why.
fn is_free(path: &Path) -> bool {
    !matches!(sys::stat(path), Ok(Some(_)))
}

/// `stem` plus `extension` if free, else with the lowest free number from 2 up.
fn free_name(folder: &Path, stem: &OsStr, extension: &OsStr) -> PathBuf {
    let mut number = 1;
    loop {
        let mut name = stem.to_os_string();
        if number > 1 {
            name.push(format!(" ({number})"));
        }
        name.push(extension);
        let path = folder.join(name);
        if is_free(&path) {
            return path;
        }
        number += 1;
    }
}

/// A free name for keeping both: "name (2).txt".
pub fn keep_both(folder: &Path, name: &OsStr, is_dir: bool) -> PathBuf {
    let (stem, extension) = split(name, is_dir);
    free_name(folder, &stem, &extension)
}

/// A free name for a copy in the same folder: "name - Copy.txt".
pub fn copy_of(folder: &Path, name: &OsStr, is_dir: bool) -> PathBuf {
    let (mut stem, extension) = split(name, is_dir);
    stem.push(" - Copy");
    free_name(folder, &stem, &extension)
}

/// A free name for a new, empty item.
pub fn new_item(folder: &Path, directory: bool) -> PathBuf {
    if directory {
        free_name(folder, OsStr::new("New folder"), OsStr::new(""))
    } else {
        free_name(folder, OsStr::new("New file"), OsStr::new(".txt"))
    }
}
