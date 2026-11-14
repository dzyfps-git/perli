//! What Windows itself offers on a right click: Open with, Send to, Properties and the full
//! shell menu. All of it runs other programs' shell extensions, which can hang and which expect
//! a thread that keeps a message loop, so it happens on one thread of its own.

use std::cell::{Cell, RefCell};
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;
use std::thread;

use serde::Serialize;
use windows::core::{s, w, Error, Interface, Result, HSTRING, PCSTR, PCWSTR, PSTR, PWSTR};
use windows::Win32::Foundation::{
    ERROR_CANCELLED, E_FAIL, HWND, LPARAM, LRESULT, POINT, POINTL, S_OK, WPARAM,
};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IDataObject, CLSCTX_INPROC_SERVER};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
use windows::Win32::System::Ole::{
    IDropTarget, OleInitialize, OleUninitialize, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK,
    DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MK_LBUTTON;
use windows::Win32::UI::Shell::Common::{COMDLG_FILTERSPEC, ITEMIDLIST};
use windows::Win32::UI::Shell::{
    FileOpenDialog, FOLDERID_SendTo, IAssocHandler, IContextMenu, IContextMenu2, IContextMenu3,
    FileSaveDialog, IFileDialog, IFileOpenDialog, IShellFolder, IShellItem, IShellItemArray, ILFree, SHAssocEnumHandlers,
    SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists, SHGetIDListFromObject, SHOpenWithDialog, ShellExecuteW,
    ASSOC_FILTER, ASSOC_FILTER_NONE, ASSOC_FILTER_RECOMMENDED, SIGDN_FILESYSPATH,
    BHID_DataObject, BHID_SFObject, BHID_SFUIObject, CMF_CANRENAME, CMF_EXPLORE, CMF_NORMAL,
    CMINVOKECOMMANDINFO,
    CMINVOKECOMMANDINFOEX, CMIC_MASK_PTINVOKE, GCS_VERBW, OAIF_ALLOW_REGISTRATION, OAIF_EXEC,
    OPENASINFO, SEE_MASK_UNICODE, FOS_PICKFOLDERS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DispatchMessageW, GetMenuItemCount,
    GetMenuItemInfoW, GetMessageW, HMENU, MENUITEMINFOW, MFS_CHECKED, MFS_DISABLED, MFT_SEPARATOR, MIIM_BITMAP,
    MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, PostMessageW, RegisterClassW, SetForegroundWindow, TrackPopupMenuEx, TranslateMessage, MSG,
    SW_SHOWNORMAL, TPM_RETURNCMD, TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WM_APP, WM_DRAWITEM,
    WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR, WM_NULL, WNDCLASSW, WS_POPUP,
};

use crate::{ops, places};

/// Asks the shell thread to look at its queue.
const WAKE: u32 = WM_APP;
const FIRST_COMMAND: u32 = 1;
const LAST_COMMAND: u32 = 0x7FFF;
/// `CMIC_MASK_UNICODE` has the same value, and the bindings leave it out.
const CMIC_MASK_UNICODE: u32 = SEE_MASK_UNICODE;
/// Longest verb worth reading. Verbs are short names such as "rename".
const LONGEST_VERB: usize = 64;
/// These only work inside Explorer's own window, or Perli does them better and can undo them.
const OWN_VERBS: [&str; 7] = ["open", "explore", "cut", "copy", "paste", "delete", "rename"];
/// uxtheme's `AllowDarkModeForWindow` has no name, only this number.
const ALLOW_DARK_FOR_WINDOW: usize = 133;
/// uxtheme's `FlushMenuThemes` has no name, only this number.
const FLUSH_MENU_THEMES: usize = 136;
const SEND_TO_SETTINGS: &str = "desktop.ini";

type Work = Box<dyn FnOnce(HWND) + Send>;

struct Worker {
    sender: Sender<Work>,
    /// An `HWND`, stored as a number because `HWND` cannot be shared between threads.
    window: isize,
}

static WORKER: OnceLock<Option<Worker>> = OnceLock::new();

thread_local! {
    static QUEUE: RefCell<Option<Receiver<Work>>> = const { RefCell::new(None) };
    /// The native menu on screen, which draws some of its own items.
    static OPEN_MENU: RefCell<Option<IContextMenu>> = const { RefCell::new(None) };
    /// Native menus pump messages, so a wake can arrive while work is under way.
    static WORKING: Cell<bool> = const { Cell::new(false) };
}

fn run_queue(owner: HWND) {
    if WORKING.replace(true) {
        return;
    }
    while let Some(work) = QUEUE.with_borrow(|queue| queue.as_ref()?.try_recv().ok()) {
        work(owner);
    }
    WORKING.set(false);
}

/// Lets the menu items that draw themselves do so.
fn forward(message: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
    let menu = OPEN_MENU.with_borrow(Clone::clone)?;
    let mut result = LRESULT(0);
    if let Ok(menu) = menu.cast::<IContextMenu3>() {
        unsafe { menu.HandleMenuMsg2(message, wparam, lparam, Some(&raw mut result)) }.ok()?;
    } else {
        unsafe { menu.cast::<IContextMenu2>().ok()?.HandleMenuMsg(message, wparam, lparam) }.ok()?;
    }
    Some(result)
}

unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WAKE => {
            run_queue(window);
            LRESULT(0)
        }
        WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR => {
            forward(message, wparam, lparam).unwrap_or(LRESULT(0))
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

/// Native menus stay light unless their owner says it can go dark, and the only way to say so
/// has no name. Without it the menu just stays light.
fn allow_dark_menus(window: HWND) {
    unsafe {
        let Ok(theme) = LoadLibraryW(w!("uxtheme.dll")) else {
            return;
        };
        let ordinal = |number: usize| GetProcAddress(theme, PCSTR(number as *const u8));
        if let (Some(allow), Some(flush)) = (ordinal(ALLOW_DARK_FOR_WINDOW), ordinal(FLUSH_MENU_THEMES)) {
            let allow: unsafe extern "system" fn(HWND, i32) -> i32 = std::mem::transmute(allow);
            let flush: unsafe extern "system" fn() = std::mem::transmute(flush);
            allow(window, 1);
            flush();
        }
    }
}

/// Never shown. It owns the native menu and what the menu's commands open.
fn create_owner() -> Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?.into();
        let class = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: w!("PerliShellOwner"),
            ..Default::default()
        };
        RegisterClassW(&class);
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class.lpszClassName,
            None,
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
    }
}

