//! Picture changes as jobs: a turn saved into each file, or a new copy beside it.

use std::fs;
use std::path::{Path, PathBuf};

use windows::core::Error;
use windows::Win32::Foundation::E_FAIL;

use crate::picture::{self, Edit, Format};

use super::{names, sys, Done, Flow, Run};

impl Run<'_> {
    pub(super) fn edit_pictures(&mut self, paths: &[PathBuf], edit: Edit) -> Flow {
        self.add_total(paths.len() as u64, 0);
        for path in paths {
            self.check()?;
            match edit {
                Edit::Turn { quarters, flip } => drop(self.turn_picture(path, (quarters, flip))?),
                _ => self.picture_copy(path, edit)?,
            }
            self.step(1, 0);
        }
        Ok(())
    }

    /// A JPEG only changes the note that says how it stands, so it loses nothing. Any other
    /// picture is drawn again, turned.
    fn turn_picture(&mut self, path: &Path, turn: picture::Turn) -> Flow<bool> {
        if picture::format_of(path) != Some(Format::Jpeg) {
            let edit = Edit::Turn { quarters: turn.0, flip: turn.1 };
            return self.replace(path, |temp| picture::write(path, temp, edit).map(drop));
        }
        self.replace(path, |temp| {
            let bytes = fs::read(path).map_err(|error| Error::new(E_FAIL, error.to_string()))?;
            let turned = picture::turn_jpeg(&bytes, turn)
                .ok_or_else(|| Error::new(E_FAIL, "Its EXIF can't be read, so it can't turn without losing quality."))?;
            sys::write_new(temp, &turned)
        })
    }

    /// A new picture beside `path`, named for what it is once its size is known.
    fn picture_copy(&mut self, path: &Path, edit: Edit) -> Flow {
        let folder = sys::parent(path);
        let temp = self.temp_beside(path);
        let made = self.attempt(path, None, |_| {
            let _ = sys::delete_file(&temp);
            picture::write(path, &temp, edit)
        })?;
        let Some(size) = made else {
            let _ = sys::delete_file(&temp);
            return Ok(());
        };
        let (stem, extension) = picture::copy_name(path, edit, size);
        let landed = self.attempt(path, None, |_| {
            let target = names::free(&folder, &stem, &extension);
            sys::rename(&temp, &target).map(|()| target)
        })?;
        match landed {
            Some(target) => self.done.push(Done::Created { path: target }),
            None => {
                let _ = sys::delete_file(&temp);
            }
        }
        self.touched.insert(folder);
        Ok(())
    }
}
