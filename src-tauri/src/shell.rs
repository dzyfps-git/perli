//! Asks Windows to do things the way Explorer would.

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::process::Command;

use windows::core::{w, Error, Result, HSTRING};
use windows::Win32::Foundation::{E_FAIL, HGLOBAL};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Threading::CREATE_NEW_CONSOLE;
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

/// Another program wrote the clipboard, so its text may have no terminating null.
fn until_null(text: &[u16]) -> String {
    let end = text.iter().position(|&unit| unit == 0).unwrap_or(text.len());
    String::from_utf16_lossy(&text[..end])
}

unsafe fn open_clipboard_text() -> String {
    let Ok(handle) = GetClipboardData(CF_UNICODETEXT) else {
        return String::new();
    };
    let memory = HGLOBAL(handle.0);
    let units = GlobalSize(memory) / size_of::<u16>();
    let text = GlobalLock(memory) as *const u16;
    if text.is_null() {
        return String::new();
    }
    let result = until_null(std::slice::from_raw_parts(text, units));
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

/// Opens a terminal in `folder`: Windows Terminal if there is one, or else PowerShell.
pub fn open_terminal(folder: &str) -> std::io::Result<()> {
    let terminal = Command::new("wt.exe")
        .args(["-d", "."])
        .current_dir(folder)
        .spawn();
    terminal
        .or_else(|_| {
            Command::new("powershell.exe")
                .current_dir(folder)
                .creation_flags(CREATE_NEW_CONSOLE.0)
                .spawn()
        })
        .map(drop)
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

    #[test]
    fn clipboard_text_stops_at_null_or_the_end_of_its_memory() {
        let text: Vec<u16> = "ab".encode_utf16().collect();
        assert_eq!(until_null(&text), "ab");
        assert_eq!(until_null(&[text[0], 0, text[1]]), "a");
        assert_eq!(until_null(&[]), "");
    }
}
