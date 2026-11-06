//! Asks Windows to do things the way Explorer would.

use std::mem::size_of;

use windows::core::{w, Error, Result, HSTRING};
use windows::Win32::Foundation::{E_FAIL, HGLOBAL};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN,
    VK_Z,
};
use windows::Win32::UI::Shell::ShellExecuteW;
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
    fn clipboard_text_stops_at_null_or_the_end_of_its_memory() {
        let text: Vec<u16> = "ab".encode_utf16().collect();
        assert_eq!(until_null(&text), "ab");
        assert_eq!(until_null(&[text[0], 0, text[1]]), "a");
        assert_eq!(until_null(&[]), "");
    }
}
