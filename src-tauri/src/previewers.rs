//! Windows' own previewers, the ones Explorer's preview pane shows, such as Office's, inside
//! Perli's window.
//!
//! A previewer draws into a window. Perli makes a child window of its own over the place the
//! preview takes in the page, and hands it to the previewer. Previewers run in Windows' own
//! host process (prevhost.exe), as Explorer runs them, so one that crashes takes nothing of
//! Perli with it. Perli talks to it from a thread of its own; one that hangs is left behind on
//! that thread, and the next preview starts a fresh one, so the window never waits on it.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, Interface, Result as WinResult, GUID, HSTRING, PWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, S_FALSE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject, FillRect, GetDC, GetDIBits, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, SRCCOPY,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, STGM_READ, STGM_SHARE_DENY_NONE};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::IObjectWithSite;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CLASSES_ROOT, RRF_RT_ANY};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithFile, IInitializeWithStream};
use windows::Win32::UI::Shell::{
    AssocQueryStringW, IInitializeWithItem, IPreviewHandler, IPreviewHandlerFrame, IPreviewHandlerFrame_Impl, IPreviewHandlerVisuals, IShellItem,
    SHCreateItemFromParsingName, SHCreateStreamOnFileEx, ASSOCF_NONE, ASSOCSTR_SHELLEXTENSION, PREVIEWHANDLERFRAMEINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateAcceleratorTableW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW, GetWindowRect, PostMessageW,
    PostQuitMessage, RegisterClassW, SetParent, SetWindowPos, ShowWindow, TranslateMessage, ACCEL, FVIRTKEY, HACCEL, HWND_MESSAGE, HWND_TOP, MSG,
    SWP_NOACTIVATE, SW_HIDE, SW_SHOWNA, WM_APP, WM_ERASEBKGND, WM_KEYDOWN, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

/// The shell extension key Windows files previewers under.
const PREVIEW_HANDLER: &str = "{8895b1c6-b41f-4c1c-a562-0d564250836f}";
/// How long a previewer may take to show a file before Perli shows its own reader instead.
const OPEN_WAIT: Duration = Duration::from_secs(12);
const WAKE: u32 = WM_APP + 1;

/// The previewer Windows has for `path`, if it has one that runs in Windows' own host process.
pub fn find(path: &Path) -> Option<GUID> {
    let extension = HSTRING::from(format!(".{}", path.extension()?.to_string_lossy()));
    let mut text = [0u16; 64];
    let mut length = text.len() as u32;
    let found = unsafe { AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_SHELLEXTENSION, &extension, &HSTRING::from(PREVIEW_HANDLER), Some(PWSTR(text.as_mut_ptr())), &raw mut length) };
    if found.is_err() {
        return None;
    }
    let end = text.iter().position(|&unit| unit == 0)?;
    let name = String::from_utf16_lossy(&text[..end]);
    let clsid = GUID::try_from(name.trim_matches(['{', '}'])).ok()?;
    // A previewer runs out of process either as its own server, as Office's do, or through an
    // AppID in prevhost.exe. One that only loads into the caller is left alone.
    // An empty value name is the key's own value.
    let has = |key: String, value: &str| {
        let mut size = 0u32;
        unsafe { RegGetValueW(HKEY_CLASSES_ROOT, &HSTRING::from(key), &HSTRING::from(value), RRF_RT_ANY, None, None, Some(&raw mut size)) }.is_ok()
    };
    (has(format!("CLSID\\{name}"), "AppID") || has(format!("CLSID\\{name}\\LocalServer32"), "")).then_some(clsid)
}

/// Where the preview sits, in physical pixels inside the window, and its colours.
#[derive(Clone, Copy, serde::Deserialize)]
pub struct Place {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

enum Job {
    Open { path: PathBuf, clsid: GUID, host: isize, size: (i32, i32), back: u32, fore: u32, ticket: u64, done: Sender<Result<(), String>> },
    Size(i32, i32),
    Close(u64),
}

/// The window a previewer draws in, and the thread that talks to the previewer.
struct Host {
    window: isize,
    parent: isize,
    jobs: Sender<Job>,
    wake: isize,
}

static HOST: Mutex<Option<Host>> = Mutex::new(None);
/// The page numbers each preview, so a close for one already replaced leaves the new one alone,
/// and an open that comes after its own close shows nothing.
static CURRENT: AtomicU64 = AtomicU64::new(0);
static CLOSED: AtomicU64 = AtomicU64::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();
/// The page's background while the previewer loads, as a COLORREF.
static BACK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x0020_2020);

fn failed(reason: impl ToString) -> String {
    reason.to_string()
}

