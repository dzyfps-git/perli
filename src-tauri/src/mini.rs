//! The small window a film plays on in after its preview closes. It floats over every window,
//! has the film's own shape however it is sized, and springs to the nearest corner of its screen
//! once it is let go. Windows moves and sizes it, so both stay smooth.

use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, IsWindowVisible, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    WMSZ_BOTTOM, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_SIZING,
};

pub const LABEL: &str = "mini";
const MAIN: &str = "main";
/// Space kept between the window and the screen's edges, in pixels at 96 DPI.
const MARGIN: i32 = 16;
const START_WIDTH: f64 = 400.0;
const START_HEIGHT: f64 = 225.0;
const LEAST_WIDTH: f64 = 200.0;
const SPRING_STEPS: u32 = 20;
const SPRING_STEP: Duration = Duration::from_millis(14);
const SUBCLASS: usize = 0x6d696e69;

/// What the main window handed over, until the small window takes it.
#[derive(Default)]
pub struct Handed(Mutex<Option<Value>>);

/// The film's width over its height, as `f32` bits, which every resize keeps.
static ASPECT: AtomicU32 = AtomicU32::new(0);
/// Bumped by each spring and each grab, so an older spring stops where it is.
static SPRING: AtomicUsize = AtomicUsize::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// A corner of the screen's work area.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum Corner {
    #[serde(rename = "tl")]
    TopLeft,
    #[serde(rename = "tr")]
    TopRight,
    #[serde(rename = "bl")]
    BottomLeft,
    #[serde(rename = "br")]
    BottomRight,
}

impl Corner {
    fn named(name: &str) -> Self {
        match name {
            "tl" => Self::TopLeft,
            "tr" => Self::TopRight,
            "bl" => Self::BottomLeft,
            _ => Self::BottomRight,
        }
    }

    /// The corner whose quarter of `area` holds the middle of `window`.
    fn nearest(window: RECT, area: RECT) -> Self {
        let left = window.left + window.right < area.left + area.right;
        let top = window.top + window.bottom < area.top + area.bottom;
        match (top, left) {
            (true, true) => Self::TopLeft,
            (true, false) => Self::TopRight,
            (false, true) => Self::BottomLeft,
            (false, false) => Self::BottomRight,
        }
    }

    /// Where a window `width` by `height` sits in this corner of `area`, `margin` in from its edges.
    fn spot(self, area: RECT, width: i32, height: i32, margin: i32) -> (i32, i32) {
        let x = match self {
            Self::TopLeft | Self::BottomLeft => area.left + margin,
            _ => area.right - margin - width,
        };
        let y = match self {
            Self::TopLeft | Self::TopRight => area.top + margin,
            _ => area.bottom - margin - height,
        };
        (x, y)
    }
}

