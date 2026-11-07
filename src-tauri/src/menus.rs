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
use windows::Win32::Foundation::{E_FAIL, HWND, LPARAM, LRESULT, POINT, POINTL, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{CoTaskMemFree, IDataObject};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
use windows::Win32::System::Ole::{
    IDropTarget, OleInitialize, OleUninitialize, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK,
    DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MK_LBUTTON;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    FOLDERID_SendTo, IAssocHandler, IContextMenu, IContextMenu2, IContextMenu3, IShellFolder,
    IShellItem, IShellItemArray, ILFree, SHAssocEnumHandlers, SHCreateShellItemArrayFromIDLists,
    SHGetIDListFromObject, SHOpenWithDialog, ASSOC_FILTER_RECOMMENDED,
    BHID_DataObject, BHID_SFObject, BHID_SFUIObject, CMF_CANRENAME, CMF_EXPLORE, CMF_NORMAL,
    CMINVOKECOMMANDINFO,
    CMINVOKECOMMANDINFOEX, CMIC_MASK_PTINVOKE, GCS_VERBW, OAIF_ALLOW_REGISTRATION, OAIF_EXEC,
    OPENASINFO, SEE_MASK_UNICODE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DispatchMessageW, GetMessageW,
    PostMessageW, RegisterClassW, SetForegroundWindow, TrackPopupMenuEx, TranslateMessage, MSG,
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

/// An app Windows recommends for a file type.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct App {
    /// What `open_with` takes.
    id: String,
    name: String,
}

/// The extension every file shares. Folders and mixed types have no list of apps.
fn shared_extension(paths: &[PathBuf]) -> Option<String> {
    let extension = |path: &PathBuf| {
        let is_folder = ops::sys::stat(path).ok()??.is_dir();
        (!is_folder).then(|| path.extension()?.to_str().map(str::to_lowercase))?
    };
    let first = extension(paths.first()?)?;
    paths.iter().all(|path| extension(path).as_ref() == Some(&first)).then_some(first)
}

fn handlers(extension: &str) -> Result<Vec<IAssocHandler>> {
    let dotted = HSTRING::from(format!(".{extension}"));
    let found = unsafe { SHAssocEnumHandlers(&dotted, ASSOC_FILTER_RECOMMENDED) }?;
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
        Ok(App {
            id: take_text(handler.GetName()?),
            name: take_text(handler.GetUIName()?),
        })
    }
}

/// The apps Windows recommends for `paths`. Empty when they don't share a file type.
pub fn apps_for(paths: Vec<PathBuf>) -> Result<Vec<App>> {
    on_worker(move |_| {
        let Some(extension) = shared_extension(&paths) else {
            return Ok(Vec::new());
        };
        let mut apps: Vec<App> = handlers(&extension)?.iter().filter_map(|handler| app_of(handler).ok()).collect();
        apps.sort_by_key(|app| app.name.to_lowercase());
        Ok(apps)
    })
}

/// Opens `paths` with the app called `id`. Asking again means no shell object has to wait
/// on the shell thread for the user to choose.
pub fn open_with(paths: Vec<PathBuf>, id: String) -> Result<()> {
    on_worker(move |_| {
        let extension = shared_extension(&paths).ok_or_else(|| Error::from(E_FAIL))?;
        let handlers = handlers(&extension)?;
        let chosen = handlers
            .iter()
            .find(|handler| app_of(handler).is_ok_and(|app| app.id == id))
            .ok_or_else(|| Error::new(E_FAIL, "That app is no longer available"))?;
        unsafe { chosen.Invoke(&data_object(&paths)?) }
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
    fn windows_recommends_an_app_for_text_and_none_for_a_folder() {
        let folder = TempFolder::new("apps");
        let file = folder.0.join("a.txt");
        fs::write(&file, "").unwrap();

        assert!(!apps_for(vec![file]).unwrap().is_empty());
        assert!(apps_for(vec![folder.0.clone()]).unwrap().is_empty());
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