/// Runs `work` on the window's thread and waits for it.
fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (sent, got) = channel();
    app.run_on_main_thread(move || {
        let _ = sent.send(work());
    })
    .map_err(failed)?;
    got.recv_timeout(Duration::from_secs(5)).map_err(|_| "The window didn't answer".to_string())
}

/// Shows `path` through its previewer over `place` in `window`. Fails when there is none, it
/// won't open the file, or it takes too long; the page then shows Perli's own reader.
pub fn open(window: &tauri::WebviewWindow, path: PathBuf, place: Place, back: u32, fore: u32, ticket: u64) -> Result<(), String> {
    let clsid = find(&path).ok_or("Windows has no previewer for it")?;
    if ticket <= CLOSED.load(Ordering::SeqCst) {
        return Err("It was closed".into());
    }
    CURRENT.store(ticket, Ordering::SeqCst);
    let app = window.app_handle().clone();
    let _ = APP.set(app.clone());
    let parent = window.hwnd().map_err(failed)?.0 as isize;
    BACK.store(back, std::sync::atomic::Ordering::Relaxed);
    let (jobs, wake, host) = {
        let mut kept = HOST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if kept.is_none() {
            let window = on_main(&app, move || make_window(parent))?.map_err(failed)?;
            let (jobs, wake) = start_worker()?;
            *kept = Some(Host { window, parent, jobs, wake });
        }
        let host = kept.as_mut().ok_or("No host")?;
        if host.parent != parent {
            let (window, to) = (host.window, parent);
            on_main(&app, move || unsafe { SetParent(HWND(window as _), Some(HWND(to as _))) }.is_ok())?;
            host.parent = parent;
        }
        (host.jobs.clone(), host.wake, host.window)
    };
    place_window(&app, host, place, true)?;
    let (done, answer) = channel();
    jobs.send(Job::Open { path, clsid, host, size: (place.width, place.height), back, fore, ticket, done }).map_err(failed)?;
    unsafe { PostMessageW(Some(HWND(wake as _)), WAKE, WPARAM(0), LPARAM(0)) }.map_err(failed)?;
    match answer.recv_timeout(OPEN_WAIT) {
        Ok(result) => result.inspect_err(|_| hide(&app)),
        Err(_) => {
            // Left behind: its thread ends once the previewer answers, if it ever does.
            abandon(&app);
            Err("The previewer took too long".into())
        }
    }
}

fn send(job: Job) {
    let kept = HOST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(host) = kept.as_ref() {
        if host.jobs.send(job).is_ok() {
            let _ = unsafe { PostMessageW(Some(HWND(host.wake as _)), WAKE, WPARAM(0), LPARAM(0)) };
        }
    }
}

/// Moves the preview with the page, or hides it while something of Perli's covers it.
pub fn place(app: &AppHandle, place: Place, shown: bool) -> Result<(), String> {
    let window = HOST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|host| host.window).ok_or("Nothing is previewed")?;
    place_window(app, window, place, shown)?;
    send(Job::Size(place.width, place.height));
    Ok(())
}

fn place_window(app: &AppHandle, window: isize, place: Place, shown: bool) -> Result<(), String> {
    on_main(app, move || unsafe {
        let window = HWND(window as _);
        let _ = SetWindowPos(window, Some(HWND_TOP), place.x, place.y, place.width.max(1), place.height.max(1), SWP_NOACTIVATE);
        let _ = ShowWindow(window, if shown { SW_SHOWNA } else { SW_HIDE });
    })
}

fn hide(app: &AppHandle) {
    if let Some(window) = HOST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|host| host.window) {
        let _ = on_main(app, move || unsafe { ShowWindow(HWND(window as _), SW_HIDE) });
    }
}

/// Lets the previewer go and hides its window, unless a newer preview took its place.
pub fn close(app: &AppHandle, ticket: u64) {
    CLOSED.fetch_max(ticket, Ordering::SeqCst);
    if CURRENT.load(Ordering::SeqCst) == ticket {
        send(Job::Close(ticket));
        hide(app);
    }
}

/// Gives up on a previewer that hangs: its window is hidden and dropped with it, and the next
/// preview gets a new window and a new thread.
fn abandon(app: &AppHandle) {
    if let Some(host) = HOST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        let window = host.window;
        let _ = on_main(app, move || unsafe { ShowWindow(HWND(window as _), SW_HIDE) });
        // Dropping the jobs ends the thread once it is free; it then destroys the window.
        drop(host.jobs);
        let _ = unsafe { PostMessageW(Some(HWND(host.wake as _)), WAKE, WPARAM(0), LPARAM(0)) };
    }
}

