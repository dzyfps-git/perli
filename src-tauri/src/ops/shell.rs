//! The work only the Windows shell can do: the Recycle Bin and admin-protected folders.

use std::mem;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use windows::core::{implement, Error, Ref, Result, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{E_FAIL, HWND, S_OK};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::{
    FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
    IShellItem, SHCreateItemFromParsingName, COPYENGINE_E_USER_CANCELLED,
    COPYENGINE_S_DONT_PROCESS_CHILDREN, FILEOPERATION_FLAGS,
    FOFX_RECYCLEONDELETE, FOFX_REQUIREELEVATION, FOFX_SHOWELEVATIONPROMPT, FOF_ALLOWUNDO,
    FOF_NOCONFIRMMKDIR, FOF_NORECURSEREPARSE, FOF_NO_UI, SIGDN_FILESYSPATH,
    TSF_DELETE_RECYCLE_IF_POSSIBLE,
};

use super::sys;
use super::{Answer, Control, Done, Elevated, Flow, Key, Question, Run};

/// Longest path the shell's name parser takes in plain form.
const MAX_PATH: usize = 259;

/// COM for the life of a job. The shell's operations run on the job's own thread.
pub struct Com(bool);

impl Com {
    pub fn enter() -> Self {
        let flags = COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE;
        Self(unsafe { CoInitializeEx(None, flags) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn shell_item(path: &Path) -> Result<IShellItem> {
    let plain = path.as_os_str().len() <= MAX_PATH;
    let name = if plain { HSTRING::from(path.as_os_str()) } else { sys::extended(path) };
    unsafe { SHCreateItemFromParsingName(&name, None) }
}

fn path_of(item: &IShellItem) -> Result<PathBuf> {
    unsafe {
        let name = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = name.to_hstring();
        CoTaskMemFree(Some(name.as_ptr().cast()));
        Ok(PathBuf::from(path.to_os_string()))
    }
}

/// How one item fared in a recycle pass.
#[derive(Clone, Debug, PartialEq)]
enum Slot {
    Waiting,
    Recycled(PathBuf),
    /// The bin can't take it. Left alone, the shell would delete it for good.
    Refused,
    /// A copy, move or new item the shell says it finished, under the name it really got.
    Finished(PathBuf),
    Failed(HRESULT),
}

/// What a shell report on a copy, move or new item makes of its slot. A skip has a success code
/// too, so only the two codes that mean it worked count: a move within a drive reports the
/// second. A folder reports first and then each child, so a later report can't change the name,
/// and any failure stays.
fn reported(slot: Slot, result: HRESULT, created: Option<PathBuf>) -> Slot {
    let worked = result == S_OK || result == COPYENGINE_S_DONT_PROCESS_CHILDREN;
    match (slot, created) {
        (slot @ Slot::Failed(_), _) => slot,
        (slot @ Slot::Finished(_), _) if worked => slot,
        (_, Some(path)) if worked => Slot::Finished(path),
        _ => Slot::Failed(result),
    }
}

#[implement(IFileOperationProgressSink)]
struct Sink {
    index: usize,
    slots: Arc<Mutex<Vec<Slot>>>,
    control: Arc<Control>,
    recycling: bool,
}

impl Sink_Impl {
    fn set(&self, slot: Slot) {
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        if slots[self.index] != Slot::Refused {
            slots[self.index] = slot;
        }
    }

    fn report(&self, result: HRESULT, created: Ref<IShellItem>) {
        let created = created.ok().and_then(path_of).ok();
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        slots[self.index] = reported(slots[self.index].clone(), result, created);
    }
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn PreDeleteItem(&self, flags: u32, _item: Ref<IShellItem>) -> Result<()> {
        if !self.recycling {
            return Ok(());
        }
        if !self.control.proceed() {
            return Err(COPYENGINE_E_USER_CANCELLED.into());
        }
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            self.set(Slot::Refused);
            return Err(COPYENGINE_E_USER_CANCELLED.into());
        }
        Ok(())
    }

    fn PostDeleteItem(
        &self,
        _flags: u32,
        _item: Ref<IShellItem>,
        result: HRESULT,
        created: Ref<IShellItem>,
    ) -> Result<()> {
        if !self.recycling || result == COPYENGINE_E_USER_CANCELLED {
            return Ok(());
        }
        let in_bin = created.ok().and_then(path_of);
        self.set(match in_bin {
            Ok(path) if result.is_ok() => Slot::Recycled(path),
            // No bin copy means the shell deleted it for good, which must never pass quietly.
            _ if result.is_ok() => Slot::Failed(E_FAIL),
            _ => Slot::Failed(result),
        });
        Ok(())
    }

    fn StartOperations(&self) -> Result<()> {
        Ok(())
    }

    fn FinishOperations(&self, _: HRESULT) -> Result<()> {
        Ok(())
    }

    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> Result<()> {
        Ok(())
    }

    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> Result<()> {
        Ok(())
    }

    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> Result<()> {
        Ok(())
    }

    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        result: HRESULT,
        created: Ref<IShellItem>,
    ) -> Result<()> {
        self.report(result, created);
        Ok(())
    }

    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> Result<()> {
        Ok(())
    }

    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        result: HRESULT,
        created: Ref<IShellItem>,
    ) -> Result<()> {
        self.report(result, created);
        Ok(())
    }

    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> Result<()> {
        Ok(())
    }

    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        result: HRESULT,
        created: Ref<IShellItem>,
    ) -> Result<()> {
        self.report(result, created);
        Ok(())
    }

    fn UpdateProgress(&self, _: u32, _: u32) -> Result<()> {
        Ok(())
    }

    fn ResetTimer(&self) -> Result<()> {
        Ok(())
    }

    fn PauseTimer(&self) -> Result<()> {
        Ok(())
    }

    fn ResumeTimer(&self) -> Result<()> {
        Ok(())
    }
}

fn operation(flags: FILEOPERATION_FLAGS, owner: isize) -> Result<IFileOperation> {
    unsafe {
        let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
        operation.SetOperationFlags(flags)?;
        operation.SetOwnerWindow(HWND(owner as _))?;
        Ok(operation)
    }
}

/// Sends `paths` to the bin, stopping at the first trouble. Each slot tells what became of
/// that path, and any left waiting need another pass.
fn recycle_pass(
    paths: &[PathBuf],
    extra: FILEOPERATION_FLAGS,
    owner: isize,
    control: &Arc<Control>,
) -> Vec<Slot> {
    let slots = Arc::new(Mutex::new(vec![Slot::Waiting; paths.len()]));
    let flags = FILEOPERATION_FLAGS(FOF_NO_UI.0 | FOFX_RECYCLEONDELETE.0 | FOF_ALLOWUNDO.0 | extra.0);
    let performed = operation(flags, owner).and_then(|operation| unsafe {
        for (index, path) in paths.iter().enumerate() {
            let Ok(item) = shell_item(path) else {
                slots.lock().unwrap_or_else(|error| error.into_inner())[index] = Slot::Refused;
                continue;
            };
            let sink: IFileOperationProgressSink = Sink {
                index,
                slots: slots.clone(),
                control: control.clone(),
                recycling: true,
            }
            .into();
            operation.DeleteItem(&item, &sink)?;
        }
        operation.PerformOperations()
    });

    let mut slots = slots.lock().unwrap_or_else(|error| error.into_inner()).clone();
    let troubled = slots.iter().any(|slot| matches!(slot, Slot::Refused | Slot::Failed(_)));
    match performed {
        // Every path had its say, so one still waiting would loop forever.
        Ok(()) => slots
            .iter_mut()
            .filter(|slot| **slot == Slot::Waiting)
            .for_each(|slot| *slot = Slot::Failed(E_FAIL)),
        Err(error) if !troubled => {
            if let Some(slot) = slots.iter_mut().find(|slot| **slot == Slot::Waiting) {
                *slot = Slot::Failed(error.code());
            }
        }
        Err(_) => {}
    }
    slots
}

impl Run<'_> {
    /// Sends `paths` to the Recycle Bin and never deletes for good without asking.
    pub(super) fn recycle(&mut self, paths: Vec<PathBuf>) -> Flow {
        self.recycle_with(paths, FILEOPERATION_FLAGS(0))
    }

    fn recycle_with(&mut self, paths: Vec<PathBuf>, extra: FILEOPERATION_FLAGS) -> Flow {
        // Already gone needs nothing.
        let mut queue: Vec<PathBuf> = paths
            .into_iter()
            .filter(|path| !matches!(sys::stat(path), Ok(None)))
            .collect();
        while !queue.is_empty() {
            self.check()?;
            queue.iter().for_each(|path| sys::guard(path));
            let slots = recycle_pass(&queue, extra, self.host.owner(), self.control);

            let mut waiting = Vec::new();
            let mut trouble = Vec::new();
            for (path, slot) in queue.drain(..).zip(slots) {
                match slot {
                    Slot::Recycled(item) => {
                        self.done.push(Done::Recycled { original: path, item });
                        self.step(1, 0);
                    }
                    Slot::Waiting => waiting.push(path),
                    trouble_slot => trouble.push((path, trouble_slot)),
                }
            }
            // A cancel shows up as a failed item, and must not turn into a prompt.
            self.check()?;
            for (path, slot) in trouble {
                if self.recycle_trouble(&path, slot)? {
                    waiting.push(path);
                } else {
                    self.step(1, 0);
                }
            }
            queue = waiting;
        }
        Ok(())
    }

    /// True if the path should go through another pass.
    fn recycle_trouble(&mut self, path: &Path, slot: Slot) -> Flow<bool> {
        match slot {
            Slot::Failed(code) => match self.problem(path, &Error::from(code), true)? {
                Answer::Retry => Ok(true),
                Answer::Elevate => {
                    self.elevated.push(Elevated::Recycle {
                        path: path.to_path_buf(),
                    });
                    Ok(false)
                }
                _ => Ok(false),
            },
            _ if self.undoing => {
                let question = Question::Problem {
                    path: path.to_string_lossy().into_owned(),
                    message: "The Recycle Bin can't take this, so it stays where it is.".into(),
                    choices: vec![Answer::Skip, Answer::Cancel],
                };
                self.ask(Key::Refused, question)?;
                Ok(false)
            }
            _ => {
                let question = Question::NoBin {
                    path: path.to_string_lossy().into_owned(),
                    choices: vec![Answer::Permanent, Answer::Skip, Answer::Cancel],
                };
                if self.ask(Key::NoBin, question)? == Answer::Permanent {
                    self.delete_paths(&[path.to_path_buf()])?;
                }
                Ok(false)
            }
        }
    }

    /// Runs what needed admin rights as one shell operation, so one UAC prompt covers it all.
    pub(super) fn finish_elevated(&mut self) -> Flow {
        let list = mem::take(&mut self.elevated);
        if list.is_empty() {
            return Ok(());
        }
        let (recycling, others): (Vec<_>, Vec<_>) = list
            .into_iter()
            .partition(|entry| matches!(entry, Elevated::Recycle { .. }));
        let paths = recycling.into_iter().map(|entry| match entry {
            Elevated::Recycle { path } => path,
            _ => unreachable!("partitioned above"),
        });
        let extra = FILEOPERATION_FLAGS(FOFX_REQUIREELEVATION.0 | FOFX_SHOWELEVATIONPROMPT.0);
        self.recycle_with(paths.collect(), extra)?;
        if others.is_empty() {
            return Ok(());
        }

        let slots = Arc::new(Mutex::new(vec![Slot::Waiting; others.len()]));
        let flags = FOF_NOCONFIRMMKDIR.0 | FOF_ALLOWUNDO.0 | FOF_NORECURSEREPARSE.0 | extra.0;
        let performed = perform_elevated(
            &others,
            FILEOPERATION_FLAGS(flags),
            self.host.owner(),
            &slots,
            self.control,
        );
        let slots = slots.lock().unwrap_or_else(|error| error.into_inner()).clone();
        for (entry, slot) in others.into_iter().zip(slots) {
            self.record_elevated(entry, slot);
        }
        if let Err(error) = performed {
            self.refuse(Path::new(""), &error.message())?;
        }
        Ok(())
    }

    /// Only the shell's own report counts. A target that exists proves nothing, because the
    /// user may have told the shell to skip it or keep both, and undo would then remove their
    /// old file.
    fn record_elevated(&mut self, entry: Elevated, slot: Slot) {
        match (entry, slot) {
            (Elevated::Copy { .. } | Elevated::New { .. }, Slot::Finished(path)) => {
                self.done.push(Done::Created { path });
            }
            (Elevated::Move { source, .. }, Slot::Finished(to)) => {
                self.done.push(Done::Moved { from: source, to });
            }
            (Elevated::Delete { path }, _) => {
                self.touched.insert(sys::parent(&path));
            }
            _ => {}
        }
    }
}

