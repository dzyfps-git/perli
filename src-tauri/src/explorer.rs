//! The two things Perli does in File Explorer's name once folders open in Perli: it sends the
//! places it can't show back to Explorer, and it poses as an Explorer window for a moment so
//! "Show in folder" in a browser or a download manager selects the file in Perli.
//!
//! Both are ported from the launcher of the Files app (`src/Files.App.Launcher`), which is under
//! the MIT License:
//!
//! Copyright (c) Files Community
//!
//! Permission is hereby granted, free of charge, to any person obtaining a copy of this software
//! and associated documentation files (the "Software"), to deal in the Software without
//! restriction, including without limitation the rights to use, copy, modify, merge, publish,
//! distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//! Software is furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in all copies or
//! substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
//! BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//! NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
//! DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

use std::cell::RefCell;
use std::ffi::c_void;
use std::process::Command;
use std::ptr::null_mut;
use std::rc::Rc;
use std::time::{Duration, Instant};

use windows::core::{implement, w, Error, IUnknownImpl, Interface, Ref, Result, BOOL, BSTR, GUID, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    DISP_E_MEMBERNOTFOUND, DISP_E_UNKNOWNNAME, E_NOINTERFACE, E_NOTIMPL, HWND, LPARAM, RECT, SHANDLE_PTR, VARIANT_BOOL,
    VARIANT_FALSE, VARIANT_TRUE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IDispatch, IDispatch_Impl, IServiceProvider,
    IServiceProvider_Impl, ITypeInfo, CLSCTX_ALL, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, DISPATCH_FLAGS,
    DISPPARAMS, EXCEPINFO,
};
use windows::Win32::System::Ole::IOleWindow_Impl;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::System::Variant::{InitVariantFromBuffer, VARIANT};
use windows::Win32::UI::Controls::LPFNSVADDPROPSHEETPAGE;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IFolderView, IPersistFolder2, IShellBrowser, IShellView, IShellView_Impl, IShellWindows, IWebBrowserApp,
    IWebBrowserApp_Impl, IWebBrowser_Impl, ILCombine, ILFree, ILGetSize, ILIsEqual, ILIsParent, SHGetNameFromIDList,
    SHParseDisplayName, ShellWindows, FOLDERSETTINGS, SBSP_ABSOLUTE, SBSP_SAMEBROWSER, SID_STopLevelBrowser,
    SIGDN_DESKTOPABSOLUTEPARSING, SWC_BROWSER, _SVGIO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, MsgWaitForMultipleObjects, PeekMessageW, TranslateMessage,
    MSG, PM_REMOVE, QS_ALLINPUT, WINDOW_STYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// Control Panel's start page. Its links ask Windows to open a folder, where Explorer's own
/// folders just go there.
const CONTROL_PANEL: &str = "::{26EE0668-A00A-44D7-9371-BEB064C98683}";
/// `SVSI_SELECT`, `SVSI_EDIT`, `SVSI_ENSUREVISIBLE` and `SVSI_FOCUSED`: the ways to point at an item.
const POINTS_AT: u32 = 0x1 | 0x3 | 0x8 | 0x10;
/// Items asked for one right after another are one selection.
const QUIET: Duration = Duration::from_millis(120);

/// A place as Windows names it, which also names what has no path.
struct Place(*mut ITEMIDLIST);

impl Place {
    fn parse(name: &str) -> Result<Self> {
        let mut place = null_mut();
        unsafe { SHParseDisplayName(&HSTRING::from(name), None, &mut place, 0, None)? };
        Ok(Self(place))
    }

    fn path(&self) -> Result<String> {
        let name = unsafe { SHGetNameFromIDList(self.0, SIGDN_DESKTOPABSOLUTEPARSING)? };
        let path = unsafe { name.to_string() };
        unsafe { CoTaskMemFree(Some(name.0.cast())) };
        path.map_err(|_| Error::from(E_NOTIMPL))
    }

    fn variant(&self) -> Result<VARIANT> {
        unsafe { InitVariantFromBuffer(self.0.cast(), ILGetSize(Some(self.0))) }
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        unsafe { ILFree(Some(self.0)) };
    }
}

/// Runs `work` with COM set up on this thread.
fn with_com<T>(work: impl FnOnce() -> T) -> T {
    let entered = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let result = work();
    if entered {
        unsafe { CoUninitialize() };
    }
    result
}

