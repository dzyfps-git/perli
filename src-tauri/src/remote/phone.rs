//! Phones, cameras and players over WPD (MTP), shown as places beside the cloud ones while they
//! are plugged in. WPD finds an object by its id, never by a path, so the service keeps the id of
//! each path it has listed and walks down from the top for one it hasn't.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::{GUID, HSTRING, PWSTR};
use windows::Win32::Devices::PortableDevices::{
    IEnumPortableDeviceObjectIDs, IPortableDevice, IPortableDeviceContent, IPortableDeviceKeyCollection, IPortableDevicePropVariantCollection,
    IPortableDeviceProperties, IPortableDeviceValues, PortableDeviceFTM, PortableDeviceKeyCollection, PortableDevicePropVariantCollection,
    PortableDeviceValues, PORTABLE_DEVICE_DELETE_WITH_RECURSION, WPD_CLIENT_NAME, WPD_CONTENT_TYPE_FOLDER, WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT,
    WPD_DEVICE_OBJECT_ID, WPD_DEVICE_POWER_LEVEL, WPD_FUNCTIONAL_CATEGORY_STORAGE, WPD_FUNCTIONAL_OBJECT_CATEGORY, WPD_OBJECT_CONTENT_TYPE,
    WPD_OBJECT_DATE_MODIFIED, WPD_OBJECT_FORMAT, WPD_OBJECT_FORMAT_PROPERTIES_ONLY, WPD_OBJECT_NAME, WPD_OBJECT_ORIGINAL_FILE_NAME,
    WPD_OBJECT_PARENT_ID, WPD_OBJECT_SIZE, WPD_RESOURCE_DEFAULT, WPD_RESOURCE_THUMBNAIL, WPD_STORAGE_CAPACITY, WPD_STORAGE_FREE_SPACE_IN_BYTES,
};
use windows::Win32::Foundation::{PROPERTYKEY, S_OK};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToFileTime, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IStream, CLSCTX_INPROC_SERVER, STGC_DEFAULT, STGM_READ};
use windows::Win32::System::Variant::{PSTF_LOCAL, VT_LPWSTR};

use super::{join, lock, parent_of, Item, Kind, Place, Service, Tick, STOPPED};

/// What a phone that won't open is most often waiting for.
const LOCKED: &str = "Unlock the phone and let this PC see its files: on Android, pick File transfer in the USB notice";
/// Bytes at most that go to or from a phone in one call.
const CHUNK: usize = 1024 * 1024;
/// How long the list of phones plugged in is taken as it is.
const PHONES_KEEP: Duration = Duration::from_secs(3);
/// Rows at most a search on a phone looks through, as it lists each folder one by one.
const SEARCH_LIMIT: usize = 20_000;

fn failed(error: windows::core::Error) -> String {
    error.message()
}

/// Phones and the like plugged in now, as places, each named apart from `saved` and each other.
/// Devices plugged in, as (id, name), and when Windows was asked.
type Seen = Option<(Instant, Vec<(String, String)>)>;

pub fn places(saved: &[Place]) -> Vec<Place> {
    static PHONES: Mutex<Seen> = Mutex::new(None);
    let mut known = lock(&PHONES);
    let fresh = known.as_ref().is_some_and(|(read, _)| read.elapsed() < PHONES_KEEP);
    if !fresh {
        *known = Some((Instant::now(), crate::places::phones()));
    }
    let devices = known.as_ref().map(|(_, devices)| devices.clone()).unwrap_or_default();
    drop(known);
    let taken: Vec<&str> = saved.iter().map(|place| place.name.as_str()).collect();
    named(&devices, &taken)
        .into_iter()
        .map(|(id, name)| Place { id, name, kind: Kind::Phone, account: "Phone".into(), s3: None, pdf: false })
        .collect()
}

/// Each device as (id, name), its name made one no saved place or other device has.
pub fn named(devices: &[(String, String)], taken: &[&str]) -> Vec<(String, String)> {
    let mut used: Vec<String> = taken.iter().map(|name| name.to_lowercase()).collect();
    devices
        .iter()
        .map(|(id, wanted)| {
            let clean = super::local_name(wanted.trim());
            let name = (1..).map(|number| if number == 1 { clean.clone() } else { format!("{clean} ({number})") }).find(|name| !used.contains(&name.to_lowercase())).unwrap_or(clean);
            used.push(name.to_lowercase());
            (id.clone(), name)
        })
        .collect()
}

