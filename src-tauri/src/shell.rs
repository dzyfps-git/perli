//! Asks Windows to do things the way Explorer would.

use std::collections::HashMap;
use std::mem::size_of;

use windows::core::{w, Error, Result, HSTRING, PCWSTR};
use windows::Win32::Foundation::{E_FAIL, HGLOBAL};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN,
    VK_Z,
};
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, ShellExecuteW, SHFILEINFOW, SHGFI_TYPENAME, SHGFI_USEFILEATTRIBUTES,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Windows' standard clipboard format number for UTF-16 text.
const CF_UNICODETEXT: u32 = 13;

/// Values at or below this mean `ShellExecuteW` failed.
const SHELL_EXECUTE_ERROR_MAX: isize = 32;

/// The clipboard's text, empty if it holds none. WebView2's own clipboard read waits on a
/// permission prompt, which does not fit the app.
pub fn clipboard_text() -> Result<String> {
    unsafe {
        OpenClipboard(None)?;
        let text = open_clipboard_text();
        CloseClipboard()?;
        Ok(text)
    }
}

unsafe fn open_clipboard_text() -> String {
    let Ok(handle) = GetClipboardData(CF_UNICODETEXT) else {
        return String::new();
    };
    let memory = HGLOBAL(handle.0);
    let text = GlobalLock(memory) as *const u16;
    if text.is_null() {
        return String::new();
    }
    let result = PCWSTR(text).to_string().unwrap_or_default();
    // Reports an error once the lock count reaches zero, which is the normal outcome.
    let _ = GlobalUnlock(memory);
    result
}

/// Turns `~` and `%NAME%` in typed text into real paths. Unknown names stay as typed.
pub fn expand_path(text: &str) -> String {
    let text = text.trim().trim_matches('"');
    let home = text
        .strip_prefix('~')
        .filter(|rest| rest.is_empty() || rest.starts_with(['\\', '/']))
        .and_then(|rest| Some(format!("{}{rest}", std::env::var("USERPROFILE").ok()?)));
    let source = HSTRING::from(home.as_deref().unwrap_or(text));
    unsafe {
        let length = ExpandEnvironmentStringsW(&source, None);
        let mut expanded = vec![0; length as usize];
        let written = ExpandEnvironmentStringsW(&source, Some(&mut expanded));
        match written {
            0 => source.to_string(),
            // The count includes the terminating null.
            _ => String::from_utf16_lossy(&expanded[..written as usize - 1]),
        }
    }
}

/// Windows' name for each file extension, such as "PNG File". Blocks, so call it off the
/// main thread. Extensions Windows has no name for are left out.
pub fn type_names(extensions: Vec<String>) -> Result<HashMap<String, String>> {
    unsafe {
        // Windows requires COM on this thread for `SHGetFileInfoW`.
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
        let names = extensions
            .into_iter()
            .filter_map(|extension| Some((type_name(&extension)?, extension)))
            .map(|(name, extension)| (extension, name))
            .collect();
        CoUninitialize();
        Ok(names)
    }
}

fn type_name(extension: &str) -> Option<String> {
    let mut info = SHFILEINFOW::default();
    let found = unsafe {
        SHGetFileInfoW(
            &HSTRING::from(format!(".{extension}")),
            FILE_ATTRIBUTE_NORMAL,
            Some(&raw mut info),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_TYPENAME | SHGFI_USEFILEATTRIBUTES,
        )
    };
    let name = info.szTypeName;
    let length = name.iter().position(|&unit| unit == 0)?;
    (found != 0 && length > 0).then(|| String::from_utf16_lossy(&name[..length]))
}

/// Opens a file with its default app. Blocks, so call it off the main thread.
pub fn open(path: &str) -> Result<()> {
    unsafe {
        // Shell extensions that handle the open may need COM on this thread.
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
        let result = ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(path),
            None,
            None,
            SW_SHOWNORMAL,
        );
        CoUninitialize();

        if result.0 as isize > SHELL_EXECUTE_ERROR_MAX {
            Ok(())
        } else {
            Err(Error::new(E_FAIL, format!("Windows could not open {path}")))
        }
    }
}

fn key(code: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                ..Default::default()
            },
        },
    }
}

/// Opens the Windows 11 Snap Layouts flyout by pressing Win+Z.
// ponytail: a custom title bar gets no native hover on the maximize button, because
// WebView2 covers it. Win+Z shows the same flyout. Native hit-testing would need a hole
// cut in the WebView2 window and a natively drawn button.
pub fn show_snap_layouts() -> Result<()> {
    let keys = [
        key(VK_LWIN, false),
        key(VK_Z, false),
        key(VK_Z, true),
        key(VK_LWIN, true),
    ];
    let sent = unsafe { SendInput(&keys, size_of::<INPUT>() as i32) };
    if sent as usize == keys.len() {
        Ok(())
    } else {
        Err(Error::from_thread())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home_and_environment_names() {
        let home = std::env::var("USERPROFILE").unwrap();
        assert_eq!(expand_path("~"), home);
        assert_eq!(expand_path(r"~\Downloads"), format!(r"{home}\Downloads"));
        assert_eq!(expand_path(r#""%USERPROFILE%\a b""#), format!(r"{home}\a b"));
    }

    #[test]
    fn leaves_other_text_as_typed() {
        assert_eq!(expand_path("~other"), "~other");
        assert_eq!(expand_path(r"%NOT_A_REAL_NAME%\a"), r"%NOT_A_REAL_NAME%\a");
        assert_eq!(expand_path(r"C:\Users"), r"C:\Users");
    }

    #[test]
    fn names_a_file_type() {
        let names = type_names(vec!["txt".to_string()]).unwrap();
        assert!(!names["txt"].is_empty());
    }
}