/// Shows in File Explorer a place Perli can't show.
pub fn open(target: &str) {
    let target = if target.starts_with("::{") { format!("shell:{target}") } else { target.to_string() };
    if with_com(|| unsafe { browse_open_window(&target) }).unwrap_or(false) {
        return;
    }
    // Explorer run by name shows the place itself, and never asks who opens folders.
    let _ = Command::new("explorer.exe").arg(&target).spawn();
}

/// Takes an Explorer window that shows the parent of `target`, or Control Panel, there. Without
/// this, each click in Control Panel would open one more window.
// ponytail: Files also checks that Explorer started this process. Left out, so a place opened
// from another app can land in such a window too. Add the check if that ever confuses anyone.
unsafe fn browse_open_window(target: &str) -> Result<bool> {
    let control_panel = Place::parse(CONTROL_PANEL)?;
    let target = Place::parse(target)?;
    let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)?;
    for index in 0..windows.Count()? {
        let Ok(window) = windows.Item(&VARIANT::from(index)) else {
            continue;
        };
        let browsed = (|| -> Result<bool> {
            let browser: IShellBrowser = window.cast::<IServiceProvider>()?.QueryService(&SID_STopLevelBrowser)?;
            let view: IFolderView = browser.QueryActiveShellView()?.cast()?;
            let shown = Place(view.GetFolder::<IPersistFolder2>()?.GetCurFolder()?);
            if !ILIsParent(shown.0, target.0, true).as_bool() && !ILIsEqual(shown.0, control_panel.0).as_bool() {
                return Ok(false);
            }
            browser.BrowseObject(target.0, SBSP_SAMEBROWSER | SBSP_ABSOLUTE)?;
            Ok(true)
        })();
        if matches!(browsed, Ok(true)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// What Windows takes for an Explorer window showing `folder`. It has no content. All it does is
/// note the items it is told to select.
#[implement(IWebBrowserApp, IServiceProvider, IShellView)]
struct Posing {
    folder: Place,
    window: HWND,
    picked: Rc<RefCell<Vec<String>>>,
}

fn text(text: &str) -> Result<BSTR> {
    Ok(BSTR::from(text))
}

fn not_here<T>() -> Result<T> {
    Err(E_NOTIMPL.into())
}

impl IDispatch_Impl for Posing_Impl {
    fn GetTypeInfoCount(&self) -> Result<u32> {
        Ok(0)
    }
    fn GetTypeInfo(&self, _: u32, _: u32) -> Result<ITypeInfo> {
        not_here()
    }
    fn GetIDsOfNames(&self, _: *const GUID, _: *const PCWSTR, _: u32, _: u32, _: *mut i32) -> Result<()> {
        Err(DISP_E_UNKNOWNNAME.into())
    }
    fn Invoke(
        &self,
        _: i32,
        _: *const GUID,
        _: u32,
        _: DISPATCH_FLAGS,
        _: *const DISPPARAMS,
        _: *mut VARIANT,
        _: *mut EXCEPINFO,
        _: *mut u32,
    ) -> Result<()> {
        Err(DISP_E_MEMBERNOTFOUND.into())
    }
}

impl IWebBrowser_Impl for Posing_Impl {
    fn GoBack(&self) -> Result<()> {
        not_here()
    }
    fn GoForward(&self) -> Result<()> {
        not_here()
    }
    fn GoHome(&self) -> Result<()> {
        not_here()
    }
    fn GoSearch(&self) -> Result<()> {
        not_here()
    }
    fn Navigate(&self, _: &BSTR, _: *const VARIANT, _: *const VARIANT, _: *const VARIANT, _: *const VARIANT) -> Result<()> {
        not_here()
    }
    fn Refresh(&self) -> Result<()> {
        Ok(())
    }
    fn Refresh2(&self, _: *const VARIANT) -> Result<()> {
        Ok(())
    }
    fn Stop(&self) -> Result<()> {
        Ok(())
    }
    fn Application(&self) -> Result<IDispatch> {
        self.to_interface::<IWebBrowserApp>().cast()
    }
    fn Parent(&self) -> Result<IDispatch> {
        self.to_interface::<IWebBrowserApp>().cast()
    }
    fn Container(&self) -> Result<IDispatch> {
        self.to_interface::<IWebBrowserApp>().cast()
    }
    fn Document(&self) -> Result<IDispatch> {
        self.to_interface::<IWebBrowserApp>().cast()
    }
    fn TopLevelContainer(&self) -> Result<VARIANT_BOOL> {
        Ok(VARIANT_TRUE)
    }
    fn Type(&self) -> Result<BSTR> {
        text("Perli")
    }
    fn Left(&self) -> Result<i32> {
        Ok(0)
    }
    fn SetLeft(&self, _: i32) -> Result<()> {
        not_here()
    }
    fn Top(&self) -> Result<i32> {
        Ok(0)
    }
    fn SetTop(&self, _: i32) -> Result<()> {
        not_here()
    }
    fn Width(&self) -> Result<i32> {
        Ok(0)
    }
    fn SetWidth(&self, _: i32) -> Result<()> {
        not_here()
    }
    fn Height(&self) -> Result<i32> {
        Ok(0)
    }
    fn SetHeight(&self, _: i32) -> Result<()> {
        not_here()
    }
    fn LocationName(&self) -> Result<BSTR> {
        text("")
    }
    fn LocationURL(&self) -> Result<BSTR> {
        text("")
    }
    fn Busy(&self) -> Result<VARIANT_BOOL> {
        Ok(VARIANT_FALSE)
    }
}

impl IWebBrowserApp_Impl for Posing_Impl {
    fn Quit(&self) -> Result<()> {
        Ok(())
    }
    fn ClientToWindow(&self, _: *mut i32, _: *mut i32) -> Result<()> {
        Ok(())
    }
    fn PutProperty(&self, _: &BSTR, _: &VARIANT) -> Result<()> {
        not_here()
    }
    fn GetProperty(&self, _: &BSTR) -> Result<VARIANT> {
        not_here()
    }
    fn Name(&self) -> Result<BSTR> {
        text("Perli")
    }
    fn HWND(&self) -> Result<SHANDLE_PTR> {
        Ok(SHANDLE_PTR(self.window.0 as isize))
    }
    fn FullName(&self) -> Result<BSTR> {
        text(&std::env::current_exe()?.to_string_lossy())
    }
    fn Path(&self) -> Result<BSTR> {
        self.FullName()
    }
    fn Visible(&self) -> Result<VARIANT_BOOL> {
        Ok(VARIANT_FALSE)
    }
    fn SetVisible(&self, _: VARIANT_BOOL) -> Result<()> {
        not_here()
    }
    fn StatusBar(&self) -> Result<VARIANT_BOOL> {
        Ok(VARIANT_FALSE)
    }
    fn SetStatusBar(&self, _: VARIANT_BOOL) -> Result<()> {
        not_here()
    }
    fn StatusText(&self) -> Result<BSTR> {
        text("")
    }
    fn SetStatusText(&self, _: &BSTR) -> Result<()> {
        not_here()
    }
    fn ToolBar(&self) -> Result<i32> {
        Ok(0)
    }
    fn SetToolBar(&self, _: i32) -> Result<()> {
        not_here()
    }
    fn MenuBar(&self) -> Result<VARIANT_BOOL> {
        Ok(VARIANT_FALSE)
    }
    fn SetMenuBar(&self, _: VARIANT_BOOL) -> Result<()> {
        not_here()
    }
    fn FullScreen(&self) -> Result<VARIANT_BOOL> {
        Ok(VARIANT_FALSE)
    }
    fn SetFullScreen(&self, _: VARIANT_BOOL) -> Result<()> {
        not_here()
    }
}

impl IServiceProvider_Impl for Posing_Impl {
    /// Whatever part of an Explorer window is asked for, this one object is it.
    fn QueryService(&self, _: *const GUID, riid: *const GUID, object: *mut *mut c_void) -> Result<()> {
        unsafe { self.QueryInterface(riid, object).ok() }
    }
}

impl IOleWindow_Impl for Posing_Impl {
    fn GetWindow(&self) -> Result<HWND> {
        Ok(self.window)
    }
    fn ContextSensitiveHelp(&self, _: BOOL) -> Result<()> {
        not_here()
    }
}

impl IShellView_Impl for Posing_Impl {
    fn TranslateAccelerator(&self, _: *const MSG) -> HRESULT {
        E_NOTIMPL
    }
    fn EnableModeless(&self, _: BOOL) -> Result<()> {
        Ok(())
    }
    fn UIActivate(&self, _: u32) -> Result<()> {
        Ok(())
    }
    fn Refresh(&self) -> Result<()> {
        Ok(())
    }
    fn CreateViewWindow(&self, _: Ref<IShellView>, _: *const FOLDERSETTINGS, _: Ref<IShellBrowser>, _: *const RECT) -> Result<HWND> {
        not_here()
    }
    fn DestroyViewWindow(&self) -> Result<()> {
        Ok(())
    }
    fn GetCurrentInfo(&self) -> Result<FOLDERSETTINGS> {
        Ok(FOLDERSETTINGS::default())
    }
    fn AddPropertySheetPages(&self, _: u32, _: LPFNSVADDPROPSHEETPAGE, _: LPARAM) -> Result<()> {
        not_here()
    }
    fn SaveViewState(&self) -> Result<()> {
        Ok(())
    }
    fn SelectItem(&self, item: *const ITEMIDLIST, flags: u32) -> Result<()> {
        if item.is_null() || flags & POINTS_AT == 0 {
            return Ok(());
        }
        let whole = Place(unsafe { ILCombine(Some(self.folder.0), Some(item)) });
        self.picked.borrow_mut().push(whole.path()?);
        Ok(())
    }
    fn GetItemObject(&self, _: &_SVGIO, _: *const GUID, _: *mut *mut c_void) -> Result<()> {
        Err(E_NOINTERFACE.into())
    }
}

/// Poses as an Explorer window showing `folder` for `wait`, on this thread. `on_select` gets the
/// paths another app asks to have selected there, which is how "Show in folder" works: the app
/// asks Windows, Windows opens the folder, waits for its window and tells that window what to
/// select. The window Perli really shows knows nothing of this, so this one answers for it.
pub fn pose(folder: &str, wait: Duration, on_select: impl Fn(Vec<String>)) {
    let _ = with_com(|| unsafe { pose_with_com(folder, wait, &on_select) });
}

unsafe fn pose_with_com(folder: &str, wait: Duration, on_select: &dyn Fn(Vec<String>)) -> Result<()> {
    let place = Place::parse(folder)?;
    let location = place.variant()?;
    // Never shown, and never in the way of the pointer or the keyboard.
    let window =
        CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, w!("Static"), w!("Perli"), WINDOW_STYLE(0), 0, 0, 0, 0, None, None, None, None)?;
    let picked = Rc::new(RefCell::new(Vec::new()));
    let posing: IWebBrowserApp = Posing { folder: place, window, picked: picked.clone() }.into();

    let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
    // Tells Windows a window for this folder is on its way, so it waits and opens no other.
    let pending = windows.RegisterPending(GetCurrentThreadId() as i32, &location, &VARIANT::default(), SWC_BROWSER);
    let registered = windows.Register(&posing, window.0 as i32, SWC_BROWSER);
    if let Ok(cookie) = registered {
        let _ = windows.OnNavigate(cookie, &location);
        wait_for_picks(wait, &picked, on_select);
        let _ = windows.Revoke(cookie);
    }
    // Registering can finish the pending entry under the same number.
    if let Ok(cookie) = pending {
        if registered.as_ref().ok() != Some(&cookie) {
            let _ = windows.Revoke(cookie);
        }
    }
    let _ = DestroyWindow(window);
    registered.map(|_| ())
}

/// Lets Windows call in until `wait` is over, and passes on each run of picks once it ends.
unsafe fn wait_for_picks(wait: Duration, picked: &RefCell<Vec<String>>, on_select: &dyn Fn(Vec<String>)) {
    let end = Instant::now() + wait;
    let mut seen = 0;
    while Instant::now() < end {
        MsgWaitForMultipleObjects(None, false, QUIET.as_millis() as u32, QS_ALLINPUT);
        let mut message = MSG::default();
        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let count = picked.borrow().len();
        if count > 0 && count == seen {
            on_select(picked.take());
        }
        seen = picked.borrow().len();
    }
    if !picked.borrow().is_empty() {
        on_select(picked.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use windows::Win32::UI::Shell::SHOpenFolderAndSelectItems;

    /// Asks Windows the way a browser's "Show in folder" does. Not run by default: when posing
    /// fails, Windows opens a real Explorer window on the folder.
    #[test]
    #[ignore = "opens a File Explorer window when it fails"]
    fn a_file_another_app_wants_shown_reaches_perli() {
        let folder = std::env::temp_dir().join(format!("perli-posing-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("shown.txt");
        std::fs::write(&file, "").unwrap();
        let folder = folder.canonicalize().unwrap().to_string_lossy().trim_start_matches(r"\\?\").to_string();
        let file = format!(r"{folder}\shown.txt");

        let (sender, picks) = mpsc::channel();
        let posed = folder.clone();
        let posing = thread::spawn(move || pose(&posed, Duration::from_secs(6), |paths| sender.send(paths).unwrap()));
        thread::sleep(Duration::from_millis(500));

        with_com(|| unsafe {
            let (parent, child) = (Place::parse(&folder).unwrap(), Place::parse(&file).unwrap());
            SHOpenFolderAndSelectItems(parent.0, Some(&[child.0.cast_const()]), 0).unwrap();
        });

        let got = picks.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].eq_ignore_ascii_case(&file), "{got:?}");
        posing.join().unwrap();
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