fn perform_elevated(
    list: &[Elevated],
    flags: FILEOPERATION_FLAGS,
    owner: isize,
    slots: &Arc<Mutex<Vec<Slot>>>,
    control: &Arc<Control>,
) -> Result<()> {
    let operation = operation(flags, owner)?;
    let name_of = |path: &Path| HSTRING::from(path.file_name().unwrap_or(path.as_os_str()));
    unsafe {
        for (index, entry) in list.iter().enumerate() {
            let sink: IFileOperationProgressSink = Sink {
                index,
                slots: slots.clone(),
                control: control.clone(),
                recycling: false,
            }
            .into();
            match entry {
                Elevated::Copy { source, target } => {
                    let folder = shell_item(&sys::parent(target))?;
                    operation.CopyItem(&shell_item(source)?, &folder, &name_of(target), &sink)?;
                }
                Elevated::Move { source, target } => {
                    let folder = shell_item(&sys::parent(target))?;
                    operation.MoveItem(&shell_item(source)?, &folder, &name_of(target), &sink)?;
                }
                Elevated::New { target, directory } => {
                    let attributes = if *directory {
                        FILE_ATTRIBUTE_DIRECTORY
                    } else {
                        FILE_ATTRIBUTE_NORMAL
                    };
                    let folder = shell_item(&sys::parent(target))?;
                    operation.NewItem(&folder, attributes.0, &name_of(target), None, &sink)?;
                }
                Elevated::Delete { path } | Elevated::Recycle { path } => {
                    operation.DeleteItem(&shell_item(path)?, &sink)?;
                }
            }
        }
        operation.PerformOperations()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use windows::Win32::UI::Shell::{COPYENGINE_S_USER_IGNORED, FOF_RENAMEONCOLLISION};

    use super::super::tests::Sandbox;
    use super::super::Run;
    use super::*;

    #[test]
    fn only_a_plain_success_counts() {
        let made = || Some(PathBuf::from("made"));
        let finished = Slot::Finished(PathBuf::from("made"));

        assert_eq!(reported(Slot::Waiting, S_OK, made()), finished);
        assert_eq!(
            reported(Slot::Waiting, COPYENGINE_S_DONT_PROCESS_CHILDREN, made()),
            finished
        );
        assert_eq!(
            reported(Slot::Waiting, COPYENGINE_S_USER_IGNORED, made()),
            Slot::Failed(COPYENGINE_S_USER_IGNORED)
        );
        assert_eq!(reported(Slot::Waiting, S_OK, None), Slot::Failed(S_OK));
        assert_eq!(reported(Slot::Failed(E_FAIL), S_OK, made()), Slot::Failed(E_FAIL));
        assert_eq!(
            reported(finished.clone(), S_OK, Some(PathBuf::from("child"))),
            finished
        );
        assert_eq!(
            reported(finished, COPYENGINE_S_USER_IGNORED, made()),
            Slot::Failed(COPYENGINE_S_USER_IGNORED)
        );
    }

    // Tests must never pass FOFX_REQUIREELEVATION here, or a real UAC prompt would appear.
    #[test]
    fn undo_records_the_name_the_shell_really_used() {
        let sandbox = Sandbox::new();
        let _com = Com::enter();
        let old = sandbox.file(r"to\a.txt", "old");
        let file = sandbox.file("a.txt", "new");
        let moved = sandbox.file("b.txt", "move");
        sandbox.file(r"folder\child.txt", "child");
        let list = vec![
            Elevated::Copy { source: file, target: old.clone() },
            Elevated::Copy {
                source: sandbox.path("folder"),
                target: sandbox.path(r"to\folder"),
            },
            Elevated::Move { source: moved.clone(), target: sandbox.path(r"to\b.txt") },
            Elevated::New { target: sandbox.path(r"to\new"), directory: true },
        ];
        let slots = Arc::new(Mutex::new(vec![Slot::Waiting; list.len()]));
        let control = Arc::new(Control::default());
        let flags = FILEOPERATION_FLAGS(FOF_NO_UI.0 | FOF_RENAMEONCOLLISION.0);

        perform_elevated(&list, flags, 0, &slots, &control).unwrap();

        let script = super::super::tests::Script::default();
        let mut run = Run::new(&script, &control);
        let slots = slots.lock().unwrap().clone();
        for (entry, slot) in list.into_iter().zip(slots) {
            run.record_elevated(entry, slot);
        }
        assert_eq!(fs::read_to_string(&old).unwrap(), "old");
        // Only the names, because the shell spells out a temp folder given in short 8.3 form.
        let name = |path: &Path| path.file_name().unwrap().to_str().unwrap().to_string();
        let made: Vec<_> = run
            .done
            .iter()
            .map(|record| match record {
                Done::Created { path } => ("created", name(path)),
                Done::Moved { from, to } => {
                    assert_eq!(*from, moved);
                    ("moved", name(to))
                }
                Done::Recycled { .. } => unreachable!("nothing went to the bin"),
            })
            .collect();
        assert_eq!(
            made,
            [
                ("created", "a - Copy.txt".to_string()),
                ("created", "folder".to_string()),
                ("moved", "b.txt".to_string()),
                ("created", "new".to_string()),
            ]
        );
    }
}
