//! Files dragged into Perli from any app, and out of it to any app. Windows makes these calls on
//! the main thread while a drag runs, so each one stays quick and the work starts after the drop.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use windows::core::{implement, Ref, Result, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL};
use windows::Win32::System::Ole::{
    IDropSource, IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
    CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE, DROPEFFECT_NONE, MK_ALT,
};
use windows::Win32::System::SystemServices::{MK_CONTROL, MK_RBUTTON, MK_SHIFT, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Shell::{SHCreateDataObject, SHDoDragDrop};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

use crate::folder::BIN_PATH;
use crate::ops::{self, Incoming, Job};
use crate::{clipboard, menus};

/// What the UI hears about a drag over the window, in physical pixels inside it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Event {
    /// A drag came in over the window. `name` is its first file, for the picture Perli draws.
    Enter { count: usize, name: String, folder: bool },
    /// `effect` is what letting go would do there, for the badge on the deck.
    Over { x: i32, y: i32, effect: Option<DropAction> },
    Leave,
    /// `right` means the right button dragged, so the user gets to pick what happens.
    Drop { x: i32, y: i32, right: bool },
}

/// What a drop can do, when the user picks it from a menu.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DropAction {
    Move,
    Copy,
    Link,
}

impl DropAction {
    const ALL: [Self; 3] = [Self::Move, Self::Copy, Self::Link];

    fn effect(self) -> DROPEFFECT {
        match self {
            Self::Move => DROPEFFECT_MOVE,
            Self::Copy => DROPEFFECT_COPY,
            Self::Link => DROPEFFECT_LINK,
        }
    }

    fn of(effect: DROPEFFECT) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.effect() == effect)
    }
}

struct Dropped {
    paths: Vec<PathBuf>,
    keys: MODIFIERKEYS_FLAGS,
    allowed: DROPEFFECT,
    /// In place of `paths`, for files that have none.
    incoming: Option<Incoming>,
}

/// What the UI and the drag share. The UI knows what is under the pointer, and Windows knows
/// what is being dragged.
#[derive(Default)]
pub struct Drags {
    /// The folder under the pointer, which sets the cursor.
    target: Mutex<Option<PathBuf>>,
    /// Waits for the UI to say where the drop landed. A newer drop replaces it.
    dropped: Mutex<Option<Dropped>>,
}

impl Drags {
    pub fn aim(&self, folder: Option<PathBuf>) {
        *self.target.lock().unwrap_or_else(PoisonError::into_inner) = folder;
    }

    /// The job for the last drop, which landed on `folder`. `action` is what the user picked.
    pub fn job(&self, folder: &Path, action: Option<DropAction>) -> Option<Job> {
        let dropped = self.dropped.lock().unwrap_or_else(PoisonError::into_inner).take()?;
        let Dropped { paths: sources, keys, allowed, incoming } = dropped;
        if let Some(incoming) = incoming {
            let folder = folder.to_path_buf();
            return (!is_bin(&folder)).then_some(Job::Receive { incoming, folder });
        }
        let effect = match action {
            Some(action) => Some(action.effect()).filter(|&effect| fits(effect, allowed, &sources, folder))?,
            None => choose(keys, allowed, &sources, folder)?,
        };
        let folder = folder.to_path_buf();
        Some(if is_bin(&folder) {
            Job::Recycle { paths: sources }
        } else if effect == DROPEFFECT_COPY {
            Job::Copy { sources, folder }
        } else if effect == DROPEFFECT_MOVE {
            Job::Move { sources, folder }
        } else {
            Job::Shortcut { sources, folder }
        })
    }

    /// The files of the last drop, taken for the shelf, where they wait and nothing moves.
    /// Files with no paths of their own can't wait, so they give nothing.
    pub fn shelve(&self) -> Vec<PathBuf> {
        let dropped = self.dropped.lock().unwrap_or_else(PoisonError::into_inner).take();
        dropped.filter(|dropped| dropped.incoming.is_none()).map_or_else(Vec::new, |dropped| dropped.paths)
    }

