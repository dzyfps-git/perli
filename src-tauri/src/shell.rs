//! Asks Windows to do things the way Explorer would.

use std::mem::size_of;

use windows::core::{w, Error, Result, HSTRING, PCWSTR};
use windows::Win32::Foundation::{E_FAIL, HGLOBAL};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
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