fn run_thread(queue: Receiver<Work>, ready: Sender<Option<isize>>) {
    let entered = unsafe { OleInitialize(None) }.is_ok();
    let Ok(owner) = create_owner() else {
        let _ = ready.send(None);
        return;
    };
    allow_dark_menus(owner);
    QUEUE.set(Some(queue));
    let _ = ready.send(Some(owner.0 as isize));

    let mut message = MSG::default();
    while unsafe { GetMessageW(&raw mut message, None, 0, 0) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&raw const message);
            DispatchMessageW(&raw const message);
        }
    }
    if entered {
        unsafe { OleUninitialize() };
    }
}

fn worker() -> Option<&'static Worker> {
    WORKER
        .get_or_init(|| {
            let (sender, queue) = channel();
            let (ready, started) = channel();
            thread::Builder::new()
                .name("shell".to_string())
                .spawn(move || run_thread(queue, ready))
                .ok()?;
            let window = started.recv().ok()??;
            Some(Worker { sender, window })
        })
        .as_ref()
}

/// Runs `work` on the shell thread and waits for it. Blocks, so call it off the main thread.
fn on_worker<T: Send + 'static>(
    work: impl FnOnce(HWND) -> Result<T> + Send + 'static,
) -> Result<T> {
    let worker = worker().ok_or_else(|| Error::new(E_FAIL, "The Windows shell is not available"))?;
    let (reply, answer) = channel();
    let job: Work = Box::new(move |owner| {
        let _ = reply.send(work(owner));
    });
    let gone = |_| Error::new(E_FAIL, "The Windows shell stopped answering");
    worker.sender.send(job).map_err(|_| Error::from(E_FAIL))?;
    unsafe { PostMessageW(Some(HWND(worker.window as _)), WAKE, WPARAM(0), LPARAM(0)) }?;
    answer.recv().map_err(gone)?
}

/// Takes text the shell allocated.
unsafe fn take_text(text: PWSTR) -> String {
    let owned = unsafe { text.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(text.as_ptr().cast())) };
    owned
}

struct IdList(*mut ITEMIDLIST);

impl IdList {
    fn of(path: &Path) -> Result<Self> {
        let item: IShellItem = ops::shell_item(path)?;
        unsafe { SHGetIDListFromObject(&item) }.map(Self)
    }
}

impl Drop for IdList {
    fn drop(&mut self) {
        unsafe { ILFree(Some(self.0)) };
    }
}

fn shell_items(paths: &[PathBuf]) -> Result<IShellItemArray> {
    let lists = paths.iter().map(|path| IdList::of(path)).collect::<Result<Vec<_>>>()?;
    let raw: Vec<*const ITEMIDLIST> = lists.iter().map(|list| list.0.cast_const()).collect();
    unsafe { SHCreateShellItemArrayFromIDLists(&raw) }
}

pub fn data_object(paths: &[PathBuf]) -> Result<IDataObject> {
    unsafe { shell_items(paths)?.BindToHandler(None, &BHID_DataObject) }
}

/// An app that can open a file type.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct App {
    /// What `open_with` takes.
    id: String,
    name: String,
    /// Windows suggests it for this type. The rest only say they can open it.
    recommended: bool,
    /// A file whose picture stands for the app, when it has one on disk.
    icon: Option<String>,
}

/// True for a file Windows can start as a program.
fn is_program(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe")) && path.is_file()
}