    /// What the last drop can do on `folder`, for the user to pick from.
    // ponytail: a dismissed menu leaves the drop waiting until the next one replaces it, which
    // only ever holds a list of paths or a source that gave up its data.
    pub fn choices(&self, folder: &Path) -> Vec<DropAction> {
        let dropped = self.dropped.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(dropped) = dropped.as_ref() else {
            return Vec::new();
        };
        if dropped.incoming.is_some() {
            return if is_bin(folder) { Vec::new() } else { vec![DropAction::Copy] };
        }
        let fitting = |action: &DropAction| fits(action.effect(), dropped.allowed, &dropped.paths, folder);
        DropAction::ALL.into_iter().filter(fitting).collect()
    }
}

/// Places of Perli's own that only take note of what is dropped: the shelf, the bookmarks bar, a
/// tag. None is a folder, so no job can land there.
#[cfg(test)]
const SHELF: &str = "perli:shelf";

fn is_shelf(folder: &Path) -> bool {
    folder.to_str().is_some_and(|place| place.starts_with("perli:"))
}

fn is_bin(folder: &Path) -> bool {
    folder == Path::new(BIN_PATH)
}

fn lowered(path: &Path) -> PathBuf {
    path.to_string_lossy().to_lowercase().into()
}

fn same_drive(a: &Path, b: &Path) -> bool {
    let root = |path: &Path| lowered(path).components().next().map(|part| part.as_os_str().to_os_string());
    root(a) == root(b)
}

/// What dropping `paths` on `folder` does: Windows' rules, or nothing if it would make no sense.
/// Ctrl copies, Shift moves, Alt or both make shortcuts, and with no key files move on their own
/// drive and copy to another. One file from another drive makes the whole drop a copy, because
/// no original should go without the user asking.
fn choose(
    keys: MODIFIERKEYS_FLAGS,
    allowed: DROPEFFECT,
    paths: &[PathBuf],
    folder: &Path,
) -> Option<DROPEFFECT> {
    paths.first()?;
    if is_shelf(folder) {
        // Nothing moves, and the cursor should say so.
        return [DROPEFFECT_LINK, DROPEFFECT_COPY, DROPEFFECT_MOVE].into_iter().find(|effect| allowed.0 & effect.0 != 0);
    }
    if is_bin(folder) {
        return fits(DROPEFFECT_MOVE, allowed, paths, folder).then_some(DROPEFFECT_MOVE);
    }
    let held = |key: u32| keys.0 & key != 0;
    let (control, shift) = (held(MK_CONTROL.0), held(MK_SHIFT.0));
    let wanted = if held(MK_ALT) || (control && shift) {
        DROPEFFECT_LINK
    } else if control {
        DROPEFFECT_COPY
    } else if shift || paths.iter().all(|path| same_drive(path, folder)) {
        DROPEFFECT_MOVE
    } else {
        DROPEFFECT_COPY
    };
    // The source may not offer every effect, as a file inside a zip can't move.
    let effect = [wanted, DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_LINK]
        .into_iter()
        .find(|effect| allowed.0 & effect.0 != 0)?;
    fits(effect, allowed, paths, folder).then_some(effect)
}

/// True if the source offers `effect` and it makes sense for `paths` on `folder`.
fn fits(effect: DROPEFFECT, allowed: DROPEFFECT, paths: &[PathBuf], folder: &Path) -> bool {
    if paths.is_empty() || allowed.0 & effect.0 == 0 {
        return false;
    }
    if is_bin(folder) {
        return effect == DROPEFFECT_MOVE;
    }
    let folder = lowered(folder);
    let into_itself = paths.iter().any(|path| folder.starts_with(lowered(path)));
    let stays_put = paths.iter().all(|path| path.parent().is_some_and(|parent| lowered(parent) == folder));
    let pointless = (effect != DROPEFFECT_LINK && into_itself) || (effect == DROPEFFECT_MOVE && stays_put);
    !pointless
}

/// The files in a drag. Something like dragged text has none.
fn files_in(data: &IDataObject) -> Vec<PathBuf> {
    let format = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let Ok(mut medium) = (unsafe { data.GetData(&raw const format) }) else {
        return Vec::new();
    };
    let bytes = unsafe { clipboard::copy_memory(medium.u.hGlobal) };
    unsafe { ReleaseStgMedium(&raw mut medium) };
    bytes.and_then(|bytes| clipboard::decode(&bytes)).unwrap_or_default()
}

