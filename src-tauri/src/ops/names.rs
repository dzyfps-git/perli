//! File names: which are legal and how to pick a free one.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::ERROR_FILE_EXISTS;

use super::sys;

const BAD_CHARACTERS: &str = "<>:\"/\\|?*";
const LONGEST_NAME: usize = 255;
/// A name that can't be read can look free forever, so asking again has to end.
const CLAIM_TRIES: usize = 100;
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

/// True when `name` is what `path` is called already. Names reach the UI lossy, so that is how
/// they compare, and an odd name the user did not touch stays as it is.
pub fn unchanged(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|own| own.to_string_lossy() == name)
}

/// Explains why each item can't take its new name, if it can't. A name counts as free if another
/// item in the list is leaving it.
pub fn check_renames(renames: &[(PathBuf, String)]) -> Vec<Option<&'static str>> {
    let key = |path: &Path| path.to_string_lossy().to_lowercase();
    let mut wanted: HashMap<String, usize> = HashMap::new();
    let mut leaving = HashSet::new();
    for (path, name) in renames {
        *wanted.entry(key(&path.with_file_name(name))).or_default() += 1;
        if !unchanged(path, name) {
            leaving.insert(key(path));
        }
    }
    let problem = |(path, name): &(PathBuf, String)| {
        if unchanged(path, name) {
            return None;
        }
        if let Err(problem) = check(name) {
            return Some(problem);
        }
        let target = path.with_file_name(name);
        if wanted[&key(&target)] > 1 {
            return Some("Another item would get the same name.");
        }
        let taken = matches!(sys::stat(&target), Ok(Some(_)))
            && !leaving.contains(&key(&target))
            && !sys::same_file(path, &target).unwrap_or(false);
        taken.then_some("That name is already taken.")
    };
    renames.iter().map(problem).collect()
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

/// Makes an empty file at the name `free` gives, asking again if another job got there first.
/// Finding a name and writing to it are two steps, and this holds the name between them.
pub fn claim(mut free: impl FnMut() -> PathBuf) -> windows::core::Result<PathBuf> {
    for _ in 1..CLAIM_TRIES {
        let target = free();
        match sys::create_file(&target) {
            Err(error) if error.code() == ERROR_FILE_EXISTS.to_hresult() => {}
            created => return created.map(|()| target),
        }
    }
    let target = free();
    sys::create_file(&target).map(|()| target)
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

/// A free name for a new file of a known type.
pub fn free(folder: &Path, stem: &str, extension: &str) -> PathBuf {
    free_name(folder, OsStr::new(stem), OsStr::new(extension))
}

/// A free name for a new folder called `name`, or "New folder" if Windows would refuse that.
pub fn new_folder(folder: &Path, name: Option<&str>) -> PathBuf {
    match name.filter(|name| check(name).is_ok()) {
        Some(name) => free(folder, name, ""),
        None => new_item(folder, true),
    }
}

/// A free name for a new, empty item.
pub fn new_item(folder: &Path, directory: bool) -> PathBuf {
    if directory {
        free_name(folder, OsStr::new("New folder"), OsStr::new(""))
    } else {
        free_name(folder, OsStr::new("New file"), OsStr::new(".txt"))
    }
}