/// `rect` after a resize from `edge`, made the film's shape again. The edge held by the user's
/// pointer leads; the far edges stay where they are.
fn keep_shape(mut rect: RECT, edge: u32, aspect: f32) -> RECT {
    if aspect <= 0.0 {
        return rect;
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    match edge {
        WMSZ_TOP | WMSZ_BOTTOM => rect.right = rect.left + (height as f32 * aspect).round() as i32,
        _ => {
            let fitted = (width as f32 / aspect).round() as i32;
            if matches!(edge, WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
                rect.top = rect.bottom - fitted;
            } else {
                rect.bottom = rect.top + fitted;
            }
        }
    }
    rect
}

/// How far along a spring is at `t` from 0 to 1: past the end a little, then back.
fn spring(t: f32) -> f32 {
    const PULL: f32 = 1.4;
    let back = t - 1.0;
    1.0 + (PULL + 1.0) * back.powi(3) + PULL * back.powi(2)
}

fn rect_of(window: HWND) -> RECT {
    let mut rect = RECT::default();
    unsafe {
        let _ = GetWindowRect(window, &mut rect);
    }
    rect
}

fn work_area(window: HWND) -> RECT {
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe {
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let _ = GetMonitorInfoW(monitor, &mut info);
    }
    info.rcWork
}

fn margin(window: HWND) -> i32 {
    MARGIN * unsafe { GetDpiForWindow(window) }.max(96) as i32 / 96
}

/// Glides the window into the nearest corner of its screen, and tells the page which corner.
fn settle(window: HWND) {
    let turn = SPRING.fetch_add(1, Ordering::SeqCst) + 1;
    let rect = rect_of(window);
    let area = work_area(window);
    let corner = Corner::nearest(rect, area);
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    let (to_x, to_y) = corner.spot(area, width, height, margin(window));
    let handle = window.0 as isize;
    thread::spawn(move || {
        let window = HWND(handle as _);
        for step in 1..=SPRING_STEPS {
            if SPRING.load(Ordering::SeqCst) != turn {
                return;
            }
            let along = spring(step as f32 / SPRING_STEPS as f32);
            let x = rect.left + ((to_x - rect.left) as f32 * along).round() as i32;
            let y = rect.top + ((to_y - rect.top) as f32 * along).round() as i32;
            unsafe {
                let _ = SetWindowPos(window, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
            thread::sleep(SPRING_STEP);
        }
        let scale = unsafe { GetDpiForWindow(window) }.max(96) as f64 / 96.0;
        if let Some(app) = APP.get() {
            let _ = app.emit_to(LABEL, "mini-corner", (corner, width as f64 / scale));
        }
    });
}

unsafe extern "system" fn subclass(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _: usize, _: usize) -> LRESULT {
    match message {
        WM_SIZING => {
            let rect = lparam.0 as *mut RECT;
            *rect = keep_shape(*rect, wparam.0 as u32, f32::from_bits(ASPECT.load(Ordering::Relaxed)));
            LRESULT(1)
        }
        WM_ENTERSIZEMOVE => {
            SPRING.fetch_add(1, Ordering::SeqCst);
            DefSubclassProc(window, message, wparam, lparam)
        }
        WM_EXITSIZEMOVE => {
            settle(window);
            DefSubclassProc(window, message, wparam, lparam)
        }
        _ => DefSubclassProc(window, message, wparam, lparam),
    }
}

fn native(window: &tauri::WebviewWindow) -> Result<HWND, String> {
    Ok(HWND(window.hwnd().map_err(|error| error.to_string())?.0))
}

/// Hands a film to the small window, which is made, hidden, the first time. It shows itself
/// once it knows the film's shape, through `mini_fit`.
#[tauri::command]
pub async fn mini_open(state: Value, app: AppHandle, handed: State<'_, Handed>) -> Result<(), String> {
    let _ = APP.set(app.clone());
    *handed.0.lock().unwrap() = Some(state.clone());
    if app.get_webview_window(LABEL).is_some() {
        return app.emit_to(LABEL, "mini-take", state).map_err(|error| error.to_string());
    }
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("mini.html".into()))
        .title("Perli player")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .visible(false)
        .inner_size(START_WIDTH, START_HEIGHT)
        .min_inner_size(LEAST_WIDTH, LEAST_WIDTH / 2.0)
        .build()
        .map_err(|error| error.to_string())?;
    let handle = native(&window)?.0 as isize;
    window
        .run_on_main_thread(move || unsafe {
            let _ = SetWindowSubclass(HWND(handle as _), Some(subclass), SUBCLASS, 0);
        })
        .map_err(|error| error.to_string())
}

/// The film the main window handed over last, for a small window that has just loaded.
#[tauri::command]
pub fn mini_take(handed: State<'_, Handed>) -> Option<Value> {
    handed.0.lock().unwrap().take()
}

/// Gives the small window the film's shape at `width` (in pixels at 96 DPI), and puts it in
/// `corner` of the screen the main window is on. A window already showing stays on its screen.
#[tauri::command]
pub fn mini_fit(width: f64, aspect: f64, corner: String, app: AppHandle) -> Result<(), String> {
    let mini = app.get_webview_window(LABEL).ok_or("The player has closed")?;
    let window = native(&mini)?;
    let aspect = if aspect.is_finite() && aspect > 0.1 { aspect } else { 16.0 / 9.0 };
    ASPECT.store((aspect as f32).to_bits(), Ordering::Relaxed);
    SPRING.fetch_add(1, Ordering::SeqCst);
    let shown = unsafe { IsWindowVisible(window) }.as_bool();
    let screen = match app.get_webview_window(MAIN) {
        Some(main) if !shown => native(&main)?,
        _ => window,
    };
    let scale = unsafe { GetDpiForWindow(screen) }.max(96) as f64 / 96.0;
    let area = work_area(screen);
    let most = ((area.right - area.left) as f64 * 0.6) / scale;
    let width = (width.clamp(LEAST_WIDTH, most.max(LEAST_WIDTH)) * scale).round() as i32;
    let height = (width as f64 / aspect).round() as i32;
    let (x, y) = Corner::named(&corner).spot(area, width, height, margin(screen));
    unsafe { SetWindowPos(window, Some(HWND_TOPMOST), x, y, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE) }
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_RIGHT};

    const AREA: RECT = RECT { left: 0, top: 0, right: 1920, bottom: 1040 };

    #[test]
    fn nearest_corner_goes_by_the_quarter_of_the_middle() {
        let at = |left, top| RECT { left, top, right: left + 400, bottom: top + 225 };
        assert_eq!(Corner::nearest(at(10, 10), AREA), Corner::TopLeft);
        assert_eq!(Corner::nearest(at(1500, 10), AREA), Corner::TopRight);
        assert_eq!(Corner::nearest(at(10, 800), AREA), Corner::BottomLeft);
        assert_eq!(Corner::nearest(at(1500, 800), AREA), Corner::BottomRight);
        // Screens left of the main one have their area at negative numbers.
        let left_screen = RECT { left: -1920, top: 0, right: 0, bottom: 1040 };
        assert_eq!(Corner::nearest(at(-500, 800), left_screen), Corner::BottomRight);
    }

    #[test]
    fn a_corner_spot_keeps_the_margin() {
        assert_eq!(Corner::BottomRight.spot(AREA, 400, 225, 16), (1504, 799));
        assert_eq!(Corner::TopLeft.spot(AREA, 400, 225, 16), (16, 16));
        assert_eq!(Corner::named("tr").spot(AREA, 400, 225, 16), (1504, 16));
    }

    #[test]
    fn a_resize_keeps_the_film_shape_with_the_far_edges_still() {
        let rect = RECT { left: 100, top: 100, right: 500, bottom: 400 };
        let wide = 16.0 / 9.0;
        assert_eq!(keep_shape(rect, WMSZ_RIGHT, wide), RECT { left: 100, top: 100, right: 500, bottom: 325 });
        assert_eq!(keep_shape(rect, WMSZ_LEFT, wide).bottom, 325);
        assert_eq!(keep_shape(rect, WMSZ_BOTTOM, wide), RECT { left: 100, top: 100, right: 633, bottom: 400 });
        assert_eq!(keep_shape(rect, WMSZ_TOP, wide).right, 633);
        // From a top corner the bottom stays put.
        assert_eq!(keep_shape(rect, WMSZ_TOPLEFT, wide), RECT { left: 100, top: 175, right: 500, bottom: 400 });
        assert_eq!(keep_shape(rect, WMSZ_TOPRIGHT, wide).top, 175);
        assert_eq!(keep_shape(rect, WMSZ_BOTTOMLEFT, wide).bottom, 325);
        assert_eq!(keep_shape(rect, WMSZ_BOTTOMRIGHT, wide).bottom, 325);
        // With no shape known yet, the rect is left alone.
        assert_eq!(keep_shape(rect, WMSZ_RIGHT, 0.0), rect);
    }

    #[test]
    fn the_spring_ends_where_it_aims_after_going_past() {
        assert!(spring(0.0).abs() < 1e-6);
        assert!((spring(1.0) - 1.0).abs() < 1e-6);
        assert!((0..=100).any(|step| spring(step as f32 / 100.0) > 1.0));
    }
}