/// Paths as command lines that each fit under Windows' cap of 32,767 characters, with room for
/// the program's own name. No Windows path holds a quote, so wrapping each is enough.
fn quoted(paths: &[PathBuf]) -> Vec<String> {
    let mut lines = vec![String::new()];
    for path in paths {
        let wrapped = format!("\"{}\"", path.display());
        let line = lines.last_mut().expect("never empty");
        if !line.is_empty() && line.len() + 1 + wrapped.len() > COMMAND_LINE_MOST {
            lines.push(wrapped);
        } else {
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(&wrapped);
        }
    }
    lines
}

/// Under Windows' 32,767 characters, leaving room for the program's own path.
const COMMAND_LINE_MOST: usize = 30_000;

/// The extension every file shares. Folders and mixed types have no list of apps.
fn shared_extension(paths: &[PathBuf]) -> Option<String> {
    let extension = |path: &PathBuf| {
        let is_folder = ops::sys::stat(path).ok()??.is_dir();
        (!is_folder).then(|| path.extension()?.to_str().map(str::to_lowercase))?
    };
    let first = extension(paths.first()?)?;
    paths.iter().all(|path| extension(path).as_ref() == Some(&first)).then_some(first)
}

fn handlers(extension: &str, filter: ASSOC_FILTER) -> Result<Vec<IAssocHandler>> {
    let dotted = HSTRING::from(format!(".{extension}"));
    let found = unsafe { SHAssocEnumHandlers(&dotted, filter) }?;
    let mut all = Vec::new();
    loop {
        let (mut slot, mut fetched) = ([None], 0);
        let next = unsafe { found.Next(&mut slot, Some(&raw mut fetched)) };
        match slot {
            [Some(handler)] if next.is_ok() && fetched > 0 => all.push(handler),
            _ => return Ok(all),
        }
    }
}

fn app_of(handler: &IAssocHandler) -> Result<App> {
    unsafe {
        let id = take_text(handler.GetName()?);
        let (mut location, mut index) = (PWSTR::null(), 0);
        let shown = handler.GetIconLocation(&raw mut location, &raw mut index);
        let location = shown.is_ok().then(|| take_text(location));
        // A picture inside a DLL or a Store package is not a file the thumbnailer can read.
        let icon = [Some(id.clone()), location].into_iter().flatten().find(|file| {
            let path = Path::new(file);
            is_program(path) || (file.to_lowercase().ends_with(".ico") && path.is_file())
        });
        Ok(App {
            id,
            name: take_text(handler.GetUIName()?),
            recommended: handler.IsRecommended() == S_OK,
            icon,
        })
    }
}

/// The apps Windows recommends for `paths`, or with `all` every app that says it can open
/// them. Empty when they don't share a file type.
pub fn apps_for(paths: Vec<PathBuf>, all: bool) -> Result<Vec<App>> {
    on_worker(move |_| {
        let Some(extension) = shared_extension(&paths) else {
            return Ok(Vec::new());
        };
        let filter = if all { ASSOC_FILTER_NONE } else { ASSOC_FILTER_RECOMMENDED };
        Ok(listed(handlers(&extension, filter)?.iter().filter_map(|handler| app_of(handler).ok()).collect()))
    })
}

/// The apps by name, each name once. An app can register twice, such as by its path and by its
/// class, and the user can't tell those apart, so the one Windows lists first stays.
fn listed(mut apps: Vec<App>) -> Vec<App> {
    let mut seen = std::collections::HashSet::new();
    apps.retain(|app| seen.insert(app.name.to_lowercase()));
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps
}

/// Opens `paths` with the app called `id`. Asking again means no shell object has to wait
/// on the shell thread for the user to choose.
pub fn open_with(paths: Vec<PathBuf>, id: String) -> Result<()> {
    on_worker(move |_| {
        let extension = shared_extension(&paths).ok_or_else(|| Error::from(E_FAIL))?;
        let handlers = handlers(&extension, ASSOC_FILTER_NONE)?;
        let chosen = handlers
            .iter()
            .find(|handler| app_of(handler).is_ok_and(|app| app.id == id))
            .ok_or_else(|| Error::new(E_FAIL, "That app is no longer available"))?;
        unsafe { chosen.Invoke(&data_object(&paths)?) }
    })
}

/// Opens `paths` with the program at `exe`, for an app Windows doesn't list.
pub fn open_with_exe(paths: Vec<PathBuf>, exe: PathBuf) -> Result<()> {
    if !is_program(&exe) {
        return Err(Error::new(E_FAIL, "That is not an app. Pick a file that ends in .exe."));
    }
    if paths.is_empty() || paths.iter().any(|path| !path.is_file()) {
        return Err(Error::new(E_FAIL, "Only files open with an app"));
    }
    // Thousands of files don't fit one command line, so the app starts once per batch.
    let program = HSTRING::from(exe.as_os_str());
    let batches: Vec<HSTRING> = quoted(&paths).iter().map(HSTRING::from).collect();
    on_worker(move |owner| {
        for files in &batches {
            let started = unsafe { ShellExecuteW(Some(owner), w!("open"), &program, files, None, SW_SHOWNORMAL) };
            // Values up to 32 mean it failed.
            if started.0 as isize <= 32 {
                return Err(Error::new(E_FAIL, "Windows could not start that app"));
            }
        }
        Ok(())
    })
}

