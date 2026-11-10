//! What a start of Perli is asked to open, and how a later start hands that to the Perli that
//! already runs, so a folder opens as a tab there and no second program loads.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::core::HSTRING;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

/// Perli's own name for the Recycle Bin, which the UI knows too.
pub const BIN: &str = "shell:RecycleBinFolder";
const BIN_NAMES: [&str; 3] = [
    BIN,
    "::{645FF040-5081-101B-9F08-00AA002F954E}",
    "shell:::{645FF040-5081-101B-9F08-00AA002F954E}",
];
/// More than any command line holds.
const LONGEST_ASK: u64 = 256 * 1024;
const ERROR_PIPE_BUSY: i32 = 231;

/// A folder to show, and the items to select in it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ask {
    pub folder: Option<String>,
    /// Names of items in `folder`.
    pub select: Vec<String>,
    /// Set by `--new-window`: this start gets a window of its own.
    #[serde(skip)]
    pub new_window: bool,
}

impl Ask {
    /// Reads the command line, without the program's name. A lone path is a folder, or a file to
    /// select. `/select,` is how other apps ask File Explorer for the same.
    pub fn parse(args: &[String]) -> Self {
        let mut ask = Self::default();
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            if arg == "--new-window" {
                ask.new_window = true;
            } else if arg == "--select" {
                args.next().into_iter().for_each(|path| ask.point_at(path));
            } else if arg == "--directory" {
                ask.folder = args.next().cloned().map(crate::folder_argument);
            } else if let Some(path) = arg.strip_prefix("/select,") {
                ask.point_at(path);
            } else if ask.folder.is_none() {
                ask.folder = Some(crate::folder_argument(arg.clone()));
            }
        }
        ask
    }

    fn point_at(&mut self, path: &str) {
        let path = Path::new(path.trim_matches('"'));
        let text = |part: &std::ffi::OsStr| part.to_string_lossy().into_owned();
        self.select = path.file_name().map(text).into_iter().collect();
        self.folder = path.parent().map(|parent| text(parent.as_os_str()));
    }

    /// Settles what only the disk can tell. `Err` names a place Perli can't show, such as This PC
    /// or Control Panel, which File Explorer then opens.
    pub fn settle(mut self) -> Result<Self, String> {
        let Some(folder) = self.folder.clone() else {
            return Ok(self);
        };
        if BIN_NAMES.iter().any(|name| name.eq_ignore_ascii_case(&folder)) {
            self.folder = Some(BIN.into());
            return Ok(self);
        }
        let path = Path::new(&folder);
        if is_shell_place(&folder) || !(folder.starts_with(r"\\") || path.exists()) {
            return Err(folder);
        }
        if self.select.is_empty() && path.is_file() {
            self.point_at(&folder);
        }
        Ok(self)
    }

    /// The folder on disk this asks for and nothing more, which is what Windows runs Perli with
    /// when another app wants a file shown in its folder.
    pub fn plain_folder(&self) -> Option<&str> {
        let folder = self.folder.as_deref()?;
        (self.select.is_empty() && folder != BIN).then_some(folder)
    }
}

/// A place Windows names by an id, not by a path.
fn is_shell_place(target: &str) -> bool {
    let starts = |start: &str| target.get(..start.len()).is_some_and(|text| text.eq_ignore_ascii_case(start));
    starts("::{") || starts("shell:")
}

/// One name per user, so two people signed in at once each reach their own Perli.
fn pipe_name() -> HSTRING {
    HSTRING::from(format!(r"\\.\pipe\perli-open-{}", std::env::var("USERNAME").unwrap_or_default()))
}

fn new_pipe(first: bool) -> Option<File> {
    let first = if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { FILE_FLAGS_AND_ATTRIBUTES(0) };
    let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    let pipe =
        unsafe { CreateNamedPipeW(&pipe_name(), PIPE_ACCESS_INBOUND | first, mode, PIPE_UNLIMITED_INSTANCES, 0, 4096, 0, None) };
    (!pipe.is_invalid()).then(|| unsafe { File::from_raw_handle(pipe.0) })
}

/// Held by the one Perli that later starts hand their folders to.
pub struct Door(File);

impl Door {
    /// `None` when another Perli holds it already.
    pub fn claim() -> Option<Self> {
        new_pipe(true).map(Self)
    }

