//! Reads a folder into memory and serves its rows to the UI as binary pages.
//! The UI only ever holds the rows it is showing.

use std::cmp::Ordering;

use windows::core::{Result, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES};
use windows::Win32::Storage::FileSystem::{
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
    FILE_ATTRIBUTE_DIRECTORY, FIND_FIRST_EX_LARGE_FETCH, WIN32_FIND_DATAW,
};
use windows::Win32::UI::Shell::StrCmpLogicalW;

pub struct Entry {
    /// UTF-16 and null-terminated, ready for `StrCmpLogicalW`.
    name: Box<[u16]>,
    size: u64,
    /// FILETIME ticks.
    modified: u64,
    is_dir: bool,
}

impl Entry {
    fn from_find_data(data: &WIN32_FIND_DATAW) -> Option<Self> {
        let length = data.cFileName.iter().position(|&c| c == 0)?;
        let name = &data.cFileName[..length];
        if name == [b'.' as u16] || name == [b'.' as u16, b'.' as u16] {
            return None;
        }
        Some(Self {
            name: data.cFileName[..=length].into(),
            size: (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow),
            modified: (u64::from(data.ftLastWriteTime.dwHighDateTime) << 32)
                | u64::from(data.ftLastWriteTime.dwLowDateTime),
            is_dir: data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
        })
    }

    fn name(&self) -> &[u16] {
        &self.name[..self.name.len() - 1]
    }
}

/// Reads and sorts a folder: folders first, then Explorer's natural name order.
pub fn read(path: &str) -> Result<Vec<Entry>> {
    let pattern = search_pattern(path)?;
    let mut data = WIN32_FIND_DATAW::default();
    let found = unsafe {
        FindFirstFileExW(
            &pattern,
            FindExInfoBasic,
            (&raw mut data).cast(),
            FindExSearchNameMatch,
            None,
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };
    let handle = match found {
        Ok(handle) => handle,
        // An empty drive root has no "." entry, so nothing matches.
        Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };

    let mut entries = Vec::new();
    let finished = loop {
        entries.extend(Entry::from_find_data(&data));
        if let Err(error) = unsafe { FindNextFileW(handle, &mut data) } {
            break if error.code() == ERROR_NO_MORE_FILES.to_hresult() {
                Ok(())
            } else {
                Err(error)
            };
        }
    };
    unsafe { FindClose(handle) }?;
    finished?;

    entries.sort_unstable_by(compare);
    Ok(entries)
}

/// Builds the extended-length search pattern. The `\\?\` prefix turns off Windows path
/// parsing, so relative parts and forward slashes must be resolved before adding it.
// ponytail: local drive paths only, UNC paths arrive with network drives in Phase 3.
fn search_pattern(path: &str) -> Result<HSTRING> {
    let full = std::path::absolute(path)?;
    let full = full.to_string_lossy();
    Ok(HSTRING::from(format!(
        r"\\?\{}\*",
        full.trim_end_matches('\\')
    )))
}

fn compare(a: &Entry, b: &Entry) -> Ordering {
    b.is_dir.cmp(&a.is_dir).then_with(|| {
        unsafe { StrCmpLogicalW(PCWSTR(a.name.as_ptr()), PCWSTR(b.name.as_ptr())) }.cmp(&0)
    })
}

/// Encodes rows as: row count (u32), then for each row the name length in bytes
/// (u32), size (u64), modified (u64), is-folder (u8) and the UTF-16 name.
/// All numbers are little-endian. `src/api/index.ts` decodes this.
pub fn encode_rows(entries: &[Entry], start: usize, count: usize) -> Vec<u8> {
    let start = start.min(entries.len());
    let rows = &entries[start..(start + count).min(entries.len())];

    let mut bytes = Vec::with_capacity(4 + rows.len() * 64);
    bytes.extend((rows.len() as u32).to_le_bytes());
    for row in rows {
        bytes.extend((row.name().len() as u32 * 2).to_le_bytes());
        bytes.extend(row.size.to_le_bytes());
        bytes.extend(row.modified.to_le_bytes());
        bytes.push(u8::from(row.is_dir));
        bytes.extend(row.name().iter().flat_map(|unit| unit.to_le_bytes()));
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("perli-{name}-{}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| String::from_utf16(entry.name()).unwrap())
            .collect()
    }

    #[test]
    fn sorts_folders_first_then_natural_order() {
        let folder = TempFolder::new("sort");
        for file in ["file10.txt", "file2.txt", "file1.txt"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        fs::create_dir(folder.0.join("zebra")).unwrap();

        let entries = read(folder.0.to_str().unwrap()).unwrap();

        assert_eq!(
            names(&entries),
            ["zebra", "file1.txt", "file2.txt", "file10.txt"]
        );
    }

    #[test]
    fn reads_size_and_folder_flag() {
        let folder = TempFolder::new("fields");
        fs::write(folder.0.join("five.txt"), "12345").unwrap();
        fs::create_dir(folder.0.join("sub")).unwrap();

        let entries = read(folder.0.to_str().unwrap()).unwrap();

        assert!(entries[0].is_dir);
        assert_eq!(entries[1].size, 5);
    }

    #[test]
    fn resolves_relative_paths_and_forward_slashes() {
        // Cargo runs tests from the package folder, which holds `src/main.rs`.
        for path in [r".\src", "src", "src/", r"..\src-tauri\src"] {
            let entries = read(path).unwrap();
            assert!(names(&entries).contains(&"main.rs".to_string()), "{path}");
        }
    }

    #[test]
    fn missing_folder_is_an_error() {
        let folder = TempFolder::new("missing");
        assert!(read(folder.0.join("nope").to_str().unwrap()).is_err());
    }

    #[test]
    fn encodes_only_the_requested_rows() {
        let folder = TempFolder::new("encode");
        for file in ["a", "b", "c"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        let entries = read(folder.0.to_str().unwrap()).unwrap();

        let bytes = encode_rows(&entries, 1, 10);

        assert_eq!(bytes[..4], 2u32.to_le_bytes());
        assert_eq!(bytes[4..8], 2u32.to_le_bytes());
        assert_eq!(bytes[25..27], [b'b', 0]);
        assert_eq!(encode_rows(&entries, 99, 10)[..4], 0u32.to_le_bytes());
    }
}