struct Hover {
    paths: Vec<PathBuf>,
    /// A source of files with no paths, when `paths` is empty.
    source: Option<IDataObject>,
    allowed: DROPEFFECT,
    /// Windows only says which button dragged while it is held, and it is gone by the drop.
    right: bool,
    /// Where the UI last heard about, and what a drop there would do.
    told: Option<(POINT, Option<DropAction>)>,
}

impl Hover {
    fn over(data: Option<&IDataObject>, keys: MODIFIERKEYS_FLAGS, allowed: DROPEFFECT) -> Option<Self> {
        let paths = data.map(files_in).unwrap_or_default();
        let source = data.filter(|data| paths.is_empty() && ops::offers_files(data)).cloned();
        let right = keys.0 & MK_RBUTTON.0 != 0;
        (!paths.is_empty() || source.is_some()).then_some(Self { paths, source, allowed, right, told: None })
    }

    /// Files with no paths can only be copied out of where they are, and never to the bin.
    fn effect(&self, keys: MODIFIERKEYS_FLAGS, folder: &Path) -> Option<DROPEFFECT> {
        if self.source.is_some() {
            let takes = !is_bin(folder) && !is_shelf(folder);
            return (self.allowed.0 & DROPEFFECT_COPY.0 != 0 && takes).then_some(DROPEFFECT_COPY);
        }
        choose(keys, self.allowed, &self.paths, folder)
    }
}

#[implement(IDropTarget)]
struct Target {
    window: HWND,
    drags: Arc<Drags>,
    listener: Box<dyn Fn(Event)>,
    hover: RefCell<Option<Hover>>,
}

impl Target {
    fn new(window: HWND, drags: Arc<Drags>, listener: Box<dyn Fn(Event)>) -> Self {
        Self {
            window,
            drags,
            listener,
            hover: RefCell::new(None),
        }
    }

    fn inside(&self, point: &POINTL) -> POINT {
        let mut inside = POINT { x: point.x, y: point.y };
        let _ = unsafe { ScreenToClient(self.window, &raw mut inside) };
        inside
    }

    fn effect(&self, keys: MODIFIERKEYS_FLAGS) -> DROPEFFECT {
        let folder = self.drags.target.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let hover = self.hover.borrow();
        hover
            .as_ref()
            .zip(folder)
            .and_then(|(hover, folder)| hover.effect(keys, &folder))
            .unwrap_or(DROPEFFECT_NONE)
    }

    /// Windows keeps asking while the pointer rests, and the UI only needs to hear about moves,
    /// and about a key that turns a move into a copy. The UI names the folder after it hears,
    /// so a resting pointer's next ask is what brings that folder's effect.
    fn tell_where(&self, at: POINT, shown: DROPEFFECT) {
        let told = (at, DropAction::of(shown));
        let mut hover = self.hover.borrow_mut();
        let Some(hover) = hover.as_mut().filter(|hover| hover.told != Some(told)) else {
            return;
        };
        hover.told = Some(told);
        (self.listener)(Event::Over { x: at.x, y: at.y, effect: told.1 });
    }

    fn end(&self) -> Option<Hover> {
        self.drags.aim(None);
        self.hover.take()
    }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(
        &self,
        data: Ref<IDataObject>,
        keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        *self.hover.borrow_mut() = Hover::over(data.as_ref(), keys, unsafe { *effect });
        let shown = self.effect(keys);
        unsafe { *effect = shown };
        // Over Perli the page draws the dragged files itself, as a deck that follows the pointer,
        // so Windows' picture of them is not asked for here. Other windows still show it.
        if let Some(hover) = self.hover.borrow().as_ref() {
            let first = hover.paths.first();
            (self.listener)(Event::Enter {
                count: hover.paths.len(),
                name: first.and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
                folder: first.is_some_and(|path| path.is_dir()),
            });
        }
        self.tell_where(self.inside(point), shown);
        Ok(())
    }

    fn DragOver(&self, keys: MODIFIERKEYS_FLAGS, point: &POINTL, effect: *mut DROPEFFECT) -> Result<()> {
        let shown = self.effect(keys);
        unsafe { *effect = shown };
        self.tell_where(self.inside(point), shown);
        Ok(())
    }

    fn DragLeave(&self) -> Result<()> {
        if self.end().is_some() {
            (self.listener)(Event::Leave);
        }
        Ok(())
    }

