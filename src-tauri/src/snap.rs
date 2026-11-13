//! Makes the HTML maximize button open Windows 11 Snap Layouts on hover.
//!
//! Windows shows the flyout when a window answers `WM_NCHITTEST` with `HTMAXBUTTON`, but
//! WebView2 covers the whole window and never gives that answer. So a small invisible
//! child window sits over the HTML button and answers instead. It takes the mouse from
//! that button, so it handles the click and reports hover. The keyboard still reaches
//! the HTML button. Its top edge stays free, so the window can still be resized from there.

use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::{Emitter, WebviewWindow};
use windows::core::{w, Result};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetParent, GetWindowRect, IsZoomed, LoadCursorW,
    RegisterClassW, SendMessageW, SetWindowPos, HTMAXBUTTON, HTTRANSPARENT, HWND_TOP, IDC_ARROW,
    SC_MAXIMIZE, SC_RESTORE, SM_CYFRAME, SWP_NOACTIVATE, WM_NCHITTEST, WM_NCLBUTTONDOWN,
    WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SYSCOMMAND, WNDCLASSW, WS_CHILD,
    WS_VISIBLE,
};

struct Area {
    window: WebviewWindow,
    /// An `HWND`, stored as a number because `HWND` cannot be shared between threads.
    handle: isize,
}

/// The one area of this process's one window. A second Perli window is a process of its own,
/// with its own area.
static AREA: OnceLock<Area> = OnceLock::new();
static HOVERED: AtomicBool = AtomicBool::new(false);

/// Moves the area over the maximize button, creating it the first time.
/// Call on the main thread. Takes physical pixels, relative to the window.
pub fn place(window: &WebviewWindow, x: i32, y: i32, width: i32, height: i32) -> Result<()> {
    let handle = match AREA.get() {
        Some(area) => HWND(area.handle as _),
        None => {
            let handle = create(HWND(window.hwnd().map_err(tauri_error)?.0))?;
            let area = Area {
                window: window.clone(),
                handle: handle.0 as isize,
            };
            let _ = AREA.set(area);
            handle
        }
    };
    unsafe { SetWindowPos(handle, Some(HWND_TOP), x, y, width, height, SWP_NOACTIVATE) }
}

fn tauri_error(error: tauri::Error) -> windows::core::Error {
    windows::core::Error::new(windows::Win32::Foundation::E_FAIL, error.to_string())
}

fn create(parent: HWND) -> Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?.into();
        let class = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            lpszClassName: w!("PerliSnapArea"),
            ..Default::default()
        };
        RegisterClassW(&class);
        CreateWindowExW(
            Default::default(),
            class.lpszClassName,
            None,
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            0,
            0,
            Some(parent),
            None,
            Some(instance),
            None,
        )
    }
}

fn report_hover(hovered: bool) {
    if let Some(area) = AREA.get() {
        let _ = area.window.emit("snap-hover", hovered);
    }
}

fn toggle_maximized(area: HWND) {
    unsafe {
        let Ok(parent) = GetParent(area) else { return };
        let command = if IsZoomed(parent).as_bool() {
            SC_RESTORE
        } else {
            SC_MAXIMIZE
        };
        SendMessageW(
            parent,
            WM_SYSCOMMAND,
            Some(WPARAM(command as usize)),
            Some(LPARAM(0)),
        );
    }
}

/// Whether the pointer is on the window's top resize border. A maximized window has none, so
/// the very top of the screen still reaches the button there.
fn on_resize_border(area: HWND, lparam: LPARAM) -> bool {
    let pointer_y = (lparam.0 as u32 >> 16) as i16 as i32;
    let mut rect = RECT::default();
    unsafe {
        let Ok(parent) = GetParent(area) else {
            return false;
        };
        if IsZoomed(parent).as_bool() || GetWindowRect(area, &mut rect).is_err() {
            return false;
        }
        pointer_y < rect.top + GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(area))
    }
}

unsafe extern "system" fn procedure(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let on_button = wparam.0 == HTMAXBUTTON as usize;
    match message {
        // Windows then asks the window below, which is Tauri's resize border.
        WM_NCHITTEST if on_resize_border(hwnd, lparam) => LRESULT(HTTRANSPARENT as isize),
        WM_NCHITTEST => LRESULT(HTMAXBUTTON as isize),
        WM_NCMOUSEMOVE => {
            if !HOVERED.swap(true, Ordering::Relaxed) {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                let _ = unsafe { TrackMouseEvent(&mut track) };
                report_hover(true);
            }
            LRESULT(0)
        }
        WM_NCMOUSELEAVE => {
            HOVERED.store(false, Ordering::Relaxed);
            report_hover(false);
            LRESULT(0)
        }
        // Answering here stops Windows starting its own button press handling.
        WM_NCLBUTTONDOWN if on_button => LRESULT(0),
        WM_NCLBUTTONUP if on_button => {
            toggle_maximized(hwnd);
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}