pub struct Phone {
    device: String,
    /// The WPD id of each path listed so far.
    ids: Mutex<HashMap<String, String>>,
}

/// An open link to the phone, with COM up on this thread for as long as it lives.
struct Session {
    device: IPortableDevice,
    content: IPortableDeviceContent,
    properties: IPortableDeviceProperties,
    _com: crate::ops::Com,
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            let _ = self.device.Close();
        }
    }
}

unsafe fn made<T: windows::core::Interface>(class: &GUID) -> Result<T, String> {
    CoCreateInstance(class, None, CLSCTX_INPROC_SERVER).map_err(failed)
}

unsafe fn keys(wanted: &[PROPERTYKEY]) -> Result<IPortableDeviceKeyCollection, String> {
    let keys: IPortableDeviceKeyCollection = made(&PortableDeviceKeyCollection)?;
    for key in wanted {
        keys.Add(key).map_err(failed)?;
    }
    Ok(keys)
}

/// A string the way WPD's lists of ids take one. It only borrows `wide`, which the list copies.
fn text_variant(wide: &mut [u16]) -> PROPVARIANT {
    PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 { vt: VT_LPWSTR, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: PROPVARIANT_0_0_0 { pwszVal: PWSTR(wide.as_mut_ptr()) } }),
        },
    }
}

unsafe fn one_id(id: &str) -> Result<IPortableDevicePropVariantCollection, String> {
    let list: IPortableDevicePropVariantCollection = made(&PortableDevicePropVariantCollection)?;
    let mut wide: Vec<u16> = id.encode_utf16().chain([0]).collect();
    list.Add(&text_variant(&mut wide)).map_err(failed)?;
    Ok(list)
}

unsafe fn string_of(values: &IPortableDeviceValues, key: &PROPERTYKEY) -> Option<String> {
    let text = values.GetStringValue(key).ok()?;
    let read = text.to_string().ok();
    CoTaskMemFree(Some(text.0.cast()));
    read
}

/// Reads all of a stream, a chunk at a time, telling `tick` how much so far. False stops.
unsafe fn pour(stream: &IStream, skip: u64, out: &mut dyn Write, tick: Tick) -> Result<(), String> {
    let mut buffer = vec![0u8; CHUNK];
    let (mut skip, mut done) = (skip, 0u64);
    loop {
        let mut got = 0u32;
        stream.Read(buffer.as_mut_ptr().cast(), CHUNK as u32, Some(&raw mut got)).ok().map_err(failed)?;
        if got == 0 {
            return Ok(());
        }
        let mut chunk = &buffer[..got as usize];
        let cut = skip.min(chunk.len() as u64) as usize;
        chunk = &chunk[cut..];
        skip -= cut as u64;
        out.write_all(chunk).map_err(|error| error.to_string())?;
        done += chunk.len() as u64;
        if !tick(done) {
            return Err(STOPPED.into());
        }
    }
}

impl Phone {
    pub fn new(device: &str) -> Self {
        Self { device: device.to_string(), ids: Mutex::new(HashMap::new()) }
    }

    fn open(&self) -> Result<Session, String> {
        let com = crate::ops::Com::enter();
        unsafe {
            let device: IPortableDevice = made(&PortableDeviceFTM)?;
            let client: IPortableDeviceValues = made(&PortableDeviceValues)?;
            client.SetStringValue(&WPD_CLIENT_NAME, &HSTRING::from("Perli")).map_err(failed)?;
            device.Open(&HSTRING::from(&self.device), &client).map_err(|_| LOCKED.to_string())?;
            let content = device.Content().map_err(failed)?;
            let properties = content.Properties().map_err(failed)?;
            Ok(Session { device, content, properties, _com: com })
        }
    }

