//! A tab dragged out of its window. While it is out, a small picture of it follows the pointer
//! in a window of its own, since a page can't draw past its window. Dropped on another Perli
//! window, the tab goes to it as a message between the two; elsewhere it opens a new window.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, CreateWindowExW, DefWindowProcW, EnumWindows, GetAncestor, GetCursorPos, GetPropW,
    GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, RegisterClassW, SendMessageTimeoutW, SetForegroundWindow, SetPropW,
    SetWindowPos, ShowWindow, UpdateLayeredWindow, WindowFromPoint, GA_ROOT, SMTO_ABORTIFHUNG, SWP_NOACTIVATE, SWP_NOSIZE,
    SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WM_COPYDATA, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

/// Marks each Perli window that holds tabs, so a drop can tell one from any other window.
const MARK: PCWSTR = w!("PerliTabs");
/// What a message between two Perli windows carries: a tab, or an ask for all of them.
const TAB: usize = 0x5045_5254;
const GATHER: usize = 0x5045_5247;
const SUBCLASS: usize = 0x7461_6273;
/// How long a window that doesn't answer is waited for.
const ANSWER_MS: u32 = 3000;
/// How far down a window's top its tab strip reaches, at 96 DPI.
const TAB_BAR: i32 = 44;
/// Where the pointer holds the tab's picture, at 96 DPI.
const HOLD_X: i32 = 28;
const HOLD_Y: i32 = 20;

static APP: OnceLock<AppHandle> = OnceLock::new();
static GHOST: AtomicIsize = AtomicIsize::new(0);

fn tauri_error(error: impl ToString) -> String {
    error.to_string()
}

fn native(window: &WebviewWindow) -> Result<HWND, String> {
    Ok(HWND(window.hwnd().map_err(tauri_error)?.0))
}

/// Marks the main window and listens for tabs sent to it. Called once, at the start.
pub fn mark(window: &WebviewWindow) -> Result<(), String> {
    let _ = APP.set(window.app_handle().clone());
    let handle = native(window)?;
    unsafe {
        SetPropW(handle, MARK, Some(HANDLE(1 as _))).map_err(tauri_error)?;
        SetWindowSubclass(handle, Some(subclass), SUBCLASS, 0).ok().map_err(tauri_error)?;
    }
    Ok(())
}

unsafe extern "system" fn subclass(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _: usize, _: usize) -> LRESULT {
    if message != WM_COPYDATA {
        return DefSubclassProc(window, message, wparam, lparam);
    }
    let data = &*(lparam.0 as *const COPYDATASTRUCT);
    let bytes = std::slice::from_raw_parts(data.lpData as *const u8, data.cbData as usize);
    let Some(app) = APP.get() else { return LRESULT(0) };
    match data.dwData {
        TAB => {
            let Ok(text) = std::str::from_utf8(bytes) else { return LRESULT(0) };
            let _ = SetForegroundWindow(window);
            LRESULT(app.emit_to("main", "tab-arrived", text).is_ok() as isize)
        }
        // A window whose jobs still run keeps its tabs: it can't close, and copies would only
        // leave the same folders open twice.
        GATHER if bytes.len() == size_of::<isize>() && !app.state::<crate::jobs::Jobs>().running() => {
            let asker = isize::from_le_bytes(bytes.try_into().unwrap());
            LRESULT(app.emit_to("main", "tabs-asked", asker).is_ok() as isize)
        }
        _ => LRESULT(0),
    }
}

fn send(to: HWND, kind: usize, bytes: &[u8]) -> bool {
    let data = COPYDATASTRUCT { dwData: kind, cbData: bytes.len() as u32, lpData: bytes.as_ptr() as *mut _ };
    let mut answer = 0usize;
    unsafe {
        let mut process = 0;
        GetWindowThreadProcessId(to, Some(&mut process));
        let _ = AllowSetForegroundWindow(process);
        let sent = SendMessageTimeoutW(
            to,
            WM_COPYDATA,
            WPARAM(0),
            LPARAM(&data as *const _ as isize),
            SMTO_ABORTIFHUNG,
            ANSWER_MS,
            Some(&mut answer),
        );
        sent.0 != 0 && answer != 0
    }
}

/// Another Perli's window holding tabs, which is not one of this Perli's.
fn other_perli(window: HWND) -> bool {
    let mut process = 0;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut process));
        process != std::process::id() && !GetPropW(window, MARK).is_invalid() && IsWindowVisible(window).as_bool()
    }
}

/// The Perli window under the pointer, if it is another one, and whether the pointer is on its tabs.
#[derive(Serialize)]
pub struct Target {
    window: isize,
    #[serde(rename = "tabBar")]
    tab_bar: bool,
}

/// Is a point `y` within the tab strip of a window whose top is `top`, at `dpi`?
fn on_tab_bar(y: i32, top: i32, dpi: u32) -> bool {
    y - top < TAB_BAR * dpi.max(96) as i32 / 96
}

#[tauri::command]
pub fn perli_window_at() -> Option<Target> {
    unsafe {
        let mut point = POINT::default();
        GetCursorPos(&mut point).ok()?;
        let window = GetAncestor(WindowFromPoint(point), GA_ROOT);
        if window.is_invalid() || !other_perli(window) {
            return None;
        }
        let mut rect = RECT::default();
        GetWindowRect(window, &mut rect).ok()?;
        Some(Target { window: window.0 as isize, tab_bar: on_tab_bar(point.y, rect.top, GetDpiForWindow(window)) })
    }
}