/// Windows' file picker, for an app that no list has. Nothing when the user backs out.
pub fn browse_app(main: isize) -> Result<Option<String>> {
    on_worker(move |_| unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetFileTypes(&[COMDLG_FILTERSPEC { pszName: w!("Apps"), pszSpec: w!("*.exe") }])?;
        dialog.SetTitle(w!("Choose an app"))?;
        match dialog.Show(Some(HWND(main as _))) {
            Ok(()) => Ok(Some(take_text(dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?))),
            Err(closed) if closed.code() == ERROR_CANCELLED.to_hresult() => Ok(None),
            Err(failure) => Err(failure),
        }
    })
}

/// Windows' file picker for a folder's cover, opened in `start`. Nothing when the user backs out.
pub fn pick_picture(main: isize, start: PathBuf) -> Result<Option<String>> {
    on_worker(move |_| unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
            pszName: w!("Pictures"),
            pszSpec: w!("*.jpg;*.jpeg;*.png;*.gif;*.webp;*.bmp;*.heic;*.avif;*.tif;*.tiff"),
        }])?;
        dialog.SetTitle(w!("Choose a cover"))?;
        // A folder that is gone just leaves Windows' own choice of where to start.
        if let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start.as_os_str()), None) {
            dialog.SetFolder(&folder)?;
        }
        match dialog.Show(Some(HWND(main as _))) {
            Ok(()) => Ok(Some(take_text(dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?))),
            Err(closed) if closed.code() == ERROR_CANCELLED.to_hresult() => Ok(None),
            Err(failure) => Err(failure),
        }
    })
}

/// Windows' folder picker, such as for where restored items go. Nothing when the user backs out.
pub fn pick_folder(main: isize) -> Result<Option<String>> {
    on_worker(move |_| unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS)?;
        dialog.SetTitle(w!("Choose a folder"))?;
        match dialog.Show(Some(HWND(main as _))) {
            Ok(()) => Ok(Some(take_text(dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?))),
            Err(closed) if closed.code() == ERROR_CANCELLED.to_hresult() => Ok(None),
            Err(failure) => Err(failure),
        }
    })
}