    /// The ids of what the object holds.
    unsafe fn children(session: &Session, parent: &str) -> Result<Vec<String>, String> {
        let found: IEnumPortableDeviceObjectIDs = session.content.EnumObjects(0, &HSTRING::from(parent), None).map_err(failed)?;
        let mut ids = Vec::new();
        loop {
            let mut batch = [PWSTR::null(); 64];
            let mut fetched = 0u32;
            let result = found.Next(&mut batch, &raw mut fetched);
            for id in &batch[..fetched as usize] {
                ids.push(id.to_string().unwrap_or_default());
                CoTaskMemFree(Some(id.0.cast()));
            }
            result.ok().map_err(failed)?;
            if result != S_OK || fetched == 0 {
                return Ok(ids);
            }
        }
    }

    /// What the phone tells of one object, `None` for one that isn't a file, folder or storage.
    unsafe fn item(session: &Session, id: &str, wanted: &IPortableDeviceKeyCollection) -> Option<Item> {
        let values = session.properties.GetValues(&HSTRING::from(id), wanted).ok()?;
        let kind = values.GetGuidValue(&WPD_OBJECT_CONTENT_TYPE).unwrap_or_default();
        let storage = kind == WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT;
        if storage && values.GetGuidValue(&WPD_FUNCTIONAL_OBJECT_CATEGORY).ok() != Some(WPD_FUNCTIONAL_CATEGORY_STORAGE) {
            return None;
        }
        let name = string_of(&values, &WPD_OBJECT_ORIGINAL_FILE_NAME).filter(|name| !name.is_empty()).or_else(|| string_of(&values, &WPD_OBJECT_NAME)).unwrap_or_else(|| id.to_string());
        let size = values.GetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE).unwrap_or(0);
        let modified = values
            .GetValue(&WPD_OBJECT_DATE_MODIFIED)
            .ok()
            .map(|mut value| {
                let time = PropVariantToFileTime(&value, PSTF_LOCAL).ok();
                let _ = PropVariantClear(&mut value);
                time.map_or(0, |time| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime))
            })
            .unwrap_or(0);
        let note = if storage {
            let total = values.GetUnsignedLargeIntegerValue(&WPD_STORAGE_CAPACITY).unwrap_or(0);
            let free = values.GetUnsignedLargeIntegerValue(&WPD_STORAGE_FREE_SPACE_IN_BYTES).unwrap_or(0);
            if total > 0 { format!("{} free of {}", gigabytes(free), gigabytes(total)) } else { String::new() }
        } else {
            String::new()
        };
        Some(Item { name: super::local_name(&name), folder: storage || kind == WPD_CONTENT_TYPE_FOLDER, size, modified, version: format!("{size}-{modified}"), id: id.to_string(), note, cold: false })
    }

    unsafe fn list_in(&self, session: &Session, folder: &str, id: &str) -> Result<Vec<Item>, String> {
        let wanted = keys(&[
            WPD_OBJECT_NAME,
            WPD_OBJECT_ORIGINAL_FILE_NAME,
            WPD_OBJECT_CONTENT_TYPE,
            WPD_OBJECT_SIZE,
            WPD_OBJECT_DATE_MODIFIED,
            WPD_FUNCTIONAL_OBJECT_CATEGORY,
            WPD_STORAGE_CAPACITY,
            WPD_STORAGE_FREE_SPACE_IN_BYTES,
        ])?;
        let items: Vec<Item> = Self::children(session, id)?.iter().filter_map(|child| Self::item(session, child, &wanted)).collect();
        let mut ids = lock(&self.ids);
        for item in &items {
            ids.insert(join(folder, &item.name), item.id.clone());
        }
        Ok(items)
    }

    /// The WPD id of a path, listing down to it from the nearest folder whose id is known.
    unsafe fn id_of(&self, session: &Session, path: &str) -> Result<String, String> {
        if path.is_empty() {
            return Ok(WPD_DEVICE_OBJECT_ID.to_string().unwrap_or_default());
        }
        if let Some(id) = lock(&self.ids).get(path) {
            return Ok(id.clone());
        }
        let parent = parent_of(path);
        let parent_id = self.id_of(session, parent)?;
        self.list_in(session, parent, &parent_id)?;
        lock(&self.ids).get(path).cloned().ok_or_else(|| format!("{} isn't on the phone any more", path.rsplit('/').next().unwrap_or(path)))
    }

    /// Runs `work` with the phone open, once more from the top when it fails, as ids the phone
    /// gave in an earlier session may have changed since.
    fn with<T>(&self, work: impl Fn(&Self, &Session) -> Result<T, String>) -> Result<T, String> {
        let session = self.open()?;
        work(self, &session).or_else(|_| {
            lock(&self.ids).clear();
            work(self, &session)
        })
    }

    unsafe fn rename(session: &Session, id: &str, name: &str) -> Result<(), String> {
        let values: IPortableDeviceValues = made(&PortableDeviceValues)?;
        values.SetStringValue(&WPD_OBJECT_ORIGINAL_FILE_NAME, &HSTRING::from(name)).map_err(failed)?;
        let results = session.properties.SetValues(&HSTRING::from(id), &values).map_err(failed)?;
        // Each key set gives its own answer, as SetValues itself says yes when one failed.
        results.GetErrorValue(&WPD_OBJECT_ORIGINAL_FILE_NAME).map_or(Ok(()), |error| error.ok().map_err(|_| "This phone can't rename files".to_string()))
    }

    unsafe fn delete(&self, session: &Session, path: &str, id: &str) -> Result<(), String> {
        session.content.Delete(PORTABLE_DEVICE_DELETE_WITH_RECURSION.0 as u32, &one_id(id)?, ptr::null_mut()).map_err(failed)?;
        lock(&self.ids).retain(|known, _| known != path && !known.starts_with(&format!("{path}/")));
        Ok(())
    }

    unsafe fn send(session: &Session, parent: &str, name: &str, file: &Path, tick: Tick) -> Result<(), String> {
        let mut source = File::open(file).map_err(|error| error.to_string())?;
        let size = source.metadata().map_err(|error| error.to_string())?.len();
        let values: IPortableDeviceValues = made(&PortableDeviceValues)?;
        values.SetStringValue(&WPD_OBJECT_PARENT_ID, &HSTRING::from(parent)).map_err(failed)?;
        values.SetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE, size).map_err(failed)?;
        values.SetStringValue(&WPD_OBJECT_ORIGINAL_FILE_NAME, &HSTRING::from(name)).map_err(failed)?;
        values.SetStringValue(&WPD_OBJECT_NAME, &HSTRING::from(name)).map_err(failed)?;
        let (mut stream, mut optimal) = (None, 0u32);
        session.content.CreateObjectWithPropertiesAndData(&values, &raw mut stream, &raw mut optimal, ptr::null_mut()).map_err(failed)?;
        let stream: IStream = stream.ok_or("The phone took no file")?;
        let mut buffer = vec![0u8; CHUNK];
        let mut done = 0u64;
        loop {
            let read = source.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            let mut written = 0u32;
            stream.Write(buffer.as_ptr().cast(), read as u32, Some(&raw mut written)).ok().map_err(failed)?;
            done += read as u64;
            if !tick(done) {
                let _ = stream.Revert();
                return Err(STOPPED.into());
            }
        }
        stream.Commit(STGC_DEFAULT).map_err(failed)
    }

    /// The phone's battery, in percent, where it tells.
    pub fn battery(&self) -> Option<u32> {
        let session = self.open().ok()?;
        unsafe {
            let values = session.properties.GetValues(WPD_DEVICE_OBJECT_ID, &keys(&[WPD_DEVICE_POWER_LEVEL]).ok()?).ok()?;
            values.GetUnsignedIntegerValue(&WPD_DEVICE_POWER_LEVEL).ok()
        }
    }
}

fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / f64::from(1u32 << 30))
}

impl Service for Phone {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        self.with(|phone, session| unsafe {
            let id = phone.id_of(session, folder)?;
            phone.list_in(session, folder, &id)
        })
    }

    fn read(&self, path: &str, item: &Item, from: u64, out: &mut dyn Write, tick: Tick) -> Result<(), String> {
        let session = self.open()?;
        unsafe {
            let id = if item.id.is_empty() { self.id_of(&session, path)? } else { item.id.clone() };
            let resources = session.content.Transfer().map_err(failed)?;
            let (mut stream, mut optimal) = (None, 0u32);
            resources.GetStream(&HSTRING::from(&id), &WPD_RESOURCE_DEFAULT, STGM_READ.0, &raw mut optimal, &raw mut stream).map_err(failed)?;
            pour(&stream.ok_or("The phone gave nothing to read")?, from, out, tick)
        }
    }

    fn write(&self, folder: &str, name: &str, file: &Path, replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        let session = self.open()?;
        unsafe {
            let parent = self.id_of(&session, folder)?;
            let Some(old) = replace else {
                Self::send(&session, &parent, name, file, tick)?;
                lock(&self.ids).remove(&join(folder, name));
                return Ok(());
            };
            // A phone can't write over a file: the old one steps aside until the new one is in,
            // so a send cut off leaves the old one as it was.
            let old_id = if old.id.is_empty() { self.id_of(&session, &join(folder, &old.name))? } else { old.id.clone() };
            let aside = format!("{name}.perli-old");
            Self::rename(&session, &old_id, &aside).map_err(|_| format!("This phone can't replace {name}. Delete it on the phone first"))?;
            lock(&self.ids).remove(&join(folder, name));
            if let Err(message) = Self::send(&session, &parent, name, file, tick) {
                let _ = Self::rename(&session, &old_id, &old.name);
                return Err(message);
            }
            self.delete(&session, &join(folder, &aside), &old_id)
        }
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        let session = self.open()?;
        unsafe {
            let parent = self.id_of(&session, folder)?;
            let values: IPortableDeviceValues = made(&PortableDeviceValues)?;
            values.SetStringValue(&WPD_OBJECT_PARENT_ID, &HSTRING::from(&parent)).map_err(failed)?;
            values.SetStringValue(&WPD_OBJECT_NAME, &HSTRING::from(name)).map_err(failed)?;
            values.SetStringValue(&WPD_OBJECT_ORIGINAL_FILE_NAME, &HSTRING::from(name)).map_err(failed)?;
            values.SetGuidValue(&WPD_OBJECT_CONTENT_TYPE, &WPD_CONTENT_TYPE_FOLDER).map_err(failed)?;
            values.SetGuidValue(&WPD_OBJECT_FORMAT, &WPD_OBJECT_FORMAT_PROPERTIES_ONLY).map_err(failed)?;
            let mut id = PWSTR::null();
            session.content.CreateObjectWithPropertiesOnly(&values, &raw mut id).map_err(failed)?;
            if !id.is_null() {
                CoTaskMemFree(Some(id.0.cast()));
            }
            Ok(())
        }
    }

    fn remove(&self, path: &str, item: &Item) -> Result<String, String> {
        let session = self.open()?;
        unsafe {
            let id = if item.id.is_empty() { self.id_of(&session, path)? } else { item.id.clone() };
            self.delete(&session, path, &id)?;
        }
        Ok(String::new())
    }

    fn restore(&self, _path: &str, _token: &str) -> Result<(), String> {
        Err("A phone keeps no bin".into())
    }

    fn relocate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let session = self.open()?;
        unsafe {
            let id = if item.id.is_empty() { self.id_of(&session, path)? } else { item.id.clone() };
            if parent_of(path) != folder {
                let target = self.id_of(&session, folder)?;
                session.content.Move(&one_id(&id)?, &HSTRING::from(&target), ptr::null_mut()).map_err(|_| "This phone can't move files on itself. Copy them to this PC and back".to_string())?;
            }
            if name != item.name {
                Self::rename(&session, &id, name)?;
            }
            lock(&self.ids).retain(|known, _| known != path && !known.starts_with(&format!("{path}/")));
            Ok(())
        }
    }

    fn duplicate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        if name != item.name {
            return Err("A phone copies within itself only under the same name".into());
        }
        let session = self.open()?;
        unsafe {
            let id = if item.id.is_empty() { self.id_of(&session, path)? } else { item.id.clone() };
            let target = self.id_of(&session, folder)?;
            session.content.Copy(&one_id(&id)?, &HSTRING::from(&target), ptr::null_mut()).map_err(|_| "This phone can't copy files on itself. Copy them to this PC and back".to_string())
        }
    }

    fn has_bin(&self) -> bool {
        false
    }

    fn thumbnail(&self, path: &str, item: &Item, _edge: u32) -> Result<Option<Vec<u8>>, String> {
        let session = self.open()?;
        unsafe {
            let id = if item.id.is_empty() { self.id_of(&session, path)? } else { item.id.clone() };
            let resources = session.content.Transfer().map_err(failed)?;
            let (mut stream, mut optimal) = (None, 0u32);
            if resources.GetStream(&HSTRING::from(&id), &WPD_RESOURCE_THUMBNAIL, STGM_READ.0, &raw mut optimal, &raw mut stream).is_err() {
                return Ok(None);
            }
            let Some(stream) = stream else { return Ok(None) };
            let mut bytes = Vec::new();
            pour(&stream, 0, &mut bytes, &mut |_| true)?;
            Ok(Some(bytes).filter(|bytes| !bytes.is_empty()))
        }
    }

    fn search(&self, folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let needle = text.to_lowercase();
        self.with(|phone, session| unsafe {
            let mut found = Vec::new();
            let mut todo = vec![(folder.to_string(), phone.id_of(session, folder)?)];
            let mut seen = 0;
            // ponytail: walks folder by folder, so a phone with very many files stops at SEARCH_LIMIT rows.
            while let Some((path, id)) = todo.pop() {
                for item in phone.list_in(session, &path, &id)? {
                    seen += 1;
                    if item.folder {
                        todo.push((join(&path, &item.name), item.id.clone()));
                    }
                    if item.name.to_lowercase().contains(&needle) {
                        found.push((path.clone(), item));
                    }
                }
                if seen > SEARCH_LIMIT {
                    break;
                }
            }
            Ok(found)
        })
    }

    fn space(&self) -> Result<Option<(u64, u64)>, String> {
        let session = self.open()?;
        unsafe {
            let wanted = keys(&[WPD_OBJECT_CONTENT_TYPE, WPD_FUNCTIONAL_OBJECT_CATEGORY, WPD_STORAGE_CAPACITY, WPD_STORAGE_FREE_SPACE_IN_BYTES])?;
            let (mut used, mut total) = (0, 0);
            for id in Self::children(&session, &WPD_DEVICE_OBJECT_ID.to_string().unwrap_or_default())? {
                let Ok(values) = session.properties.GetValues(&HSTRING::from(&id), &wanted) else { continue };
                if values.GetGuidValue(&WPD_FUNCTIONAL_OBJECT_CATEGORY).ok() != Some(WPD_FUNCTIONAL_CATEGORY_STORAGE) {
                    continue;
                }
                let size = values.GetUnsignedLargeIntegerValue(&WPD_STORAGE_CAPACITY).unwrap_or(0);
                total += size;
                used += size.saturating_sub(values.GetUnsignedLargeIntegerValue(&WPD_STORAGE_FREE_SPACE_IN_BYTES).unwrap_or(0));
            }
            Ok((total > 0).then_some((used, total)))
        }
    }

    fn share(&self, _path: &str, _item: &Item) -> Result<String, String> {
        Err("A phone's files can't be shared by link".into())
    }
}