/// Sends a tab, as the text a new window would start from, to another Perli window.
#[tauri::command]
pub fn send_tab(window: isize, tab: String) -> bool {
    let to = HWND(window as _);
    other_perli(to) && send(to, TAB, tab.as_bytes())
}

/// Every other Perli window holding tabs.
#[tauri::command]
pub fn other_windows() -> Vec<isize> {
    unsafe extern "system" fn each(window: HWND, found: LPARAM) -> windows::core::BOOL {
        if other_perli(window) {
            (*(found.0 as *mut Vec<isize>)).push(window.0 as isize);
        }
        true.into()
    }
    let mut found = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

/// Asks another Perli window to send all its tabs here and close. False when it won't, because
/// its jobs still run, or it doesn't answer.
#[tauri::command]
pub fn ask_for_tabs(window: isize, own: WebviewWindow) -> Result<bool, String> {
    let to = HWND(window as _);
    let me = native(&own)?.0 as isize;
    Ok(other_perli(to) && send(to, GATHER, &me.to_le_bytes()))
}

unsafe extern "system" fn plain(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    DefWindowProcW(window, message, wparam, lparam)
}

fn ghost_window() -> Result<HWND, String> {
    let known = GHOST.load(Ordering::Relaxed);
    if known != 0 {
        return Ok(HWND(known as _));
    }
    unsafe {
        let instance = GetModuleHandleW(None).map_err(tauri_error)?;
        let class = w!("PerliTabGhost");
        let shape = WNDCLASSW { lpfnWndProc: Some(plain), hInstance: instance.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&shape);
        let window = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            class,
            None,
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(tauri_error)?;
        GHOST.store(window.0 as isize, Ordering::Relaxed);
        Ok(window)
    }
}

/// Where the picture's corner goes for the pointer at `point`, at `dpi`.
fn ghost_spot(point: POINT, dpi: u32) -> (i32, i32) {
    let scale = dpi.max(96) as i32;
    (point.x - HOLD_X * scale / 96, point.y - HOLD_Y * scale / 96)
}

/// `rgba` as Windows draws a picture with see-through parts: blue first, colours times alpha.
fn premultiplied(rgba: &[u8]) -> Vec<u8> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .flat_map(|pixel| {
            let [red, green, blue, alpha] = pixel.map(u32::from);
            let times = |colour: u32| ((colour * alpha + 127) / 255) as u8;
            [times(blue), times(green), times(red), alpha as u8]
        })
        .collect()
}

/// Shows the tab's picture at the pointer. The body is its width and height as little-endian
/// u32, then its pixels as RGBA.
#[tauri::command]
pub fn ghost_show(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else { return Err("No picture".into()) };
    let number = |at: usize| body.get(at..at + 4).map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()) as i32);
    let (Some(width), Some(height)) = (number(0), number(4)) else { return Err("No picture".into()) };
    let pixels = &body[8..];
    if width <= 0 || height <= 0 || pixels.len() != (width * height * 4) as usize {
        return Err("The picture's size doesn't match".into());
    }
    let window = ghost_window()?;
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        let (x, y) = ghost_spot(point, GetDpiForWindow(window));
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0).map_err(tauri_error)?;
        let drawn = premultiplied(pixels);
        std::ptr::copy_nonoverlapping(drawn.as_ptr(), bits as *mut u8, drawn.len());
        let before = SelectObject(memory, bitmap.into());
        let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8, ..Default::default() };
        let shown = UpdateLayeredWindow(
            window,
            Some(screen),
            Some(&POINT { x, y }),
            Some(&SIZE { cx: width, cy: height }),
            Some(memory),
            Some(&POINT::default()),
            windows::Win32::Foundation::COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        );
        SelectObject(memory, before);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        shown.map_err(tauri_error)?;
        let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

/// The picture follows the pointer.
#[tauri::command]
pub fn ghost_move() {
    let known = GHOST.load(Ordering::Relaxed);
    if known == 0 {
        return;
    }
    let window = HWND(known as _);
    unsafe {
        let mut point = POINT::default();
        if GetCursorPos(&mut point).is_err() {
            return;
        }
        let (x, y) = ghost_spot(point, GetDpiForWindow(window));
        let _ = SetWindowPos(window, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

#[tauri::command]
pub fn ghost_hide() {
    let known = GHOST.load(Ordering::Relaxed);
    if known != 0 {
        unsafe {
            let _ = ShowWindow(HWND(known as _), SW_HIDE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_premultiplied_and_turned_blue_first() {
        assert_eq!(premultiplied(&[255, 128, 0, 255]), [0, 128, 255, 255]);
        assert_eq!(premultiplied(&[255, 255, 255, 128]), [128, 128, 128, 128]);
        assert_eq!(premultiplied(&[200, 100, 50, 0]), [0, 0, 0, 0]);
    }

    #[test]
    fn the_tab_strip_is_the_top_of_a_window_at_its_scale() {
        assert!(on_tab_bar(130, 100, 96));
        assert!(!on_tab_bar(150, 100, 96));
        assert!(on_tab_bar(160, 100, 144));
    }

    #[test]
    fn the_picture_hangs_from_the_pointer_where_the_tab_was_held() {
        assert_eq!(ghost_spot(POINT { x: 500, y: 300 }, 96), (472, 280));
        assert_eq!(ghost_spot(POINT { x: 500, y: 300 }, 192), (444, 260));
    }

    #[test]
    fn a_window_of_this_perli_or_an_unmarked_one_is_no_target() {
        assert!(!other_perli(HWND(std::ptr::null_mut())));
        assert!(!send_tab(0, "{}".into()));
    }
}