/// Windows' file picker for a file of Perli's settings or a palette: to save one as `save_as`, or,
/// with no name, to open one. Nothing when the user backs out.
pub fn pick_settings_file(main: isize, save_as: Option<String>) -> Result<Option<String>> {
    on_worker(move |_| unsafe {
        let class = if save_as.is_some() { &FileSaveDialog } else { &FileOpenDialog };
        let dialog: IFileDialog = CoCreateInstance(class, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetFileTypes(&[COMDLG_FILTERSPEC { pszName: w!("Perli settings and palettes"), pszSpec: w!("*.json") }])?;
        dialog.SetDefaultExtension(w!("json"))?;
        if let Some(name) = &save_as {
            dialog.SetFileName(&HSTRING::from(name.as_str()))?;
        }
        match dialog.Show(Some(HWND(main as _))) {
            Ok(()) => Ok(Some(take_text(dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?))),
            Err(closed) if closed.code() == ERROR_CANCELLED.to_hresult() => Ok(None),
            Err(failure) => Err(failure),
        }
    })
}

/// Windows' own "How do you want to open this?" window, for one file.
pub fn choose_app(path: PathBuf) -> Result<()> {
    on_worker(move |owner| {
        let file = HSTRING::from(path.as_os_str());
        let info = OPENASINFO {
            pcszFile: PCWSTR(file.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_EXEC,
        };
        unsafe { SHOpenWithDialog(Some(owner), &raw const info) }
    })
}

/// A place in Send to.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTarget {
    name: String,
    path: String,
    /// A drive takes a plain Perli copy. The rest are Windows' own targets, such as a zip.
    is_drive: bool,
}

fn send_to_files() -> Vec<SendTarget> {
    let Some(folder) = places::known_folder(&FOLDERID_SendTo) else {
        return Vec::new();
    };
    let files = std::fs::read_dir(folder).into_iter().flatten().flatten();
    let target = |file: std::fs::DirEntry| {
        let path = file.path().to_string_lossy().into_owned();
        (!file.file_name().eq_ignore_ascii_case(SEND_TO_SETTINGS)).then(|| SendTarget {
            name: places::display_name(&path).unwrap_or_else(|| path.clone()),
            path,
            is_drive: false,
        })
    };
    let mut targets: Vec<SendTarget> = files.filter_map(target).collect();
    targets.sort_by_key(|target| target.name.to_lowercase());
    targets
}

pub fn send_targets() -> Result<Vec<SendTarget>> {
    on_worker(|_| {
        let drives = places::removable_drives().into_iter().map(|(name, path)| SendTarget {
            name,
            path,
            is_drive: true,
        });
        Ok(send_to_files().into_iter().chain(drives).collect())
    })
}

/// Drops `paths` on a Send to target, the way Explorer does. Only copy and link are allowed,
/// so a target on the same drive can't take the user's file away.
pub fn send_to(paths: Vec<PathBuf>, target: PathBuf) -> Result<()> {
    on_worker(move |_| unsafe {
        let drop_target: IDropTarget = ops::shell_item(&target)?.BindToHandler(None, &BHID_SFUIObject)?;
        let data = data_object(&paths)?;
        let allowed = DROPEFFECT_COPY | DROPEFFECT_LINK;
        let mut effect: DROPEFFECT = allowed;
        let point = POINTL::default();
        drop_target.DragEnter(&data, MK_LBUTTON, point, &raw mut effect)?;
        if effect == DROPEFFECT_NONE {
            drop_target.DragLeave()?;
            return Err(Error::new(E_FAIL, "That place can't take these items"));
        }
        effect = allowed;
        drop_target.Drop(&data, MK_LBUTTON, point, &raw mut effect)
    })
}

/// What a shell menu or Properties window is for.
pub enum Target {
    Items(Vec<PathBuf>),
    /// The empty space of a folder.
    Folder(PathBuf),
}

impl Target {
    fn context_menu(&self, owner: HWND) -> Result<IContextMenu> {
        unsafe {
            match self {
                Self::Items(paths) => shell_items(paths)?.BindToHandler(None, &BHID_SFUIObject),
                Self::Folder(folder) => {
                    let folder: IShellFolder = ops::shell_item(folder)?.BindToHandler(None, &BHID_SFObject)?;
                    folder.CreateViewObject(owner)
                }
            }
        }
    }

    /// The folder a command from the menu runs in.
    fn directory(&self) -> HSTRING {
        match self {
            Self::Items(paths) => paths.first().and_then(|path| path.parent()),
            Self::Folder(folder) => Some(folder.as_path()),
        }
        .map(HSTRING::from)
        .unwrap_or_default()
    }
}

fn verb_of(menu: &IContextMenu, offset: u32) -> Option<String> {
    let mut text = [0u16; LONGEST_VERB];
    let name = PSTR(text.as_mut_ptr().cast());
    unsafe { menu.GetCommandString(offset as usize, GCS_VERBW, None, name, LONGEST_VERB as u32) }.ok()?;
    let length = text.iter().position(|&unit| unit == 0)?;
    Some(String::from_utf16_lossy(&text[..length]))
}

/// `verb` is both forms of a name, or an offset cast to each.
fn invoke(
    menu: &IContextMenu,
    owner: HWND,
    verb: (PCSTR, PCWSTR),
    point: POINT,
    directory: &HSTRING,
) -> Result<()> {
    let info = CMINVOKECOMMANDINFOEX {
        cbSize: size_of::<CMINVOKECOMMANDINFOEX>() as u32,
        fMask: CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE,
        hwnd: owner,
        lpVerb: verb.0,
        lpVerbW: verb.1,
        lpDirectoryW: PCWSTR(directory.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ptInvoke: point,
        ..Default::default()
    };
    unsafe { menu.InvokeCommand((&raw const info).cast::<CMINVOKECOMMANDINFO>()) }
}

/// Keeps the menu on screen until the user chooses, and gives the offset of the choice.
fn track(popup: windows::Win32::UI::WindowsAndMessaging::HMENU, owner: HWND, main: HWND, point: POINT) -> Option<u32> {
    unsafe {
        // Without this, clicking outside the menu would not close it.
        let _ = SetForegroundWindow(owner);
        let flags = TPM_RETURNCMD | TPM_RIGHTBUTTON;
        let chosen = TrackPopupMenuEx(popup, flags.0, point.x, point.y, owner, None).0 as u32;
        // Windows asks for this after a menu owned by a window that isn't in front.
        let _ = PostMessageW(Some(owner), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = SetForegroundWindow(main);
        chosen.checked_sub(FIRST_COMMAND)
    }
}

fn run_menu(target: &Target, owner: HWND, main: HWND, point: POINT) -> Result<Option<String>> {
    let menu = target.context_menu(owner)?;
    let popup = unsafe { CreatePopupMenu() }?;
    let flags = CMF_NORMAL | CMF_EXPLORE | CMF_CANRENAME;
    let filled = unsafe { menu.QueryContextMenu(popup, 0, FIRST_COMMAND, LAST_COMMAND, flags) };
    let result = filled.ok().and_then(|()| {
        OPEN_MENU.set(Some(menu.clone()));
        let chosen = track(popup, owner, main, point);
        OPEN_MENU.set(None);
        let Some(offset) = chosen else {
            return Ok(None);
        };
        match verb_of(&menu, offset).filter(|verb| OWN_VERBS.contains(&verb.as_str())) {
            Some(verb) => Ok(Some(verb)),
            None => {
                let verb = (PCSTR(offset as usize as *const u8), PCWSTR(offset as usize as *const u16));
                invoke(&menu, owner, verb, point, &target.directory()).map(|()| None)
            }
        }
    });
    let _ = unsafe { DestroyMenu(popup) };
    result
}

/// One item of Windows' own menu, for Perli's menu to show in its own look.
#[derive(Serialize, Debug, Default)]
pub struct Entry {
    /// What to run it by. Items that only open a side menu have none.
    id: Option<u32>,
    label: String,
    /// The item's small picture, as `thumbs::encode` writes one.
    icon: Option<Vec<u8>>,
    divider: bool,
    disabled: bool,
    checked: bool,
    items: Vec<Entry>,
}

/// Perli's menu has these already, in its own way.
const LISTED_ELSEWHERE: [&str; 3] = ["properties", "openas", "sendto"];
/// Side menus inside side menus end somewhere.
const DEEPEST_MENU: u32 = 3;
const LONGEST_LABEL: usize = 260;
/// Below this, a menu picture is one of Windows' own marks and no bitmap.
const FIRST_REAL_BITMAP: isize = 12;

thread_local! {
    /// The menu last listed, kept so a choice from it can run.
    static LISTED: RefCell<Option<(IContextMenu, HMENU, HSTRING)>> = const { RefCell::new(None) };
}

/// Menu text marks its access key with `&` and puts a key hint after a tab.
fn plain_label(text: &str) -> String {
    let text = text.split('\t').next().unwrap_or_default();
    text.replace("&&", "\0").replace('&', "").replace('\0', "&").trim().to_string()
}

/// "Send to" carries no verb, so it is known by what it holds: the files of the Send to folder,
/// whose names are in the user's language just like the menu's.
fn is_send_to(verb: Option<&str>, items: &[Entry], send_to: &[String]) -> bool {
    verb.is_none() && items.iter().any(|item| send_to.contains(&item.label.to_lowercase()))
}

/// `send_to` holds the names of the Send to folder's files, in lower case.
fn read_entries(menu: &IContextMenu, popup: HMENU, depth: u32, send_to: &[String]) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut divider = false;
    for index in 0..unsafe { GetMenuItemCount(Some(popup)) }.max(0) as u32 {
        let mut text = [0u16; LONGEST_LABEL];
        let mut info = MENUITEMINFOW {
            cbSize: size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_FTYPE | MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING | MIIM_BITMAP,
            dwTypeData: PWSTR(text.as_mut_ptr()),
            cch: LONGEST_LABEL as u32,
            ..Default::default()
        };
        if unsafe { GetMenuItemInfoW(popup, index, true, &raw mut info) }.is_err() {
            continue;
        }
        if info.fType.contains(MFT_SEPARATOR) {
            divider = !entries.is_empty();
            continue;
        }
        let label = plain_label(&String::from_utf16_lossy(&text[..info.cch.min(LONGEST_LABEL as u32) as usize]));
        let offset = info.wID.checked_sub(FIRST_COMMAND).filter(|_| info.wID <= LAST_COMMAND);
        let side = !info.hSubMenu.is_invalid();
        // A side menu can carry a verb too: "Open with" says `openas` in every language.
        let verb = offset.and_then(|offset| verb_of(menu, offset));
        let known = |verbs: &[&str]| verb.as_deref().is_some_and(|verb| verbs.contains(&verb.to_lowercase().as_str()));
        // An item with no text draws itself, which only a real Windows menu can show.
        if label.is_empty() || (!side && known(&OWN_VERBS)) || known(&LISTED_ELSEWHERE) {
            continue;
        }
        let items = if side && depth < DEEPEST_MENU {
            // Many side menus are only filled when Windows says they are about to open.
            let _ = forward(WM_INITMENUPOPUP, WPARAM(info.hSubMenu.0 as usize), LPARAM(index as isize));
            read_entries(menu, info.hSubMenu, depth + 1, send_to)
        } else {
            Vec::new()
        };
        if side && (items.is_empty() || is_send_to(verb.as_deref(), &items, send_to)) {
            continue;
        }
        let has_picture = info.hbmpItem.0 as isize >= FIRST_REAL_BITMAP;
        entries.push(Entry {
            id: offset.filter(|_| !side),
            label,
            icon: has_picture.then(|| crate::thumbs::encode(info.hbmpItem).ok()).flatten(),
            divider: std::mem::take(&mut divider),
            disabled: info.fState.contains(MFS_DISABLED),
            checked: info.fState.contains(MFS_CHECKED),
            items,
        });
    }
    entries
}

fn forget_listed() {
    if let Some((_, popup, _)) = LISTED.take() {
        let _ = unsafe { DestroyMenu(popup) };
    }
}

/// What Windows and other apps add to a right click on `target`, without what Perli lists
/// itself. The menu stays alive until the next one is listed, so `run_listed` can run from it.
pub fn list_menu(target: Target) -> Result<Vec<Entry>> {
    on_worker(move |owner| {
        forget_listed();
        let menu = target.context_menu(owner)?;
        let popup = unsafe { CreatePopupMenu() }?;
        let flags = CMF_NORMAL | CMF_EXPLORE | CMF_CANRENAME;
        if let Err(error) = unsafe { menu.QueryContextMenu(popup, 0, FIRST_COMMAND, LAST_COMMAND, flags) }.ok() {
            let _ = unsafe { DestroyMenu(popup) };
            return Err(error);
        }
        OPEN_MENU.set(Some(menu.clone()));
        let send_to: Vec<String> = send_to_files().into_iter().map(|target| target.name.to_lowercase()).collect();
        let entries = read_entries(&menu, popup, 0, &send_to);
        OPEN_MENU.set(None);
        LISTED.set(Some((menu, popup, target.directory())));
        Ok(entries)
    })
}

/// Runs the item `id` of the menu last listed, as if chosen at (`x`, `y`) inside `main`.
pub fn run_listed(id: u32, main: isize, x: i32, y: i32) -> Result<()> {
    on_worker(move |owner| {
        let Some((menu, _, directory)) = LISTED.with_borrow(Clone::clone) else {
            return Err(Error::new(E_FAIL, "That menu is gone"));
        };
        let verb = (PCSTR(id as usize as *const u8), PCWSTR(id as usize as *const u16));
        invoke(&menu, owner, verb, on_screen(HWND(main as _), x, y), &directory)
    })
}

fn on_screen(main: HWND, x: i32, y: i32) -> POINT {
    let mut point = POINT { x, y };
    let _ = unsafe { ClientToScreen(main, &raw mut point) };
    point
}

/// The full Windows menu at (`x`, `y`) in physical pixels inside `main`. Gives the verb when the
/// choice is one the UI should run itself.
pub fn show_menu(target: Target, main: isize, x: i32, y: i32) -> Result<Option<String>> {
    on_worker(move |owner| {
        let main = HWND(main as _);
        run_menu(&target, owner, main, on_screen(main, x, y))
    })
}

/// Windows' Properties window, on the monitor of (`x`, `y`) in physical pixels inside `main`.
pub fn show_properties(target: Target, main: isize, x: i32, y: i32) -> Result<()> {
    // Empty space opens nothing when asked by name, so a folder answers for itself.
    let target = match target {
        Target::Folder(folder) => Target::Items(vec![folder]),
        items => items,
    };
    on_worker(move |owner| {
        let point = on_screen(HWND(main as _), x, y);
        let menu = target.context_menu(owner)?;
        let popup = unsafe { CreatePopupMenu() }?;
        let filled = unsafe { menu.QueryContextMenu(popup, 0, FIRST_COMMAND, LAST_COMMAND, CMF_NORMAL) };
        let verb = (s!("properties"), w!("properties"));
        let shown = filled.ok().and_then(|()| invoke(&menu, owner, verb, point, &target.directory()));
        let _ = unsafe { DestroyMenu(popup) };
        shown
    })
}

/// Ejects a drive the way Explorer's own menu does, so Windows says so when a file is still open.
pub fn eject(drive: PathBuf, main: isize) -> Result<()> {
    let target = Target::Items(vec![drive]);
    on_worker(move |owner| {
        let point = on_screen(HWND(main as _), 0, 0);
        let menu = target.context_menu(owner)?;
        let popup = unsafe { CreatePopupMenu() }?;
        let filled = unsafe { menu.QueryContextMenu(popup, 0, FIRST_COMMAND, LAST_COMMAND, CMF_NORMAL) };
        let verb = (s!("eject"), w!("eject"));
        let ejected = filled.ok().and_then(|()| invoke(&menu, owner, verb, point, &HSTRING::new()));
        let _ = unsafe { DestroyMenu(popup) };
        ejected
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("perli-menus-{name}-{}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_files_of_one_type_share_an_extension() {
        let folder = TempFolder::new("shared");
        let [a, b, c, sub] = ["a.txt", "b.TXT", "c.png", "sub"].map(|name| folder.0.join(name));
        for file in [&a, &b, &c] {
            fs::write(file, "").unwrap();
        }
        fs::create_dir(&sub).unwrap();

        assert_eq!(shared_extension(&[a.clone(), b]).as_deref(), Some("txt"));
        assert_eq!(shared_extension(&[a.clone(), c]), None);
        assert_eq!(shared_extension(&[a, sub]), None);
        assert_eq!(shared_extension(&[]), None);
    }

    #[test]
    fn menu_text_loses_its_access_key_and_key_hint() {
        assert_eq!(plain_label("&Open"), "Open");
        assert_eq!(plain_label("Cu&t\tCtrl+X"), "Cut");
        assert_eq!(plain_label("Fish && Chips"), "Fish & Chips");
    }

    #[test]
    fn windows_own_items_are_listed_without_perlis() {
        let folder = std::env::temp_dir();
        let entries = list_menu(Target::Items(vec![folder])).unwrap();
        let labels: Vec<_> = entries.iter().map(|entry| entry.label.to_lowercase()).collect();
        assert!(!entries.is_empty());
        assert!(entries.iter().all(|entry| !entry.label.is_empty() && (entry.id.is_some() || !entry.items.is_empty())));
        for own in ["cut", "copy", "delete", "rename", "properties"] {
            assert!(!labels.contains(&own.to_string()), "{labels:?}");
        }
    }

    #[test]
    fn open_with_and_send_to_stay_out_of_the_windows_list_in_any_language() {
        let item = |label: &str| Entry { id: Some(1), label: label.into(), ..Default::default() };
        let send_to = ["bluetooth-gerät".to_string()];
        assert!(is_send_to(None, &[item("Desktop"), item("Bluetooth-Gerät")], &send_to));
        assert!(!is_send_to(Some("SevenZip"), &[item("Bluetooth-Gerät")], &send_to));
        assert!(!is_send_to(None, &[item("CRC-32")], &send_to));

        let folder = TempFolder::new("side");
        let file = folder.0.join("a.html");
        fs::write(&file, "").unwrap();
        let entries = list_menu(Target::Items(vec![file])).unwrap();
        let labels: Vec<_> = entries.iter().map(|entry| entry.label.to_lowercase()).collect();
        // This runs on an English Windows; the checks above hold for the others.
        assert!(!labels.contains(&"open with".to_string()) && !labels.contains(&"send to".to_string()), "{labels:?}");
    }

    #[test]
    fn files_make_one_quoted_command_line_and_only_an_exe_is_a_program() {
        let paths = vec![PathBuf::from(r"C:\a b\one.txt"), PathBuf::from(r"C:\two.txt")];
        assert_eq!(quoted(&paths), [r#""C:\a b\one.txt" "C:\two.txt""#]);
        let many: Vec<PathBuf> = (0..2_000).map(|n| PathBuf::from(format!(r"C:\some folder\file {n:05}.txt"))).collect();
        let lines = quoted(&many);
        assert!(lines.len() > 1);
        assert!(lines.iter().all(|line| line.len() <= COMMAND_LINE_MOST));
        assert_eq!(lines.iter().map(|line| line.matches(".txt").count()).sum::<usize>(), 2_000);
        let folder = TempFolder::new("program");
        let text = folder.0.join("note.txt");
        fs::write(&text, "").unwrap();
        assert!(!is_program(&text));
        assert!(!is_program(&folder.0.join("gone.exe")));
        assert!(is_program(&std::env::current_exe().unwrap()));
        assert!(open_with_exe(vec![text.clone()], text.clone()).is_err());
        assert!(open_with_exe(vec![folder.0.clone()], std::env::current_exe().unwrap()).is_err());
    }

    #[test]
    fn an_app_registered_twice_is_listed_once() {
        let app = |id: &str, name: &str| App { id: id.into(), name: name.into(), recommended: true, icon: None };
        let apps = listed(vec![app("b.exe", "Notepad++"), app("x", "Paint"), app("Applications/b.exe", "notepad++")]);
        assert_eq!(apps, [app("b.exe", "Notepad++"), app("x", "Paint")]);
    }

    #[test]
    fn windows_recommends_an_app_for_text_and_none_for_a_folder() {
        let folder = TempFolder::new("apps");
        let file = folder.0.join("a.txt");
        fs::write(&file, "").unwrap();

        let recommended = apps_for(vec![file.clone()], false).unwrap();
        assert!(!recommended.is_empty());
        assert!(apps_for(vec![file], true).unwrap().len() >= recommended.len());
        assert!(apps_for(vec![folder.0.clone()], false).unwrap().is_empty());
    }

    #[test]
    fn send_to_lists_windows_targets_without_its_settings_file() {
        let targets = send_targets().unwrap();
        assert!(targets.iter().any(|target| !target.is_drive));
        assert!(!targets.iter().any(|target| target.path.ends_with(SEND_TO_SETTINGS)));
    }

    #[test]
    fn the_shell_menu_holds_commands_for_items_and_for_empty_space() {
        let folder = TempFolder::new("menu");
        let file = folder.0.join("a.txt");
        fs::write(&file, "").unwrap();

        let filled = on_worker(move |owner| {
            let count = |target: Target| -> Result<i32> {
                let menu = target.context_menu(owner)?;
                let popup = unsafe { CreatePopupMenu() }?;
                unsafe { menu.QueryContextMenu(popup, 0, FIRST_COMMAND, LAST_COMMAND, CMF_NORMAL) }.ok()?;
                let items = unsafe { windows::Win32::UI::WindowsAndMessaging::GetMenuItemCount(Some(popup)) };
                unsafe { DestroyMenu(popup) }?;
                Ok(items)
            };
            Ok((count(Target::Items(vec![file]))?, count(Target::Folder(std::env::temp_dir()))?))
        })
        .unwrap();

        assert!(filled.0 > 0, "no items for a file");
        assert!(filled.1 > 0, "no items for empty space");
    }

    #[test]
    fn a_folder_shortcut_in_send_to_copies_and_leaves_the_source() {
        let folder = TempFolder::new("send");
        let (source, into) = (folder.0.join("a.txt"), folder.0.join("into"));
        fs::write(&source, "hello").unwrap();
        fs::create_dir(&into).unwrap();

        send_to(vec![source.clone()], into.clone()).unwrap();

        // The shell copies in the background.
        let copied = into.join("a.txt");
        for _ in 0..100 {
            if copied.exists() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(copied.exists());
        assert!(source.exists());
    }
}
