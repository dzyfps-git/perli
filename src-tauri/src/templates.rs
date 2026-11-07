//! The file types Windows offers under New, read from the `ShellNew` registry keys.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use windows::core::{GUID, HSTRING};
use windows::Win32::System::Registry::{
    HKEY_CLASSES_ROOT, REG_ROUTINE_FLAGS, RRF_RT_ANY, RRF_RT_REG_BINARY,
};
use windows::Win32::UI::Shell::{FOLDERID_CommonTemplates, FOLDERID_Templates, SHLoadIndirectString};

use crate::ops::{Content, Template};
use crate::{places, registry, session, shell};

/// Longest text a `ShellNew` item name resolves to.
const LONGEST_TEXT: usize = 512;
/// Offered even on a PC whose Windows lists no such type. Its own template wins if it has one.
const TEXT_EXTENSION: &str = "txt";
const TEXT_NAME: &str = "Text Document";
const OWN_FOLDER: &str = "templates";

/// A type for the New menu.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NewType {
    /// Without the dot.
    extension: String,
    name: String,
}

fn exists(key: &str) -> bool {
    registry::exists(HKEY_CLASSES_ROOT, key)
}

fn read_value(key: &str, name: Option<&str>, kinds: REG_ROUTINE_FLAGS) -> Option<Vec<u8>> {
    registry::read_value(HKEY_CLASSES_ROOT, key, name, kinds)
}

fn read_text(key: &str, name: Option<&str>) -> Option<String> {
    registry::read_text(HKEY_CLASSES_ROOT, key, name)
}

fn has_value(key: &str, name: &str) -> bool {
    read_value(key, Some(name), RRF_RT_ANY).is_some()
}

/// A type's `ShellNew` key sits under its extension, or under the extension's class.
fn shell_new_key(extension: &str) -> Option<String> {
    let direct = format!(r"{extension}\ShellNew");
    if exists(&direct) {
        return Some(direct);
    }
    let class = read_text(extension, None)?;
    let nested = format!(r"{extension}\{class}\ShellNew");
    exists(&nested).then_some(nested)
}

/// The file `FileName` means: a full path, or one kept in a templates folder.
fn find_template(name: &str) -> Option<PathBuf> {
    if Path::new(name).is_absolute() {
        return Path::new(name).is_file().then(|| name.into());
    }
    let known = |id: &GUID| places::known_folder(id).map(PathBuf::from);
    let windows_folder = std::env::var_os("WINDIR").map(|folder| PathBuf::from(folder).join("ShellNew"));
    [known(&FOLDERID_Templates), known(&FOLDERID_CommonTemplates), windows_folder]
        .into_iter()
        .flatten()
        .map(|folder| folder.join(name))
        .find(|file| file.is_file())
}

/// `Command` and `Handler` types run a program or a wizard, which a plain new file can't stand
/// in for, even if the key also says `NullFile`, as the shortcut type does.
fn content_of(key: &str) -> Option<Content> {
    if has_value(key, "Command") || has_value(key, "Handler") {
        return None;
    }
    if has_value(key, "NullFile") {
        return Some(Content::Empty);
    }
    if let Some(bytes) = read_value(key, Some("Data"), RRF_RT_REG_BINARY) {
        return Some(Content::Bytes(bytes));
    }
    if let Some(text) = read_text(key, Some("Data")) {
        return Some(Content::Bytes(text.into_bytes()));
    }
    find_template(&read_text(key, Some("FileName"))?).map(Content::Copy)
}

/// `ItemName` is often a reference into a program's resources.
fn item_name(key: &str) -> Option<String> {
    let name = read_text(key, Some("ItemName"))?;
    if !name.starts_with('@') {
        return Some(name);
    }
    let mut text = [0u16; LONGEST_TEXT];
    unsafe { SHLoadIndirectString(&HSTRING::from(name), &mut text, None) }.ok()?;
    let length = text.iter().position(|&unit| unit == 0)?;
    (length > 0).then(|| String::from_utf16_lossy(&text[..length]))
}

/// Every extension key, each with its dot.
fn extensions() -> Vec<String> {
    let mut found = registry::subkeys(HKEY_CLASSES_ROOT, "");
    found.retain(|name| name.starts_with('.'));
    found
}