/// Photos and videos a phone's camera makes, by their extensions.
const MEDIA: [&str; 17] = ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "dng", "raw", "mp4", "mov", "m4v", "3gp", "avi", "mkv", "webm", "hevc"];
/// What came in from each phone before, so the next import brings only what is new.
const IMPORTS_FILE: &str = "phone-imports.json";

/// One day's photos, and the folder they go to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub folder: PathBuf,
    pub paths: Vec<PathBuf>,
}

/// Tells one photo from another across imports: the phone's own ids may change between them.
fn import_key(item: &Item) -> String {
    format!("{}|{}|{}", item.name, item.size, item.modified)
}

static IMPORTS: Mutex<()> = Mutex::new(());

fn imports() -> HashMap<String, HashSet<String>> {
    let text = crate::session::data_file(IMPORTS_FILE).and_then(|file| fs::read_to_string(file).ok());
    text.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// The day a FILETIME falls on here, as 2026-11-26.
fn day(ticks: u64) -> String {
    use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
    let time = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let (mut utc, mut local) = (SYSTEMTIME::default(), SYSTEMTIME::default());
    let known = ticks > 0 && unsafe { FileTimeToSystemTime(&time, &mut utc).is_ok() && SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).is_ok() };
    if known { format!("{:04}-{:02}-{:02}", local.wYear, local.wMonth, local.wDay) } else { "Undated".into() }
}