    /// Calls `on_ask` for each later start, from a thread of its own.
    pub fn listen(self, on_ask: impl Fn(Ask) + Send + 'static) {
        thread::spawn(move || {
            let mut pipe = self.0;
            loop {
                // An error here means the other side is connected already.
                let _ = unsafe { ConnectNamedPipe(HANDLE(pipe.as_raw_handle()), None) };
                // The next one is open before this one is read, so no start finds the door gone.
                let next = new_pipe(false);
                let mut text = String::new();
                if (&pipe).take(LONGEST_ASK).read_to_string(&mut text).is_ok() {
                    serde_json::from_str(&text).into_iter().for_each(&on_ask);
                }
                match next {
                    Some(next) => pipe = next,
                    None => return,
                }
            }
        });
    }
}

/// Hands `ask` to the Perli that holds the door. False when none does.
pub fn hand_off(ask: &Ask) -> bool {
    let name = pipe_name().to_string();
    for _ in 0..20 {
        match OpenOptions::new().write(true).open(&name) {
            Ok(mut pipe) => {
                // Windows lets only the app the user just used come to the front, and that is
                // this start. The Perli with the window needs the right passed on.
                let _ = unsafe { AllowSetForegroundWindow(ASFW_ANY) };
                let text = serde_json::to_string(ask).unwrap_or_default();
                return pipe.write_all(text.as_bytes()).is_ok();
            }
            // It is between two starts. That takes a moment.
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn parsed(args: &[&str]) -> Ask {
        Ask::parse(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn a_lone_path_is_the_folder_to_open() {
        let ask = parsed(&[r"C:\Users"]);
        assert_eq!(ask.folder.as_deref(), Some(r"C:\Users"));
        assert!(ask.select.is_empty() && !ask.new_window);
        assert_eq!(parsed(&[]), Ask::default());
    }

    #[test]
    fn a_file_to_select_opens_its_folder() {
        for args in [&["--select", r"C:\Users\a.txt"][..], &[r"/select,C:\Users\a.txt"], &[r#"/select,"C:\Users\a.txt""#]] {
            let ask = parsed(args);
            assert_eq!(ask.folder.as_deref(), Some(r"C:\Users"), "{args:?}");
            assert_eq!(ask.select, ["a.txt"], "{args:?}");
        }
        assert_eq!(parsed(&["--select", r"C:\a.txt"]).folder.as_deref(), Some(r"C:\"));
    }

    #[test]
    fn the_flags_can_come_in_any_order() {
        let ask = parsed(&["--directory", r"D:\Work", "--new-window"]);
        assert_eq!(ask.folder.as_deref(), Some(r"D:\Work"));
        assert!(ask.new_window);
        assert!(parsed(&["--new-window", r"D:\Work"]).new_window);
    }

    #[test]
    fn places_without_a_path_go_to_explorer_and_the_bin_stays() {
        let settled = |folder: &str| parsed(&[folder]).settle();
        assert_eq!(settled("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}").unwrap_err(), "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}");
        assert!(settled("Shell:Downloads").is_err());
        assert!(settled(r"C:\no such folder here 7f3a").is_err());
        assert_eq!(settled("::{645ff040-5081-101b-9f08-00aa002f954e}").unwrap().folder.as_deref(), Some(BIN));
        assert!(settled(r"\\server\share").is_ok());
        assert!(parsed(&[]).settle().is_ok());
    }

    #[test]
    fn a_file_given_as_the_folder_is_selected_in_its_own() {
        let folder = std::env::temp_dir().join(format!("perli-launch-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("note.txt");
        std::fs::write(&file, "").unwrap();

        let ask = parsed(&[&file.to_string_lossy()]).settle().unwrap();
        assert_eq!(ask.folder.as_deref(), folder.to_str());
        assert_eq!(ask.select, ["note.txt"]);
        assert_eq!(ask.plain_folder(), None);
        let plain = parsed(&[&folder.to_string_lossy()]).settle().unwrap();
        assert_eq!(plain.plain_folder(), folder.to_str());

        std::fs::remove_dir_all(&folder).unwrap();
    }

    /// One test for the door, because there is one per user and tests run side by side.
    #[test]
    fn a_later_start_reaches_the_one_holding_the_door() {
        let Some(door) = Door::claim() else {
            // A Perli is running on this machine, and its door is not this test's to take.
            return;
        };
        assert!(Door::claim().is_none());
        let (sender, asked) = mpsc::channel();
        door.listen(move |ask| sender.send(ask).unwrap());

        for name in ["one", "two"] {
            let ask = Ask { folder: Some(r"C:\Users".into()), select: vec![name.into()], new_window: true };
            assert!(hand_off(&ask));
            let got = asked.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(got, Ask { new_window: false, ..ask });
        }
    }
}
