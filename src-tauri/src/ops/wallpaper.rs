//! The desktop picture, set from Perli and put back by Undo.

use std::path::{Path, PathBuf};

use super::{Done, Flow, Run};

/// Each screen's picture, by the id Windows gives the screen.
pub type Screens = Vec<(String, PathBuf)>;

impl Run<'_> {
    pub(super) fn set_wallpaper(&mut self, picture: &Path) -> Flow {
        self.add_total(1, 0);
        let before = self.attempt(picture, None, |_| {
            let before = desktop::current()?;
            desktop::set(None, picture)?;
            Ok(before)
        })?;
        if let Some(before) = before {
            self.done.push(Done::Wallpaper { before, after: picture.to_path_buf() });
        }
        self.step(1, 0);
        Ok(())
    }

    /// Each screen gets its old picture back. A screen that is gone since is left out.
    pub(super) fn put_back_wallpaper(&mut self, before: &Screens) -> Flow {
        self.add_total(1, 0);
        let first = before.first().map(|(_, picture)| picture.clone()).unwrap_or_default();
        let now = self.attempt(&first, None, |_| {
            let now = desktop::current()?;
            for (screen, picture) in before {
                if now.iter().any(|(id, _)| id == screen) {
                    desktop::set(Some(screen), picture)?;
                }
            }
            Ok(now)
        })?;
        if let Some(now) = now {
            self.done.push(Done::Wallpaper { before: now, after: first });
        }
        self.step(1, 0);
        Ok(())
    }
}

/// The first screen's picture that is still a file, for colors taken from it.
pub fn shown() -> Option<PathBuf> {
    desktop::current().ok()?.into_iter().map(|(_, picture)| picture).find(|picture| picture.is_file())
}

#[cfg(not(test))]
mod desktop {
    use std::path::{Path, PathBuf};

    use windows::core::{Result, HSTRING, PWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
    use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper};

    use super::Screens;

    fn desktop() -> Result<IDesktopWallpaper> {
        unsafe { CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL) }
    }

    fn taken(text: PWSTR) -> String {
        let owned = unsafe { text.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(text.0.cast())) };
        owned
    }

    pub fn current() -> Result<Screens> {
        let desktop = desktop()?;
        let count = unsafe { desktop.GetMonitorDevicePathCount() }?;
        let screens = (0..count).filter_map(|at| {
            let id = taken(unsafe { desktop.GetMonitorDevicePathAt(at) }.ok()?);
            let picture = taken(unsafe { desktop.GetWallpaper(&HSTRING::from(&id)) }.ok()?);
            Some((id, PathBuf::from(picture)))
        });
        Ok(screens.collect())
    }

    /// Every screen at once when `screen` is none.
    pub fn set(screen: Option<&str>, picture: &Path) -> Result<()> {
        let desktop = desktop()?;
        let screen = screen.map(HSTRING::from).unwrap_or_default();
        unsafe { desktop.SetWallpaper(&screen, &HSTRING::from(picture)) }
    }
}

/// Tests never touch the real desktop: two pretend screens stand in for it.
#[cfg(test)]
pub mod desktop {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use windows::core::Result;

    use super::Screens;

    thread_local! {
        pub static SCREENS: RefCell<Screens> = RefCell::new(vec![
            ("left".into(), PathBuf::from(r"C:\old\left.jpg")),
            ("right".into(), PathBuf::from(r"C:\old\right.jpg")),
        ]);
    }

    pub fn current() -> Result<Screens> {
        Ok(SCREENS.with(|screens| screens.borrow().clone()))
    }

    pub fn set(screen: Option<&str>, picture: &Path) -> Result<()> {
        SCREENS.with(|screens| {
            for (id, shown) in screens.borrow_mut().iter_mut() {
                if screen.is_none_or(|screen| screen == id) {
                    *shown = picture.to_path_buf();
                }
            }
        });
        Ok(())
    }
}