/// The photos and videos under `path` on a phone that no import brought in before, a batch for
/// each day they were taken, each day's folder made in `into`. At the phone's top only its
/// camera folders count, DCIM, where it has them.
pub fn import_plan(path: &Path, into: &Path) -> Result<Vec<Batch>, String> {
    let at = super::at(path).ok_or("This brings in photos from a phone")??;
    if at.place.kind != Kind::Phone {
        return Err("This brings in photos from a phone".into());
    }
    let done = imports().remove(&at.place.id).unwrap_or_default();
    let mut todo = vec![at.inner.clone()];
    if at.inner.is_empty() {
        let storages = super::listed(&at, "", true)?;
        let cameras: Vec<String> = storages
            .iter()
            .filter_map(|storage| Some(join(&storage.name, &super::listed(&at, &storage.name, true).ok()?.iter().find(|item| item.folder && item.name.eq_ignore_ascii_case("DCIM"))?.name)))
            .collect();
        if !cameras.is_empty() {
            todo = cameras;
        }
    }
    let mut days: std::collections::BTreeMap<String, Vec<PathBuf>> = std::collections::BTreeMap::new();
    while let Some(folder) = todo.pop() {
        for item in super::listed(&at, &folder, true)?.iter() {
            let inner = join(&folder, &item.name);
            if item.folder {
                todo.push(inner);
                continue;
            }
            let extension = item.name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
            if MEDIA.contains(&extension.as_str()) && !done.contains(&import_key(item)) {
                days.entry(day(item.modified)).or_default().push(at.shown(&inner));
            }
        }
    }
    days.into_iter()
        .map(|(day, paths)| {
            let folder = into.join(day);
            fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
            Ok(Batch { folder, paths })
        })
        .collect()
}

