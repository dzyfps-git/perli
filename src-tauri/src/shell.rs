//! Asks Windows to do things the way Explorer would.

use windows::core::{w, Error, Result, HSTRING};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Values at or below this mean `ShellExecuteW` failed.
const SHELL_EXECUTE_ERROR_MAX: isize = 32;

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
