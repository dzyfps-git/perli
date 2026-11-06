//! The work only the Windows shell can do: the Recycle Bin and admin-protected folders.

use std::mem;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use windows::core::{implement, Error, Ref, Result, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{E_FAIL, HWND};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::{
    FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
    IShellItem, SHCreateItemFromParsingName, COPYENGINE_E_USER_CANCELLED, FILEOPERATION_FLAGS,
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
    Failed(HRESULT),
}

#[implement(IFileOperationProgressSink)]
struct Sink {
    index: usize,
    slots: Arc<Mutex<Vec<Slot>>>,
    control: Arc<Control>,
}

impl Sink_Impl {
    fn set(&self, slot: Slot) {
        let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
        if slots[self.index] != Slot::Refused {
            slots[self.index] = slot;
        }
    }
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn PreDeleteItem(&self, flags: u32, _item: Ref<IShellItem>) -> Result<()> {
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
        if result == COPYENGINE_E_USER_CANCELLED {
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
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> Result<()> {
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
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> Result<()> {
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
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> Result<()> {
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

        if let Err(error) = perform_elevated(&others, self.host.owner()) {
            self.refuse(Path::new(""), &error.message())?;
        }
        for entry in others {
            self.record_elevated(entry);
        }
        Ok(())
    }

    fn record_elevated(&mut self, entry: Elevated) {
        let exists = |path: &Path| matches!(sys::stat(path), Ok(Some(_)));
        match entry {
            Elevated::Copy { target, .. } | Elevated::New { target, .. } if exists(&target) => {
                self.done.push(Done::Created { path: target });
            }
            Elevated::Move { source, target } if exists(&target) && !exists(&source) => {
                self.done.push(Done::Moved {
                    from: source,
                    to: target,
                });
            }
            Elevated::Delete { path } => {
                self.touched.insert(sys::parent(&path));
            }
            _ => {}
        }
    }
}

fn perform_elevated(list: &[Elevated], owner: isize) -> Result<()> {
    let flags = FOF_NOCONFIRMMKDIR.0
        | FOF_ALLOWUNDO.0
        | FOF_NORECURSEREPARSE.0
        | FOFX_REQUIREELEVATION.0
        | FOFX_SHOWELEVATIONPROMPT.0;
    let operation = operation(FILEOPERATION_FLAGS(flags), owner)?;
    let name_of = |path: &Path| HSTRING::from(path.file_name().unwrap_or(path.as_os_str()));
    unsafe {
        for entry in list {
            match entry {
                Elevated::Copy { source, target } => {
                    let folder = shell_item(&sys::parent(target))?;
                    operation.CopyItem(&shell_item(source)?, &folder, &name_of(target), None)?;
                }
                Elevated::Move { source, target } => {
                    let folder = shell_item(&sys::parent(target))?;
                    operation.MoveItem(&shell_item(source)?, &folder, &name_of(target), None)?;
                }
                Elevated::New { target, directory } => {
                    let attributes = if *directory {
                        FILE_ATTRIBUTE_DIRECTORY
                    } else {
                        FILE_ATTRIBUTE_NORMAL
                    };
                    let folder = shell_item(&sys::parent(target))?;
                    operation.NewItem(&folder, attributes.0, &name_of(target), None, None)?;
                }
                Elevated::Delete { path } | Elevated::Recycle { path } => {
                    operation.DeleteItem(&shell_item(path)?, None)?;
                }
            }
        }
        operation.PerformOperations()
    }
}