fn read_types() -> Vec<NewType> {
    let with_key = extensions().into_iter().filter_map(|extension| {
        let key = shell_new_key(&extension)?;
        content_of(&key)?;
        extension.strip_prefix('.').map(str::to_string)
    });
    let extensions: Vec<String> = with_key.collect();
    let names = shell::type_names(extensions).unwrap_or_default();
    let mut types: Vec<NewType> = names
        .into_iter()
        .map(|(extension, name)| NewType { extension, name })
        .collect();
    if !types.iter().any(|kind| kind.extension == TEXT_EXTENSION) {
        types.push(NewType { extension: TEXT_EXTENSION.into(), name: TEXT_NAME.into() });
    }
    types.sort_by_key(|kind| kind.name.to_lowercase());
    types
}

/// The types Windows offers. Blocks, so call it off the main thread. The first read walks the
/// whole registry, and the list only changes when an app is installed.
pub fn new_types() -> Vec<NewType> {
    static TYPES: OnceLock<Vec<NewType>> = OnceLock::new();
    TYPES.get_or_init(read_types).clone()
}

/// What a new file of `extension` should be named and hold.
pub fn template(extension: &str) -> Result<Template, String> {
    let dotted = format!(".{extension}");
    let found = shell_new_key(&dotted).and_then(|key| content_of(&key).map(|content| (key, content)));
    let Some((key, content)) = found else {
        if extension != TEXT_EXTENSION {
            return Err(format!("Windows has no template for {dotted} files"));
        }
        let stem = format!("New {TEXT_NAME}");
        return Ok(Template { stem, extension: dotted, content: Content::Empty });
    };
    let stem = item_name(&key).unwrap_or_else(|| {
        let names = shell::type_names(vec![extension.to_string()]).unwrap_or_default();
        let name = names.get(extension).map_or(extension, String::as_str);
        format!("New {name}")
    });
    Ok(Template { stem, extension: dotted, content })
}

/// Where the user keeps files to start new ones from. Made here, so it can always be opened.
pub fn own_folder() -> Result<PathBuf, String> {
    let folder = session::data_file(OWN_FOLDER).ok_or("Windows gave no folder for app data")?;
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    Ok(folder)
}

/// The names of the user's own templates, A to Z.
pub fn own_names() -> Vec<String> {
    let Some(entries) = session::data_file(OWN_FOLDER).and_then(|folder| fs::read_dir(folder).ok()) else {
        return Vec::new();
    };
    let files = entries.flatten().filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()));
    let mut names: Vec<String> = files.filter_map(|entry| entry.file_name().into_string().ok()).collect();
    names.sort_by_key(|name| name.to_lowercase());
    names
}

fn own_from(folder: &Path, name: &str) -> Result<Template, String> {
    let only_a_name = Path::new(name).file_name() == Some(OsStr::new(name));
    let file = folder.join(name);
    if !only_a_name || !file.is_file() {
        return Err(format!("There is no template called {name}"));
    }
    let stem = file.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let extension = file.extension().map_or(String::new(), |extension| format!(".{}", extension.to_string_lossy()));
    Ok(Template { stem, extension, content: Content::Copy(file) })
}