/// Notes the photos at `paths` as brought in, so no later import brings them again.
pub fn mark_imported(paths: &[PathBuf]) -> Result<(), String> {
    let _held = lock(&IMPORTS);
    let mut all = imports();
    for path in paths {
        let Some(Ok(at)) = super::at(path) else { continue };
        if let Ok(item) = at.item() {
            all.entry(at.place.id.clone()).or_default().insert(import_key(&item));
        }
    }
    let file = crate::session::data_file(IMPORTS_FILE).ok_or("There is no folder for Perli's own files")?;
    fs::write(file, serde_json::to_string(&all).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_get_names_no_place_or_other_phone_has() {
        let devices = [("a".to_string(), "Pixel 8".to_string()), ("b".to_string(), "Pixel 8".to_string()), ("c".to_string(), "Cam: X?".to_string())];
        let named = named(&devices, &["pixel 8", "Work"]);
        assert_eq!(named[0], ("a".to_string(), "Pixel 8 (2)".to_string()), "a saved place keeps its name");
        assert_eq!(named[1].1, "Pixel 8 (3)");
        assert_eq!(named[2].1, "Cam_ X_", "a name that is one name on a path");
    }

    #[test]
    fn a_photo_goes_by_the_day_it_was_taken_here() {
        assert_eq!(day(0), "Undated");
        // Noon UTC is that same day in every time zone from -11 to +11.
        assert_eq!(day(super::super::ticks_from_text("2026-11-26T12:00:00Z")), "2026-11-26");
        let item = Item { name: "a.jpg".into(), size: 5, modified: 7, ..Item::default() };
        assert_eq!(import_key(&item), "a.jpg|5|7");
    }

    #[test]
    #[ignore = "needs a phone plugged in and unlocked"]
    fn prints_a_plugged_in_phones_top_folders() {
        for place in places(&[]) {
            let phone = Phone::new(&place.id);
            println!("{} battery {:?} space {:?}", place.name, phone.battery(), phone.space());
            for item in phone.list("").unwrap() {
                println!("  {} {}", item.name, item.note);
                for child in phone.list(&item.name).unwrap().iter().take(5) {
                    println!("    {} {} {}", child.name, child.folder, child.size);
                }
            }
        }
    }
}