/// What the preview shows now, as a picture in the thumbnail format the page draws, for a
/// moment when something of Perli's covers it. Read from the screen while it is still there.
pub fn snapshot() -> Result<Vec<u8>, String> {
    let window = HOST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|host| host.window).ok_or("Nothing is previewed")?;
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(HWND(window as _), &mut rect).map_err(failed)?;
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        if width <= 0 || height <= 0 {
            return Err("It isn't showing".into());
        }
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let old = SelectObject(memory, bitmap.into());
        let copied = BitBlt(memory, 0, 0, width, height, Some(screen), rect.left, rect.top, SRCCOPY);
        SelectObject(memory, old);
        let mut info = BITMAPINFO {
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
        let mut out = vec![0u8; 8 + width as usize * height as usize * 4];
        out[..4].copy_from_slice(&(width as u32).to_le_bytes());
        out[4..8].copy_from_slice(&(height as u32).to_le_bytes());
        let lines = GetDIBits(memory, bitmap, 0, height as u32, Some(out[8..].as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        copied.map_err(failed)?;
        if lines == 0 {
            return Err("The screen couldn't be read".into());
        }
        // Blue, green, red to red, green, blue, and no see-through.
        for pixel in out[8..].as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(out)
    }
}

fn make_window(parent: isize) -> WinResult<isize> {
    unsafe {
        let instance = GetModuleHandleW(None)?.into();
        let class = WNDCLASSW { lpfnWndProc: Some(host_procedure), hInstance: instance, lpszClassName: windows::core::w!("PerliPreviewHost"), ..Default::default() };
        RegisterClassW(&class);
        let window = CreateWindowExW(
            Default::default(),
            class.lpszClassName,
            None,
            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            1,
            1,
            Some(HWND(parent as _)),
            None,
            Some(instance),
            None,
        )?;
        Ok(window.0 as isize)
    }
}

unsafe extern "system" fn host_procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_ERASEBKGND {
        let mut rect = RECT::default();
        unsafe {
            let _ = GetClientRect(window, &mut rect);
            let brush = CreateSolidBrush(COLORREF(BACK.load(std::sync::atomic::Ordering::Relaxed)));
            FillRect(HDC(wparam.0 as _), &rect, brush);
            let _ = DeleteObject(brush.into());
        }
        return LRESULT(1);
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// The thread a previewer is talked to on, which pumps messages as COM needs.
fn start_worker() -> Result<(Sender<Job>, isize), String> {
    let (jobs, taken) = channel::<Job>();
    let (ready, wake) = channel();
    std::thread::Builder::new()
        .name("previewer".into())
        .spawn(move || worker(taken, ready))
        .map_err(failed)?;
    let wake = wake.recv_timeout(Duration::from_secs(5)).map_err(|_| "The previewer thread didn't start".to_string())??;
    Ok((jobs, wake))
}

thread_local! {
    static JOBS: std::cell::RefCell<Option<Receiver<Job>>> = const { std::cell::RefCell::new(None) };
    static SHOWN: std::cell::RefCell<Option<IPreviewHandler>> = const { std::cell::RefCell::new(None) };
    /// Set while a call to the previewer is out, when COM may hand this thread messages.
    static BUSY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The window this thread's previewer draws in, destroyed when the thread ends.
    static WINDOW: std::cell::Cell<isize> = const { std::cell::Cell::new(0) };
    static SHOWN_TICKET: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn worker(taken: Receiver<Job>, ready: Sender<Result<isize, String>>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let made = (|| -> WinResult<HWND> {
            let instance = GetModuleHandleW(None)?.into();
            let class = WNDCLASSW { lpfnWndProc: Some(worker_procedure), hInstance: instance, lpszClassName: windows::core::w!("PerliPreviewerJobs"), ..Default::default() };
            RegisterClassW(&class);
            CreateWindowExW(Default::default(), class.lpszClassName, None, Default::default(), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(instance), None)
        })();
        let wake = match made {
            Ok(wake) => wake,
            Err(error) => {
                let _ = ready.send(Err(error.message()));
                return;
            }
        };
        JOBS.with(|jobs| *jobs.borrow_mut() = Some(taken));
        let _ = ready.send(Ok(wake.0 as isize));
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = DestroyWindow(wake);
    }
}

unsafe extern "system" fn worker_procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WAKE {
        if !BUSY.get() {
            run_jobs();
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// Does every job waiting. When the jobs end, the previewer goes and the thread with it.
fn run_jobs() {
    loop {
        let job = JOBS.with(|jobs| jobs.borrow().as_ref().map(|jobs| jobs.try_recv()));
        match job {
            Some(Ok(job)) => {
                BUSY.set(true);
                run(job);
                BUSY.set(false);
            }
            Some(Err(std::sync::mpsc::TryRecvError::Empty)) => return,
            _ => {
                unload();
                let old_window = WINDOW.get();
                if let (Some(app), true) = (APP.get(), old_window != 0) {
                    let _ = app.run_on_main_thread(move || unsafe {
                        let _ = DestroyWindow(HWND(old_window as _));
                    });
                }
                unsafe { PostQuitMessage(0) };
                return;
            }
        }
    }
}

fn unload() {
    if let Some(handler) = SHOWN.with(|shown| shown.borrow_mut().take()) {
        unsafe {
            let _ = handler.Unload();
            if let Ok(site) = handler.cast::<IObjectWithSite>() {
                let _ = site.SetSite(None);
            }
        }
    }
}

fn run(job: Job) {
    match job {
        Job::Open { path, clsid, host, size, back, fore, ticket, done } => {
            unload();
            WINDOW.set(host);
            SHOWN_TICKET.set(ticket);
            let result = show(&path, clsid, HWND(host as _), size, back, fore).map_err(|error| error.message());
            let _ = done.send(result);
        }
        Job::Size(width, height) => {
            if let Some(handler) = SHOWN.with(|shown| shown.borrow().clone()) {
                let rect = RECT { left: 0, top: 0, right: width.max(1), bottom: height.max(1) };
                let _ = unsafe { handler.SetRect(&rect) };
            }
        }
        // Only the preview it was for: a newer one may have come first.
        Job::Close(ticket) if ticket == SHOWN_TICKET.get() => unload(),
        Job::Close(_) => {}
    }
}

fn show(path: &Path, clsid: GUID, host: HWND, (width, height): (i32, i32), back: u32, fore: u32) -> WinResult<()> {
    unsafe {
        let handler: IPreviewHandler = CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER)?;
        let wide = HSTRING::from(path.as_os_str());
        let started = handler
            .cast::<IInitializeWithFile>()
            .and_then(|start| start.Initialize(&wide, STGM_READ.0))
            .or_else(|_| {
                let item: IShellItem = SHCreateItemFromParsingName(&wide, None)?;
                handler.cast::<IInitializeWithItem>()?.Initialize(&item, STGM_READ.0)
            })
            .or_else(|_| {
                let stream = SHCreateStreamOnFileEx(&wide, (STGM_READ | STGM_SHARE_DENY_NONE).0, 0, false, None)?;
                handler.cast::<IInitializeWithStream>()?.Initialize(&stream, STGM_READ.0)
            });
        // A previewer that took the file and then failed still holds it until it is unloaded.
        let shown = started.and_then(|()| present(&handler, host, (width, height), back, fore));
        if shown.is_err() {
            let _ = handler.Unload();
            if let Ok(site) = handler.cast::<IObjectWithSite>() {
                let _ = site.SetSite(None);
            }
        }
        shown?;
        SHOWN.with(|shown| *shown.borrow_mut() = Some(handler));
        Ok(())
    }
}

fn present(handler: &IPreviewHandler, host: HWND, (width, height): (i32, i32), back: u32, fore: u32) -> WinResult<()> {
    unsafe {
        if let Ok(site) = handler.cast::<IObjectWithSite>() {
            let frame: IPreviewHandlerFrame = Frame.into();
            let _ = site.SetSite(&frame);
        }
        if let Ok(visuals) = handler.cast::<IPreviewHandlerVisuals>() {
            let _ = visuals.SetBackgroundColor(COLORREF(back));
            let _ = visuals.SetTextColor(COLORREF(fore));
        }
        let rect = RECT { left: 0, top: 0, right: width.max(1), bottom: height.max(1) };
        handler.SetWindow(host, &rect)?;
        handler.DoPreview()
    }
}

/// What Perli tells a previewer about its frame: the keys Perli wants back, which is only Esc,
/// so Esc leaves the preview as it does everywhere in Perli.
#[implement(IPreviewHandlerFrame)]
struct Frame;

static KEYS: OnceLock<isize> = OnceLock::new();

impl IPreviewHandlerFrame_Impl for Frame_Impl {
    fn GetWindowContext(&self) -> WinResult<PREVIEWHANDLERFRAMEINFO> {
        let keys = *KEYS.get_or_init(|| {
            let table = [ACCEL { fVirt: FVIRTKEY, key: VK_ESCAPE.0, cmd: 1 }];
            unsafe { CreateAcceleratorTableW(&table) }.map_or(0, |table| table.0 as isize)
        });
        Ok(PREVIEWHANDLERFRAMEINFO { haccel: HACCEL(keys as _), cAccelEntries: 1 })
    }

    fn TranslateAccelerator(&self, message: *const MSG) -> WinResult<()> {
        let Some(message) = (unsafe { message.as_ref() }) else { return Err(S_FALSE.into()) };
        if message.message == WM_KEYDOWN && message.wParam.0 == usize::from(VK_ESCAPE.0) {
            if let Some(app) = APP.get() {
                let _ = app.emit("previewer-key", "Escape");
            }
            return Ok(());
        }
        Err(windows::core::Error::from(S_FALSE))
    }
}