    fn Drop(
        &self,
        _data: Ref<IDataObject>,
        keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        let shown = self.effect(keys);
        // Perli's own job does the work, so the source must not delete anything itself.
        unsafe { *effect = DROPEFFECT_NONE };
        if let Some(Hover { paths, source, allowed, right, .. }) = self.end() {
            let source = source.filter(|_| shown != DROPEFFECT_NONE);
            let incoming = source.and_then(|data| Incoming::take_over(&data).ok());
            *self.drags.dropped.lock().unwrap_or_else(PoisonError::into_inner) =
                Some(Dropped { paths, keys, allowed, incoming });
            let at = self.inside(point);
            (self.listener)(Event::Drop { x: at.x, y: at.y, right });
        }
        Ok(())
    }
}

unsafe extern "system" fn add_child(child: HWND, children: LPARAM) -> BOOL {
    unsafe { (*(children.0 as *mut Vec<HWND>)).push(child) };
    true.into()
}

/// Takes drops over from wry, which has already told the web view to leave them alone and put a
/// target of its own on these windows, the ones Windows asks. Tauri's own drop only hands over
/// paths, with no keys and no say in the cursor. Call it on the main thread, once the web view
/// exists.
pub fn attach(main: isize, drags: Arc<Drags>, listener: impl Fn(Event) + 'static) {
    let main = HWND(main as _);
    let mut children: Vec<HWND> = Vec::new();
    let list = LPARAM((&raw mut children) as isize);
    let _ = unsafe { EnumChildWindows(Some(main), Some(add_child), list) };

    let target: IDropTarget = Target::new(main, drags, Box::new(listener)).into();
    for child in children {
        unsafe {
            let _ = RevokeDragDrop(child);
            let _ = RegisterDragDrop(child, &target);
        }
    }
}

/// Past this many files a drag only lists their paths, because asking the shell about each one
/// on the main thread takes seconds. Any program that takes dropped files reads the list.
const SHELL_DRAG_MOST: usize = 2_000;

/// A data object that holds only the list of paths, the way the clipboard does.
fn paths_only(paths: &[PathBuf]) -> Result<IDataObject> {
    let data: IDataObject = unsafe { SHCreateDataObject(None, None, None::<&IDataObject>) }?;
    let format = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: unsafe { clipboard::global(&clipboard::encode(paths)) }? },
        pUnkForRelease: std::mem::ManuallyDrop::new(None),
    };
    // With `true` the data object owns the memory from here.
    unsafe { data.SetData(&raw const format, &raw const medium, true) }?;
    Ok(data)
}

