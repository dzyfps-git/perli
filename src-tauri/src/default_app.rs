//! Lets Perli open folders in place of File Explorer, and puts everything back.
//!
//! Windows has no setting for this, so it rests on per-user registry values, which win over the
//! machine's own. Nothing outside `HKEY_CURRENT_USER` is ever written. `Folder\shell` stays alone,
//! because it also catches This PC, Control Panel and the Recycle Bin, which have no path to open.

use std::cmp::Reverse;

use windows::core::Result;
use windows::Win32::System::Registry::HKEY_CURRENT_USER as USER;
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

use crate::registry;

/// Run with this and Perli restores the old values and exits. The uninstaller does that.
pub const RESTORE_ARGUMENT: &str = "--restore-default";

const VERB: &str = "perli";
const FOLDER_KINDS: [&str; 2] = ["Directory", "Drive"];
/// What Win+E runs.
const WIN_E: &str = r"CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command";
/// The backup's value that names the program the other values were written for.
const BACKUP_EXE: &str = "exe";

/// One value this feature writes, under the classes key.
struct Value {
    key: String,
    name: &'static str,
    data: String,
}

fn values(exe: &str) -> Vec<Value> {
    let value = |key: String, name, data: String| Value { key, name, data };
    let mut values = Vec::new();
    for kind in FOLDER_KINDS {
        values.push(value(format!(r"{kind}\shell"), "", VERB.into()));
        values.push(value(format!(r"{kind}\shell\{VERB}"), "", "Open in Perli".into()));
        values.push(value(format!(r"{kind}\shell\{VERB}\command"), "", format!(r#""{exe}" "%1""#)));
    }
    values.push(value(WIN_E.into(), "", format!(r#""{exe}""#)));
    values.push(value(WIN_E.into(), "DelegateExecute", String::new()));
    values
}

/// Where the values go, under `HKEY_CURRENT_USER`.
struct Roots {
    classes: String,
    backup: String,
}

impl Roots {
    fn of_user() -> Self {
        Self {
            classes: r"Software\Classes".into(),
            backup: r"Software\Perli\DefaultApp".into(),
        }
    }

    fn class(&self, key: &str) -> String {
        format!(r"{}\{key}", self.classes)
    }

    fn is_default(&self) -> bool {
        let shown = registry::read_text(USER, &self.class(r"Directory\shell"), Some(""));
        shown.as_deref() == Some(VERB)
    }

    /// Perli's own values never count as old ones. A backup can still be here because another
    /// app took the folders over since, and what it holds for values still Perli's is the truth.
    fn write(&self, exe: &str) -> Result<()> {
        let saved_for = registry::read_text(USER, &self.backup, Some(BACKUP_EXE));
        let own = saved_for.map_or_else(Vec::new, |exe| values(&exe));
        registry::write_text(USER, &self.backup, BACKUP_EXE, exe)?;
        for (index, value) in values(exe).iter().enumerate() {
            let key = self.class(&value.key);
            let old = registry::read_text(USER, &key, Some(value.name));
            if own.get(index).is_none_or(|own| old.as_ref() != Some(&own.data)) {
                let slot = index.to_string();
                match old {
                    Some(old) => registry::write_text(USER, &self.backup, &slot, &old)?,
                    None => registry::delete_value(USER, &self.backup, &slot),
                }
            }
            registry::write_text(USER, &key, value.name, &value.data)?;
        }
        Ok(())
    }

    fn enable(&self, exe: &str) -> Result<()> {
        if self.is_default() {
            return Ok(());
        }
        self.write(exe).inspect_err(|_| self.restore())
    }

    /// Puts back what `enable` found. A value some other app has changed since is theirs now.
    fn restore(&self) {
        let Some(exe) = registry::read_text(USER, &self.backup, Some(BACKUP_EXE)) else {
            return;
        };
        let values = values(&exe);
        for (index, value) in values.iter().enumerate() {
            let key = self.class(&value.key);
            if registry::read_text(USER, &key, Some(value.name)).as_ref() != Some(&value.data) {
                continue;
            }
            match registry::read_text(USER, &self.backup, Some(&index.to_string())) {
                Some(old) => {
                    let _ = registry::write_text(USER, &key, value.name, &old);
                }
                None => registry::delete_value(USER, &key, value.name),
            }
        }
        for key in made_keys(&values) {
            registry::delete_if_empty(USER, &self.class(&key));
        }
        registry::delete_tree(USER, &self.backup);
        if let Some((parent, _)) = self.backup.rsplit_once('\\') {
            registry::delete_if_empty(USER, parent);
        }
    }
}

/// Every key below the top level that `values` can have made, deepest first.
fn made_keys(values: &[Value]) -> Vec<String> {
    let mut keys = Vec::new();
    for value in values {
        let mut key = value.key.as_str();
        while let Some((parent, _)) = key.rsplit_once('\\') {
            keys.push(key.to_string());
            key = parent;
        }
    }
    keys.sort();
    keys.dedup();
    keys.sort_by_key(|key| Reverse(key.len()));
    keys
}

pub fn is_on() -> bool {
    Roots::of_user().is_default()
}

pub fn set(on: bool) -> Result<()> {
    let roots = Roots::of_user();
    if on {
        roots.enable(&std::env::current_exe()?.to_string_lossy())?;
    } else {
        roots.restore();
    }
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    use crate::registry::{exists, read_text, subkeys, write_text};

    const EXE: &str = r"C:\Program Files\Perli\perli.exe";

    /// Stands in for the user's classes, in a key of its own.
    struct Scratch {
        top: String,
        roots: Roots,
    }

    impl Scratch {
        fn new() -> Self {
            static COUNT: AtomicU32 = AtomicU32::new(0);
            let number = COUNT.fetch_add(1, Ordering::SeqCst);
            let top = format!(r"Software\Classes\perli-test-{}-{number}", std::process::id());
            let roots = Roots {
                classes: format!(r"{top}\classes"),
                backup: format!(r"{top}\perli\backup"),
            };
            write_text(USER, &roots.classes, "keep", "this key was here first").unwrap();
            write_text(USER, &format!(r"{top}\perli"), "keep", "so was this one").unwrap();
            Self { top, roots }
        }

        fn read(&self, key: &str, name: &str) -> Option<String> {
            read_text(USER, &self.roots.class(key), Some(name))
        }

        fn write(&self, key: &str, name: &str, text: &str) {
            write_text(USER, &self.roots.class(key), name, text).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            registry::delete_tree(USER, &self.top);
        }
    }

    #[test]
    fn folders_drives_and_win_e_all_lead_to_perli() {
        let scratch = Scratch::new();
        scratch.roots.enable(EXE).unwrap();

        assert!(scratch.roots.is_default());
        for kind in FOLDER_KINDS {
            assert_eq!(scratch.read(&format!(r"{kind}\shell"), "").unwrap(), VERB);
            let command = scratch.read(&format!(r"{kind}\shell\perli\command"), "").unwrap();
            assert_eq!(command, format!(r#""{EXE}" "%1""#));
        }
        assert_eq!(scratch.read(WIN_E, "").unwrap(), format!(r#""{EXE}""#));
        assert_eq!(scratch.read(WIN_E, "DelegateExecute").unwrap(), "");
    }

    #[test]
    fn restoring_leaves_nothing_where_nothing_was() {
        let scratch = Scratch::new();
        scratch.roots.enable(EXE).unwrap();
        scratch.roots.restore();

        assert!(!scratch.roots.is_default());
        assert_eq!(subkeys(USER, &scratch.roots.classes), ["CLSID", "Directory", "Drive"]);
        for kind in ["CLSID", "Directory", "Drive"] {
            assert_eq!(subkeys(USER, &scratch.roots.class(kind)), [""; 0]);
        }
        assert!(!exists(USER, &scratch.roots.backup));
    }

    #[test]
    fn restoring_brings_back_what_was_there() {
        let scratch = Scratch::new();
        scratch.write(r"Directory\shell", "", "other");
        scratch.write(r"Directory\shell\other\command", "", "other.exe");
        scratch.write(WIN_E, "DelegateExecute", "{old}");

        scratch.roots.enable(EXE).unwrap();
        assert_eq!(scratch.read(r"Directory\shell", "").unwrap(), VERB);
        scratch.roots.restore();

        assert_eq!(scratch.read(r"Directory\shell", "").unwrap(), "other");
        assert_eq!(scratch.read(r"Directory\shell\other\command", "").unwrap(), "other.exe");
        assert_eq!(scratch.read(WIN_E, "DelegateExecute").unwrap(), "{old}");
        assert_eq!(scratch.read(WIN_E, ""), None);
        assert_eq!(subkeys(USER, &scratch.roots.class(r"Directory\shell")), ["other"]);
    }

    #[test]
    fn enabling_twice_keeps_the_first_backup() {
        let scratch = Scratch::new();
        scratch.write(r"Drive\shell", "", "other");

        scratch.roots.enable(EXE).unwrap();
        scratch.roots.enable(EXE).unwrap();
        scratch.roots.restore();

        assert_eq!(scratch.read(r"Drive\shell", "").unwrap(), "other");
    }

    #[test]
    fn enabling_after_another_app_took_over_keeps_the_real_old_values() {
        let scratch = Scratch::new();
        scratch.write(r"Drive\shell", "", "first");
        scratch.write(WIN_E, "DelegateExecute", "{old}");
        scratch.roots.enable(EXE).unwrap();

        scratch.write(r"Directory\shell", "", "newer");
        scratch.roots.enable(EXE).unwrap();
        assert!(scratch.roots.is_default());
        scratch.roots.restore();

        assert_eq!(scratch.read(r"Directory\shell", "").unwrap(), "newer");
        assert_eq!(scratch.read(r"Drive\shell", "").unwrap(), "first");
        assert_eq!(scratch.read(WIN_E, "DelegateExecute").unwrap(), "{old}");
        assert_eq!(scratch.read(WIN_E, ""), None);
        for kind in FOLDER_KINDS {
            assert!(!exists(USER, &scratch.roots.class(&format!(r"{kind}\shell\perli"))));
        }
    }

    #[test]
    fn enabling_again_lets_a_value_another_app_removed_stay_removed() {
        let scratch = Scratch::new();
        scratch.write(r"Drive\shell", "", "first");
        scratch.roots.enable(EXE).unwrap();

        registry::delete_value(USER, &scratch.roots.class(r"Drive\shell"), "");
        scratch.write(r"Directory\shell", "", "newer");
        scratch.roots.enable(EXE).unwrap();
        scratch.roots.restore();

        assert_eq!(scratch.read(r"Drive\shell", ""), None);
    }

    #[test]
    fn restoring_leaves_what_someone_else_put_in_perlis_keys() {
        let scratch = Scratch::new();
        scratch.roots.enable(EXE).unwrap();
        scratch.write(r"Directory\shell\perli\command", "", "theirs.exe");
        scratch.write(r"Drive\shell\perli", "Icon", "theirs.ico");

        scratch.roots.restore();

        assert_eq!(scratch.read(r"Directory\shell\perli\command", "").unwrap(), "theirs.exe");
        assert_eq!(scratch.read(r"Drive\shell\perli", "Icon").unwrap(), "theirs.ico");
        assert_eq!(scratch.read(r"Drive\shell\perli", ""), None);
        assert!(!exists(USER, &scratch.roots.class(r"Drive\shell\perli\command")));
    }

    #[test]
    fn restoring_brings_back_a_command_that_was_there_first() {
        let scratch = Scratch::new();
        scratch.write(r"Directory\shell\perli\command", "", "old.exe");

        scratch.roots.enable(EXE).unwrap();
        scratch.roots.restore();

        assert_eq!(scratch.read(r"Directory\shell\perli\command", "").unwrap(), "old.exe");
    }

    #[test]
    fn a_value_another_app_took_over_stays_theirs() {
        let scratch = Scratch::new();
        scratch.roots.enable(EXE).unwrap();
        scratch.write(r"Directory\shell", "", "newer");

        scratch.roots.restore();

        assert_eq!(scratch.read(r"Directory\shell", "").unwrap(), "newer");
        assert!(!exists(USER, &scratch.roots.class(r"Directory\shell\perli")));
        assert_eq!(scratch.read(r"Drive\shell", ""), None);
    }

    #[test]
    fn restoring_with_nothing_saved_changes_nothing() {
        let scratch = Scratch::new();
        scratch.write(r"Directory\shell", "", VERB);

        scratch.roots.restore();

        assert_eq!(scratch.read(r"Directory\shell", "").unwrap(), VERB);
    }

    #[test]
    fn restoring_undoes_a_write_that_stopped_halfway() {
        let scratch = Scratch::new();
        scratch.write(r"Drive\shell", "", "other");
        write_text(USER, &scratch.roots.backup, BACKUP_EXE, EXE).unwrap();
        scratch.write(r"Directory\shell", "", VERB);

        scratch.roots.restore();

        assert_eq!(scratch.read(r"Directory\shell", ""), None);
        assert_eq!(scratch.read(r"Drive\shell", "").unwrap(), "other");
        assert!(!exists(USER, &scratch.roots.backup));
    }
}