/// A new file that starts as a copy of the user's template `name`.
pub fn own_template(name: &str) -> Result<Template, String> {
    own_from(&own_folder()?, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegDeleteTreeW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_BINARY, REG_SZ,
    };

    /// A made-up type in the user's own classes, which Windows adds to `HKEY_CLASSES_ROOT`.
    /// What a real PC offers varies: some have no text template at all.
    struct ScratchType(String);

    impl ScratchType {
        fn new(name: &str) -> Self {
            Self(format!("perli-test-{name}-{}", std::process::id()))
        }

        fn set(&self, below: &str, name: Option<&str>, kind: u32, bytes: &[u8]) {
            let key = HSTRING::from(format!(r"Software\Classes\.{}{below}", self.0));
            let name = HSTRING::from(name.unwrap_or_default());
            let data = Some(bytes.as_ptr().cast());
            let set = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, &key, &name, kind, data, bytes.len() as u32) };
            assert_eq!(set, ERROR_SUCCESS);
        }

        fn set_text(&self, below: &str, name: Option<&str>, text: &str) {
            let bytes: Vec<u8> = text.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
            self.set(below, name, REG_SZ.0, &bytes);
        }
    }

    impl Drop for ScratchType {
        fn drop(&mut self) {
            let key = HSTRING::from(format!(r"Software\Classes\.{}", self.0));
            let _ = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &key) };
        }
    }

    #[test]
    fn a_type_starts_empty_under_its_own_name() {
        let scratch = ScratchType::new("empty");
        scratch.set_text(r"\ShellNew", Some("NullFile"), "");
        scratch.set_text(r"\ShellNew", Some("ItemName"), "Blank Note");

        let template = template(&scratch.0).unwrap();
        assert_eq!(template.stem, "Blank Note");
        assert_eq!(template.extension, format!(".{}", scratch.0));
        assert_eq!(template.content, Content::Empty);
    }

    #[test]
    fn a_type_under_its_class_starts_from_bytes() {
        let scratch = ScratchType::new("bytes");
        scratch.set_text("", None, "PerliClass");
        scratch.set(r"\PerliClass\ShellNew", Some("Data"), REG_BINARY.0, &[1, 2, 3]);

        let template = template(&scratch.0).unwrap();
        assert!(template.stem.starts_with("New "), "{}", template.stem);
        assert_eq!(template.content, Content::Bytes(vec![1, 2, 3]));
    }

    #[test]
    fn a_type_copies_its_blank_file_and_goes_when_that_is_missing() {
        let blank = std::env::temp_dir().join(format!("perli-blank-{}.bin", std::process::id()));
        std::fs::write(&blank, "blank").unwrap();
        let scratch = ScratchType::new("copy");
        scratch.set_text(r"\ShellNew", Some("FileName"), blank.to_str().unwrap());

        assert_eq!(template(&scratch.0).unwrap().content, Content::Copy(blank.clone()));

        std::fs::remove_file(&blank).unwrap();
        assert!(template(&scratch.0).is_err());
    }

    #[test]
    fn a_type_that_runs_a_program_is_not_offered() {
        let scratch = ScratchType::new("wizard");
        scratch.set_text(r"\ShellNew", Some("NullFile"), "");
        scratch.set_text(r"\ShellNew", Some("Command"), "wizard.exe");
        let plain = ScratchType::new("plain");
        plain.set_text(r"\ShellNew", Some("NullFile"), "");

        assert!(template(&scratch.0).is_err());
        let types = read_types();
        assert!(types.iter().any(|kind| kind.extension == plain.0), "{types:?}");
        assert!(!types.iter().any(|kind| kind.extension == scratch.0), "{types:?}");
        assert!(!types.iter().any(|kind| kind.extension == "lnk"), "{types:?}");
    }

    #[test]
    fn a_text_document_is_always_offered() {
        assert!(read_types().iter().any(|kind| kind.extension == TEXT_EXTENSION));
        assert_eq!(template(TEXT_EXTENSION).unwrap().extension, ".txt");
    }

    #[test]
    fn an_own_template_starts_from_its_file_and_stays_in_its_folder() {
        let folder = std::env::temp_dir().join(format!("perli-own-templates-{}", std::process::id()));
        fs::create_dir_all(folder.join("inner")).unwrap();
        fs::write(folder.join("Letter.final.docx"), "letter").unwrap();
        fs::write(folder.join("Notes"), "notes").unwrap();

        let letter = own_from(&folder, "Letter.final.docx").unwrap();
        assert_eq!((letter.stem.as_str(), letter.extension.as_str()), ("Letter.final", ".docx"));
        assert_eq!(letter.content, Content::Copy(folder.join("Letter.final.docx")));
        assert_eq!(own_from(&folder, "Notes").unwrap().extension, "");
        assert!(own_from(&folder, r"inner\..\Notes").is_err());
        assert!(own_from(&folder, "inner").is_err());
        assert!(own_from(&folder, "gone.txt").is_err());

        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn an_unknown_type_has_no_template() {
        assert!(template("perli-not-a-type").is_err());
    }
}