/// Starts a drag of `paths` out of Perli and runs until the user lets go. Whatever takes the
/// files does any moving itself, so there is nothing to do here afterward.
pub fn start(paths: &[PathBuf], main: isize) -> Result<()> {
    let data = if paths.len() > SHELL_DRAG_MOST { paths_only(paths)? } else { menus::data_object(paths)? };
    let allowed = DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK;
    unsafe { SHDoDragDrop(Some(HWND(main as _)), &data, None::<&IDropSource>, allowed) }.map(drop)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::rc::Rc;
    use std::sync::MutexGuard;

    use windows::core::w;
    use windows::Win32::Foundation::DRAGDROP_E_ALREADYREGISTERED;
    use windows::Win32::System::Ole::OleInitialize;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, WINDOW_EX_STYLE, WS_CHILD, WS_POPUP,
    };

    use super::*;
    use crate::ops::Com;

    const NO_KEYS: MODIFIERKEYS_FLAGS = MODIFIERKEYS_FLAGS(0);
    const ALT: MODIFIERKEYS_FLAGS = MODIFIERKEYS_FLAGS(MK_ALT);
    const ANY: DROPEFFECT = DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0 | DROPEFFECT_LINK.0);

    fn on_c() -> Vec<PathBuf> {
        vec![PathBuf::from(r"C:\from\a.txt")]
    }

    #[test]
    fn a_drag_of_many_files_lists_their_paths() {
        let _com = Com::enter();
        let paths: Vec<PathBuf> = (0..SHELL_DRAG_MOST + 1).map(|n| PathBuf::from(format!(r"C:\from\{n}.txt"))).collect();
        assert_eq!(files_in(&paths_only(&paths).unwrap()), paths);
    }

    #[test]
    fn with_no_key_files_move_on_their_drive_and_copy_to_another() {
        assert_eq!(choose(NO_KEYS, ANY, &on_c(), Path::new(r"c:\to")), Some(DROPEFFECT_MOVE));
        assert_eq!(choose(NO_KEYS, ANY, &on_c(), Path::new(r"D:\to")), Some(DROPEFFECT_COPY));
    }

    #[test]
    fn files_from_two_drives_copy_whichever_comes_first() {
        let (c, d) = (PathBuf::from(r"C:\from\a.txt"), PathBuf::from(r"D:\from\b.txt"));
        let to_c = Path::new(r"C:\to");

        for files in [[c.clone(), d.clone()], [d.clone(), c.clone()]] {
            assert_eq!(choose(NO_KEYS, ANY, &files, to_c), Some(DROPEFFECT_COPY));
            assert_eq!(choose(MK_SHIFT, ANY, &files, to_c), Some(DROPEFFECT_MOVE));
        }
    }

    #[test]
    fn keys_pick_what_a_drop_does() {
        let both = MODIFIERKEYS_FLAGS(MK_CONTROL.0 | MK_SHIFT.0);
        let on = |keys, folder: &str| choose(keys, ANY, &on_c(), Path::new(folder));
        assert_eq!(on(MK_CONTROL, r"C:\to"), Some(DROPEFFECT_COPY));
        assert_eq!(on(MK_SHIFT, r"D:\to"), Some(DROPEFFECT_MOVE));
        assert_eq!(on(ALT, r"C:\to"), Some(DROPEFFECT_LINK));
        assert_eq!(on(both, r"C:\to"), Some(DROPEFFECT_LINK));
    }

    #[test]
    fn a_source_that_only_copies_never_gets_a_move() {
        assert_eq!(choose(MK_SHIFT, DROPEFFECT_COPY, &on_c(), Path::new(r"C:\to")), Some(DROPEFFECT_COPY));
        assert_eq!(choose(NO_KEYS, DROPEFFECT_NONE, &on_c(), Path::new(r"C:\to")), None);
    }

    #[test]
    fn a_folder_cannot_go_into_itself_and_a_move_home_does_nothing() {
        let folder = vec![PathBuf::from(r"C:\Top")];
        assert_eq!(choose(NO_KEYS, ANY, &folder, Path::new(r"C:\top")), None);
        assert_eq!(choose(MK_CONTROL, ANY, &folder, Path::new(r"c:\TOP\inner")), None);
        assert_eq!(choose(ALT, ANY, &folder, Path::new(r"C:\Top")), Some(DROPEFFECT_LINK));

        assert_eq!(choose(NO_KEYS, ANY, &on_c(), Path::new(r"C:\From")), None);
        assert_eq!(choose(MK_CONTROL, ANY, &on_c(), Path::new(r"C:\from")), Some(DROPEFFECT_COPY));
        // A longer name that only starts the same is another folder.
        assert_eq!(choose(NO_KEYS, ANY, &folder, Path::new(r"C:\Top2")), Some(DROPEFFECT_MOVE));
    }

    /// Windows' drag picture helper crashes when two threads run drags at once. The app only has
    /// one target, on the main thread.
    static ONE_DRAG: Mutex<()> = Mutex::new(());

    struct Scene {
        folder: PathBuf,
        file: PathBuf,
        _com: Com,
        _turn: MutexGuard<'static, ()>,
    }

    impl Scene {
        fn new(name: &str) -> Self {
            let _turn = ONE_DRAG.lock().unwrap_or_else(PoisonError::into_inner);
            let _com = Com::enter();
            let folder = std::env::temp_dir().join(format!("perli-drag-{name}-{}", std::process::id()));
            fs::create_dir_all(folder.join("into")).unwrap();
            let file = folder.join("a.txt");
            fs::write(&file, "dragged").unwrap();
            Self { folder, file, _com, _turn }
        }
    }

    impl Drop for Scene {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.folder);
        }
    }

    #[test]
    fn a_drag_of_files_shows_their_paths() {
        let scene = Scene::new("paths");
        let data = menus::data_object(&[scene.file.clone(), scene.folder.join("into")]).unwrap();

        let names: Vec<_> = files_in(&data).iter().map(|path| path.file_name().unwrap().to_owned()).collect();
        assert_eq!(names, ["a.txt", "into"]);
    }

    /// Windows' side of a whole drag, on a real data object, with the UI played by hand.
    #[test]
    fn a_drag_follows_the_ui_and_leaves_the_source_alone() {
        let scene = Scene::new("flow");
        let into = scene.folder.join("into");
        let data = menus::data_object(&[scene.file.clone()]).unwrap();
        let drags = Arc::new(Drags::default());
        let heard = Rc::new(RefCell::new(Vec::new()));
        let log = heard.clone();
        let target: IDropTarget =
            Target::new(HWND::default(), drags.clone(), Box::new(move |event| log.borrow_mut().push(event))).into();
        let (place, other) = (POINTL { x: 5, y: 6 }, POINTL { x: 7, y: 8 });

        let mut effect = ANY;
        unsafe { target.DragEnter(&data, NO_KEYS, place, &raw mut effect) }.unwrap();
        assert_eq!(effect, DROPEFFECT_NONE, "no folder is under the pointer yet");

        drags.aim(Some(into.clone()));
        effect = ANY;
        unsafe { target.DragOver(NO_KEYS, place, &raw mut effect) }.unwrap();
        assert_eq!(effect, DROPEFFECT_MOVE);
        effect = ANY;
        unsafe { target.DragOver(MK_CONTROL, other, &raw mut effect) }.unwrap();
        assert_eq!(effect, DROPEFFECT_COPY);
        effect = ANY;
        unsafe { target.DragOver(MK_CONTROL, other, &raw mut effect) }.unwrap();

        effect = ANY;
        unsafe { target.Drop(&data, MK_CONTROL, other, &raw mut effect) }.unwrap();
        assert_eq!(effect, DROPEFFECT_NONE, "a source must never delete after a Perli drop");
        assert_eq!(
            *heard.borrow(),
            [
                Event::Enter { count: 1, name: "a.txt".into(), folder: false },
                Event::Over { x: 5, y: 6, effect: None },
                // The same spot again, once the UI named the folder under it.
                Event::Over { x: 5, y: 6, effect: Some(DropAction::Move) },
                // A rest at the same spot with the same key says nothing new.
                Event::Over { x: 7, y: 8, effect: Some(DropAction::Copy) },
                Event::Drop { x: 7, y: 8, right: false }
            ]
        );

        match drags.job(&into, None) {
            Some(Job::Copy { sources, folder }) => {
                assert_eq!(sources.len(), 1);
                assert_eq!(folder, into);
            }
            _ => panic!("expected a copy"),
        }
        assert!(drags.job(&into, None).is_none(), "a drop runs once");
    }

    #[test]
    fn the_bin_takes_files_whatever_keys_are_held() {
        let bin = Path::new(BIN_PATH);
        for keys in [NO_KEYS, MK_CONTROL, MK_SHIFT, ALT] {
            assert_eq!(choose(keys, ANY, &on_c(), bin), Some(DROPEFFECT_MOVE));
        }
        assert_eq!(choose(NO_KEYS, DROPEFFECT_COPY, &on_c(), bin), None, "the source must allow losing them");
    }

    /// Drops `paths` by hand, as Windows would have.
    fn dropped(paths: Vec<PathBuf>) -> Drags {
        let drags = Drags::default();
        let held = Dropped { paths, keys: NO_KEYS, allowed: ANY, incoming: None };
        *drags.dropped.lock().unwrap() = Some(held);
        drags
    }

    #[test]
    fn the_shelf_takes_the_dropped_paths_and_leaves_no_drop_behind() {
        let drags = dropped(on_c());
        assert_eq!(drags.shelve(), on_c());
        assert!(drags.shelve().is_empty());
        assert!(drags.job(Path::new(r"D:\there"), None).is_none());
    }

    #[test]
    fn the_shelf_never_shows_a_move_while_a_link_or_copy_is_on_offer() {
        let all = DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0 | DROPEFFECT_LINK.0);
        let none = MODIFIERKEYS_FLAGS(0);
        assert_eq!(choose(none, all, &on_c(), Path::new(SHELF)), Some(DROPEFFECT_LINK));
        assert_eq!(choose(none, DROPEFFECT_COPY, &on_c(), Path::new(SHELF)), Some(DROPEFFECT_COPY));
        assert_eq!(choose(none, all, &[], Path::new(SHELF)), None);
    }

    #[test]
    fn a_drop_on_the_bin_recycles() {
        match dropped(on_c()).job(Path::new(BIN_PATH), None) {
            Some(Job::Recycle { paths }) => assert_eq!(paths, on_c()),
            _ => panic!("expected a recycle"),
        }
    }

    #[test]
    fn a_right_drag_offers_what_makes_sense_and_does_what_was_picked() {
        let into = Path::new(r"C:\to");
        assert_eq!(dropped(on_c()).choices(into), DropAction::ALL);
        assert_eq!(dropped(on_c()).choices(Path::new(r"C:\from")), [DropAction::Copy, DropAction::Link]);
        assert_eq!(dropped(on_c()).choices(Path::new(BIN_PATH)), [DropAction::Move]);

        assert!(matches!(dropped(on_c()).job(into, Some(DropAction::Link)), Some(Job::Shortcut { .. })));
        assert!(matches!(dropped(on_c()).job(into, Some(DropAction::Copy)), Some(Job::Copy { .. })));
        assert!(matches!(dropped(on_c()).job(Path::new(r"D:\to"), Some(DropAction::Move)), Some(Job::Move { .. })));
        assert!(dropped(on_c()).job(Path::new(r"C:\from"), Some(DropAction::Move)).is_none());
    }

    #[test]
    fn the_right_button_is_remembered_from_the_start_of_the_drag() {
        let scene = Scene::new("right");
        let into = scene.folder.join("into");
        let data = menus::data_object(&[scene.file.clone()]).unwrap();
        let drags = Arc::new(Drags::default());
        let heard = Rc::new(RefCell::new(Vec::new()));
        let log = heard.clone();
        let target: IDropTarget =
            Target::new(HWND::default(), drags.clone(), Box::new(move |event| log.borrow_mut().push(event))).into();
        let at = POINTL { x: 1, y: 2 };

        let mut effect = ANY;
        unsafe { target.DragEnter(&data, MODIFIERKEYS_FLAGS(MK_RBUTTON.0), at, &raw mut effect) }.unwrap();
        drags.aim(Some(into.clone()));
        effect = ANY;
        unsafe { target.Drop(&data, NO_KEYS, at, &raw mut effect) }.unwrap();

        assert_eq!(heard.borrow().last(), Some(&Event::Drop { x: 1, y: 2, right: true }));
        assert_eq!(drags.choices(&into), DropAction::ALL);
    }

    /// Plain windows stand in for the web view's, with wry's target on one of them.
    #[test]
    fn attaching_replaces_the_target_on_every_window_inside() {
        unsafe { OleInitialize(None) }.unwrap();
        let window = |style, parent| unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), None, style, 0, 0, 1, 1, parent, None, None, None)
                .unwrap()
        };
        let main = window(WS_POPUP, None);
        let child = window(WS_CHILD, Some(main));
        let inner = window(WS_CHILD, Some(child));
        let wry = Rc::new(());
        let held = wry.clone();
        let drags = Arc::new(Drags::default());
        let old: IDropTarget = Target::new(HWND::default(), drags.clone(), Box::new(move |_| drop(held.clone()))).into();
        unsafe { RegisterDragDrop(child, &old) }.unwrap();

        attach(main.0 as isize, drags, |_| ());

        assert_eq!(unsafe { RegisterDragDrop(inner, &old) }, Err(DRAGDROP_E_ALREADYREGISTERED.into()));
        drop(old);
        assert_eq!(Rc::strong_count(&wry), 1, "Windows let go of the old target");
    }

    #[test]
    fn leaving_forgets_the_drag() {
        let scene = Scene::new("leave");
        let data = menus::data_object(&[scene.file.clone()]).unwrap();
        let drags = Arc::new(Drags::default());
        let target: IDropTarget = Target::new(HWND::default(), drags.clone(), Box::new(|_| ())).into();

        let mut effect = ANY;
        unsafe { target.DragEnter(&data, NO_KEYS, POINTL::default(), &raw mut effect) }.unwrap();
        drags.aim(Some(scene.folder.join("into")));
        unsafe { target.DragLeave() }.unwrap();

        assert!(drags.target.lock().unwrap().is_none());
        assert!(drags.job(&scene.folder, None).is_none());
    }
}
