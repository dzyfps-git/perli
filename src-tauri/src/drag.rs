//! Files dragged into Perli from any app, and out of it to any app. Windows makes these calls on
//! the main thread while a drag runs, so each one stays quick and the work starts after the drop.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use windows::core::{implement, Ref, Result, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{
    CoCreateInstance, IDataObject, CLSCTX_INPROC_SERVER, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
};
use windows::Win32::System::Ole::{
    IDropSource, IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
    CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE, DROPEFFECT_NONE, MK_ALT,
};
use windows::Win32::System::SystemServices::{MK_CONTROL, MK_SHIFT, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Shell::{CLSID_DragDropHelper, IDropTargetHelper, SHDoDragDrop};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

use crate::ops::Job;
use crate::{clipboard, menus};

/// What the UI hears about a drag over the window, in physical pixels inside it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Event {
    Over { x: i32, y: i32 },
    Leave,
    Drop { x: i32, y: i32 },
}

struct Dropped {
    paths: Vec<PathBuf>,
    keys: MODIFIERKEYS_FLAGS,
    allowed: DROPEFFECT,
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

    /// The job for the last drop, which landed on `folder`.
    pub fn job(&self, folder: &Path) -> Option<Job> {
        let dropped = self.dropped.lock().unwrap_or_else(PoisonError::into_inner).take()?;
        let Dropped { paths: sources, keys, allowed } = dropped;
        let effect = choose(keys, allowed, &sources, folder)?;
        let folder = folder.to_path_buf();
        Some(if effect == DROPEFFECT_COPY {
            Job::Copy { sources, folder }
        } else if effect == DROPEFFECT_MOVE {
            Job::Move { sources, folder }
        } else {
            Job::Shortcut { sources, folder }
        })
    }
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

    let folder = lowered(folder);
    let into_itself = paths.iter().any(|path| folder.starts_with(lowered(path)));
    let stays_put = paths.iter().all(|path| path.parent().is_some_and(|parent| lowered(parent) == folder));
    let pointless = (effect != DROPEFFECT_LINK && into_itself) || (effect == DROPEFFECT_MOVE && stays_put);
    (!pointless).then_some(effect)
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
    allowed: DROPEFFECT,
    /// Where the UI last heard about.
    at: Option<POINT>,
}

#[implement(IDropTarget)]
struct Target {
    window: HWND,
    drags: Arc<Drags>,
    listener: Box<dyn Fn(Event)>,
    /// Draws the picture of what is being dragged over Perli.
    helper: Option<IDropTargetHelper>,
    hover: RefCell<Option<Hover>>,
}

impl Target {
    fn new(window: HWND, drags: Arc<Drags>, listener: Box<dyn Fn(Event)>) -> Self {
        Self {
            window,
            drags,
            listener,
            helper: unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) }.ok(),
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
            .and_then(|(hover, folder)| choose(keys, hover.allowed, &hover.paths, &folder))
            .unwrap_or(DROPEFFECT_NONE)
    }

    /// Windows keeps asking while the pointer rests, and the UI only needs to hear about moves.
    fn tell_where(&self, at: POINT) {
        let mut hover = self.hover.borrow_mut();
        let Some(hover) = hover.as_mut().filter(|hover| hover.at != Some(at)) else {
            return;
        };
        hover.at = Some(at);
        (self.listener)(Event::Over { x: at.x, y: at.y });
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
        let paths = data.as_ref().map(files_in).unwrap_or_default();
        let allowed = unsafe { *effect };
        *self.hover.borrow_mut() = (!paths.is_empty()).then_some(Hover { paths, allowed, at: None });
        let shown = self.effect(keys);
        unsafe { *effect = shown };
        if let (Some(helper), Some(data)) = (&self.helper, data.as_ref()) {
            let screen = POINT { x: point.x, y: point.y };
            let _ = unsafe { helper.DragEnter(self.window, data, &raw const screen, shown) };
        }
        self.tell_where(self.inside(point));
        Ok(())
    }

    fn DragOver(&self, keys: MODIFIERKEYS_FLAGS, point: &POINTL, effect: *mut DROPEFFECT) -> Result<()> {
        let shown = self.effect(keys);
        unsafe { *effect = shown };
        if let Some(helper) = &self.helper {
            let screen = POINT { x: point.x, y: point.y };
            let _ = unsafe { helper.DragOver(&raw const screen, shown) };
        }
        self.tell_where(self.inside(point));
        Ok(())
    }

    fn DragLeave(&self) -> Result<()> {
        if let Some(helper) = &self.helper {
            let _ = unsafe { helper.DragLeave() };
        }
        if self.end().is_some() {
            (self.listener)(Event::Leave);
        }
        Ok(())
    }

    fn Drop(
        &self,
        data: Ref<IDataObject>,
        keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        let shown = self.effect(keys);
        if let (Some(helper), Some(data)) = (&self.helper, data.as_ref()) {
            let screen = POINT { x: point.x, y: point.y };
            let _ = unsafe { helper.Drop(data, &raw const screen, shown) };
        }
        // Perli's own job does the work, so the source must not delete anything itself.
        unsafe { *effect = DROPEFFECT_NONE };
        if let Some(Hover { paths, allowed, .. }) = self.end() {
            *self.drags.dropped.lock().unwrap_or_else(PoisonError::into_inner) =
                Some(Dropped { paths, keys, allowed });
            let at = self.inside(point);
            (self.listener)(Event::Drop { x: at.x, y: at.y });
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

/// Starts a drag of `paths` out of Perli and runs until the user lets go. Whatever takes the
/// files does any moving itself, so there is nothing to do here afterward.
// ponytail: asks the shell about each path on the main thread, which is slow past some thousands
// of rows. A data object of Perli's own that only lists paths would not be.
pub fn start(paths: &[PathBuf], main: isize) -> Result<()> {
    let data = menus::data_object(paths)?;
    let allowed = DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK;
    unsafe { SHDoDragDrop(Some(HWND(main as _)), &data, None::<&IDropSource>, allowed) }.map(drop)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::rc::Rc;

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

    struct Scene {
        folder: PathBuf,
        file: PathBuf,
        _com: Com,
    }

    impl Scene {
        fn new(name: &str) -> Self {
            let _com = Com::enter();
            let folder = std::env::temp_dir().join(format!("perli-drag-{name}-{}", std::process::id()));
            fs::create_dir_all(folder.join("into")).unwrap();
            let file = folder.join("a.txt");
            fs::write(&file, "dragged").unwrap();
            Self { folder, file, _com }
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
        unsafe { target.Drop(&data, MK_CONTROL, other, &raw mut effect) }.unwrap();
        assert_eq!(effect, DROPEFFECT_NONE, "a source must never delete after a Perli drop");
        assert_eq!(
            *heard.borrow(),
            [Event::Over { x: 5, y: 6 }, Event::Over { x: 7, y: 8 }, Event::Drop { x: 7, y: 8 }]
        );

        match drags.job(&into) {
            Some(Job::Copy { sources, folder }) => {
                assert_eq!(sources.len(), 1);
                assert_eq!(folder, into);
            }
            _ => panic!("expected a copy"),
        }
        assert!(drags.job(&into).is_none(), "a drop runs once");
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
        assert!(drags.job(&scene.folder).is_none());
    }
}
