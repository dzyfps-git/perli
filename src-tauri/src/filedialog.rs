//! Experimental: sends the folder on show to an Open or Save dialog of another app, so the
//! dialog goes there without the path being typed. It works on the dialogs Windows itself draws.
//! An app that draws its own is not found.

use std::path::Path;

use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetClassNameW, GetDlgItem, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    SendMessageTimeoutW, IDOK, SMTO_ABORTIFHUNG, WM_COMMAND, WM_GETTEXT, WM_SETTEXT,
};

/// The class of every dialog Windows makes.
const DIALOG_CLASS: &str = "#32770";
/// The file name box of an Open or Save dialog: a combo box in today's dialogs, a plain edit
/// box in old ones. The numbers are `cmb13` and `edt1` of the Windows headers.
const NAME_COMBO: i32 = 0x47c;
const NAME_EDIT: i32 = 0x480;
const MOST_TEXT: usize = 2048;
/// An app that does not answer in this time is left alone.
const ANSWER_MS: u32 = 1500;

/// What to put in the file name box so the dialog goes to `folder`. The closing backslash makes
/// it a folder beyond doubt, where a bare name could be taken for a file to save as.
fn folder_text(folder: &Path) -> Vec<u16> {
    let text = folder.to_string_lossy();
    let text = text.trim_end_matches('\\');
    format!("{text}\\").encode_utf16().chain([0]).collect()
}

/// The file name box of `dialog`, if it is an Open or Save dialog.
fn name_box(dialog: HWND) -> Option<HWND> {
    unsafe {
        if let Ok(combo) = GetDlgItem(Some(dialog), NAME_COMBO) {
            let inner = FindWindowExW(Some(combo), None, w!("ComboBox"), PCWSTR::null()).unwrap_or(combo);
            return FindWindowExW(Some(inner), None, w!("Edit"), PCWSTR::null()).ok();
        }
        GetDlgItem(Some(dialog), NAME_EDIT).ok()
    }
}

/// The topmost Open or Save dialog on screen that is not Perli's own.
fn front_dialog() -> Option<(HWND, HWND)> {
    unsafe extern "system" fn visit(window: HWND, found: LPARAM) -> BOOL {
        let mut class = [0u16; 16];
        let length = GetClassNameW(window, &mut class) as usize;
        let mut process = 0;
        GetWindowThreadProcessId(window, Some(&raw mut process));
        let fits = IsWindowVisible(window).as_bool()
            && String::from_utf16_lossy(&class[..length]) == DIALOG_CLASS
            && process != GetCurrentProcessId();
        if let Some(edit) = fits.then(|| name_box(window)).flatten() {
            *(found.0 as *mut Option<(HWND, HWND)>) = Some((window, edit));
            // Windows come front to back, so the first is the one the user sees.
            return false.into();
        }
        true.into()
    }
    let mut found: Option<(HWND, HWND)> = None;
    // Stopping early reads as a failure, which it is not.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&raw mut found as isize)) };
    found
}

fn send(window: HWND, message: u32, wparam: usize, lparam: isize) -> Result<(), String> {
    let sent = unsafe { SendMessageTimeoutW(window, message, WPARAM(wparam), LPARAM(lparam), SMTO_ABORTIFHUNG, ANSWER_MS, None) };
    if sent.0 == 0 {
        return Err("The app with the file dialog did not answer.".into());
    }
    Ok(())
}

/// Makes the frontmost Open or Save dialog of another app go to `folder`, and puts back what was
/// in its file name box. Answers with the dialog's title.
pub fn go_to(folder: &Path) -> Result<String, String> {
    if !folder.is_dir() {
        return Err("Only a folder on a drive can be sent to a file dialog.".into());
    }
    let (dialog, edit) = front_dialog().ok_or("No Open or Save dialog of another app is on screen.")?;
    let mut before = [0u16; MOST_TEXT];
    send(edit, WM_GETTEXT, MOST_TEXT, before.as_mut_ptr() as isize)?;
    send(edit, WM_SETTEXT, 0, folder_text(folder).as_ptr() as isize)?;
    send(dialog, WM_COMMAND, IDOK.0 as usize, 0)?;
    // The name typed for a save is still wanted.
    send(edit, WM_SETTEXT, 0, before.as_ptr() as isize)?;

    let mut title = [0u16; 256];
    let length = unsafe { GetWindowTextW(dialog, &mut title) } as usize;
    Ok(String::from_utf16_lossy(&title[..length]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(folder: &str) -> String {
        let units = folder_text(Path::new(folder));
        assert_eq!(units.last(), Some(&0), "ends where Windows stops reading");
        String::from_utf16(&units[..units.len() - 1]).unwrap()
    }

    #[test]
    fn a_folder_is_sent_with_one_closing_backslash() {
        assert_eq!(text(r"C:\Users\me\Pictures"), r"C:\Users\me\Pictures\");
        assert_eq!(text(r"C:\Users\me\Pictures\"), r"C:\Users\me\Pictures\");
        assert_eq!(text(r"D:\"), r"D:\");
        assert_eq!(text(r"\\server\share"), r"\\server\share\");
    }

    #[test]
    fn what_is_no_folder_is_refused_before_any_window_is_looked_for() {
        let missing = std::env::temp_dir().join("perli-no-such-folder");
        assert!(go_to(&missing).unwrap_err().starts_with("Only a folder"));
    }
}
