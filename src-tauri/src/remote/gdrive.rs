//! Google Drive, through its API v3. Drive goes by ids, not names, and lets two files in a
//! folder share a name, so each listing notes the id behind each path, and a second file of a
//! name shows with a number. Google's own Docs, Sheets and Slides come down as Office files,
//! or as PDFs where the place is set so.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde_json::{json, Value};

use super::http::{self, App, Signed};
use super::{join, Item, Service, Tick, Version};

/// Perli's registration with Google, filled in once it is registered. Google gives desktop apps
/// a secret that ships with them; it guards nothing on its own.
const CLIENT_ID: &str = "";
const CLIENT_SECRET: &str = "";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const FIELDS: &str = "id,name,mimeType,size,modifiedTime,version,shortcutDetails";
const FOLDER: &str = "application/vnd.google-apps.folder";
pub const SHARED: &str = "Shared with me";
pub const DRIVES: &str = "Shared drives";
pub const STARRED: &str = "Starred";
/// Parts of an upload: a multiple of 256 KB, as Google asks.
const PART: u64 = 8 * 1024 * 1024;

pub static APP: App = App {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    client_id: CLIENT_ID,
    client_secret: Some(CLIENT_SECRET),
    scopes: "https://www.googleapis.com/auth/drive",
    extra: &[("access_type", "offline"), ("prompt", "consent")],
    name: "Google",
};

/// What a Google file of its own kind comes down as: its type and the end its name gets.
fn export(mime: &str, pdf: bool) -> Option<(&'static str, &'static str)> {
    let office = match mime {
        "application/vnd.google-apps.document" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
        "application/vnd.google-apps.spreadsheet" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
        "application/vnd.google-apps.presentation" => ("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"),
        "application/vnd.google-apps.drawing" => ("image/png", ".png"),
        _ => return None,
    };
    Some(if pdf { ("application/pdf", ".pdf") } else { office })
}

fn kind_name(mime: &str) -> &'static str {
    match mime {
        "application/vnd.google-apps.document" => "Google Doc",
        "application/vnd.google-apps.spreadsheet" => "Google Sheet",
        "application/vnd.google-apps.presentation" => "Google Slides",
        "application/vnd.google-apps.drawing" => "Google Drawing",
        _ => "Opens only in Google Drive",
    }
}

/// What a path stands for in Drive.
#[derive(Clone, Debug, PartialEq)]
struct Known {
    id: String,
    mime: String,
    /// The shared drive it lives on, for a listing of its top.
    drive: Option<String>,
}

pub struct Google {
    signed: Signed,
    pdf: bool,
    known: Mutex<HashMap<String, Known>>,
}

/// `name` with ` (n)` before its type, for the nth file of one name in a folder.
fn numbered(name: &str, number: usize) -> String {
    if number < 2 {
        return name.to_string();
    }
    match name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()) {
        Some((stem, extension)) => format!("{stem} ({number}).{extension}"),
        None => format!("{name} ({number})"),
    }
}

/// A row for each file, with names made unique the way Explorer numbers copies.
fn items_of(values: &[Value], pdf: bool) -> Vec<(Item, Known)> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut rows = Vec::new();
    for value in values {
        let shortcut = &value["shortcutDetails"];
        let (id, mime) = if shortcut.is_null() {
            (value["id"].as_str().unwrap_or_default(), value["mimeType"].as_str().unwrap_or_default())
        } else {
            (shortcut["targetId"].as_str().unwrap_or_default(), shortcut["targetMimeType"].as_str().unwrap_or_default())
        };
        let mut name = value["name"].as_str().unwrap_or_default().to_string();
        let folder = mime == FOLDER;
        let mut note = String::new();
        if let Some((_, extension)) = export(mime, pdf) {
            name.push_str(extension);
            note = kind_name(mime).to_string();
        } else if mime.starts_with("application/vnd.google-apps.") && !folder {
            note = kind_name(mime).to_string();
        }
        let count = seen.entry(name.to_lowercase()).or_default();
        *count += 1;
        let name = numbered(&name, *count);
        let item = Item {
            name,
            folder,
            size: value["size"].as_str().and_then(|size| size.parse().ok()).unwrap_or(0),
            modified: super::ticks_from_text(value["modifiedTime"].as_str().unwrap_or_default()),
            version: value["version"].as_str().unwrap_or_default().to_string(),
            id: id.to_string(),
            note,
            cold: false,
        };
        rows.push((item, Known { id: id.to_string(), mime: mime.to_string(), drive: None }));
    }
    rows
}

fn quoted(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\'', "\\'")
}

impl Google {
    pub fn new(place: &str, refresh: &str, pdf: bool) -> Result<Self, String> {
        Ok(Self { signed: Signed::new(&APP, place, refresh), pdf, known: Mutex::new(HashMap::new()) })
    }

    pub fn sign_in() -> Result<(String, String), String> {
        let tokens = http::sign_in(&APP)?;
        let bearer = format!("Bearer {}", tokens.access);
        let about = http::json(http::send(|| http::client().get(format!("{API}/about?fields=user(emailAddress)")).header("authorization", &bearer))?)?;
        Ok((about["user"]["emailAddress"].as_str().unwrap_or("Google Drive").to_string(), tokens.refresh))
    }

    fn get(&self, address: &str) -> Result<Value, String> {
        self.signed.json(|bearer| http::client().get(address).header("authorization", bearer))
    }

    fn send_json(&self, method: reqwest::Method, address: &str, body: &Value) -> Result<reqwest::blocking::Response, String> {
        let body = body.to_string();
        Ok(self.signed.send(|bearer| http::client().request(method.clone(), address).header("authorization", bearer).header("content-type", "application/json; charset=UTF-8").body(body.clone()))?)
    }

    fn files(&self, query: &str, extra: &str) -> Result<Vec<Value>, String> {
        let mut values = Vec::new();
        let mut token = String::new();
        loop {
            let mut address = url::Url::parse(&format!("{API}/files")).map_err(|error| error.to_string())?;
            address
                .query_pairs_mut()
                .append_pair("q", query)
                .append_pair("fields", &format!("nextPageToken,files({FIELDS})"))
                .append_pair("pageSize", "1000")
                .append_pair("supportsAllDrives", "true")
                .append_pair("includeItemsFromAllDrives", "true");
            for (name, value) in url::form_urlencoded::parse(extra.as_bytes()) {
                address.query_pairs_mut().append_pair(&name, &value);
            }
            if !token.is_empty() {
                address.query_pairs_mut().append_pair("pageToken", &token);
            }
            let page = self.get(address.as_str())?;
            values.extend(page["files"].as_array().cloned().unwrap_or_default());
            match page["nextPageToken"].as_str() {
                Some(next) => token = next.to_string(),
                None => return Ok(values),
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Known>> {
        self.known.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The id behind a path, listing the folders on the way when it isn't known yet.
    fn find(&self, path: &str) -> Result<Known, String> {
        if path.is_empty() {
            return Ok(Known { id: "root".into(), mime: FOLDER.into(), drive: None });
        }
        if let Some(known) = self.lock().get(path).cloned() {
            return Ok(known);
        }
        self.list(super::parent_of(path))?;
        self.lock().get(path).cloned().ok_or_else(|| format!("{path} isn't in Google Drive any more"))
    }

    fn is_virtual(folder: &str) -> bool {
        [SHARED, DRIVES, STARRED].contains(&folder)
    }

    /// A folder that files can go into, as the id to put them under.
    fn writable(&self, folder: &str) -> Result<String, String> {
        if Self::is_virtual(folder) {
            return Err(format!("Files go into a folder, not into {folder} itself"));
        }
        Ok(self.find(folder)?.id)
    }

    /// Where an upload's parts go: a new file in `parent`, or new content for `replace`.
    fn start_upload(&self, parent: &str, name: &str, replace: Option<&str>) -> Result<String, String> {
        let response = match replace {
            Some(id) => self.send_json(reqwest::Method::PATCH, &format!("{UPLOAD}/files/{id}?uploadType=resumable&supportsAllDrives=true"), &json!({}))?,
            None => self.send_json(reqwest::Method::POST, &format!("{UPLOAD}/files?uploadType=resumable&supportsAllDrives=true"), &json!({ "name": name, "parents": [parent] }))?,
        };
        response.headers().get("location").and_then(|value| value.to_str().ok()).map(str::to_string).ok_or_else(|| "Google didn't start the upload".into())
    }

    /// How much of an upload Google holds: all of it once it answers with the file.
    fn landed(session: &str, size: u64) -> Result<u64, String> {
        let response = http::send_with(|| http::client().put(session).header("content-range", format!("bytes */{size}")).body(Vec::new()), |status| status == 308 || (200..300).contains(&status))?;
        Ok(if response.status().as_u16() == 308 { held(&response) } else { size })
    }

    fn send_parts(&self, session: &mut super::resume::Session, resume: &str, file: &mut File, size: u64, tick: Tick) -> Result<(), String> {
        while session.done < size || size == 0 {
            let bytes = http::chunk(file, session.done, PART)?;
            let range = if size == 0 { "bytes */0".to_string() } else { format!("bytes {}-{}/{size}", session.done, session.done + bytes.len() as u64 - 1) };
            let address = session.id.clone();
            let response = http::send_with(|| http::client().put(&address).header("content-range", &range).body(bytes.clone()), |status| status == 308 || (200..300).contains(&status));
            let response = match response {
                Err(failure) if failure.status == 404 || failure.status == 410 => {
                    super::resume::clear(resume);
                    return Err(format!("{} Try again to send it from the start.", failure.message));
                }
                other => other?,
            };
            if response.status().as_u16() != 308 {
                break;
            }
            // Google says how much it holds, which may be less than was sent.
            session.done = held(&response);
            super::resume::save(resume, session);
            if !tick(session.done) {
                return Err(super::STOPPED.into());
            }
        }
        tick(size);
        super::resume::clear(resume);
        Ok(())
    }

    /// The path in the place of a file known only by id, climbing its parents. `None` when it
    /// lies outside My Drive.
    fn path_of_id(&self, id: &str, memo: &mut HashMap<String, Option<String>>) -> Option<String> {
        if id == "root" {
            return Some(String::new());
        }
        if let Some(known) = memo.get(id) {
            return known.clone();
        }
        let found = self.get(&format!("{API}/files/{id}?fields=name,parents,mimeType&supportsAllDrives=true")).ok();
        let path = found.and_then(|value| {
            let parent = value["parents"][0].as_str()?.to_string();
            let name = value["name"].as_str()?.to_string();
            let root = self.get(&format!("{API}/files/root?fields=id")).ok()?["id"].as_str()?.to_string();
            let above = if parent == root { Some(String::new()) } else { self.path_of_id(&parent, memo) }?;
            Some(join(&above, &name))
        });
        memo.insert(id.to_string(), path.clone());
        path
    }
}

impl Service for Google {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        let values = match folder {
            SHARED => self.files("sharedWithMe = true and trashed = false", "")?,
            STARRED => self.files("starred = true and trashed = false", "")?,
            DRIVES => {
                let drives = self.get(&format!("{API}/drives?pageSize=100"))?;
                let mut items = Vec::new();
                let mut known = self.lock();
                for drive in drives["drives"].as_array().into_iter().flatten() {
                    let (id, name) = (drive["id"].as_str().unwrap_or_default(), drive["name"].as_str().unwrap_or_default());
                    known.insert(join(DRIVES, name), Known { id: id.into(), mime: FOLDER.into(), drive: Some(id.into()) });
                    items.push(Item { name: name.into(), folder: true, id: id.into(), ..Item::default() });
                }
                return Ok(items);
            }
            _ => {
                let parent = self.find(folder)?;
                let extra = parent.drive.as_ref().map_or(String::new(), |drive| format!("corpora=drive&driveId={drive}"));
                self.files(&format!("'{}' in parents and trashed = false", quoted(&parent.id)), &extra)?
            }
        };
        let rows = items_of(&values, self.pdf);
        let mut known = self.lock();
        for (item, found) in &rows {
            known.insert(join(folder, &item.name), found.clone());
        }
        let mut items: Vec<Item> = rows.into_iter().map(|(item, _)| item).collect();
        if folder.is_empty() {
            for (name, note) in [(SHARED, "Files and folders others shared with you"), (DRIVES, "Drives you share with a team"), (STARRED, "Files you starred")] {
                items.push(Item { name: name.into(), folder: true, note: note.into(), ..Item::default() });
            }
        }
        Ok(items)
    }

    fn read(&self, path: &str, _item: &Item, from: u64, out: &mut dyn std::io::Write, tick: Tick) -> Result<(), String> {
        let found = self.find(path)?;
        if let Some((mime, _)) = export(&found.mime, self.pdf) {
            let address = format!("{API}/files/{}/export?mimeType={}", found.id, http::encode(mime));
            let response = self.signed.send(|bearer| http::client().get(&address).header("authorization", bearer))?;
            // An export can't start partway, so what came down before is read past.
            let mut skip = SkipWrite { out, left: from };
            return http::pour(response, &mut skip, 0, tick).map(|_| ());
        }
        if found.mime.starts_with("application/vnd.google-apps.") {
            return Err("This kind of Google file opens only in Google Drive".into());
        }
        let address = format!("{API}/files/{}?alt=media&supportsAllDrives=true", found.id);
        let response = self.signed.send(|bearer| {
            let request = http::client().get(&address).header("authorization", bearer);
            if from > 0 { request.header("range", format!("bytes={from}-")) } else { request }
        })?;
        http::pour(response, out, from, tick).map(|_| ())
    }

    fn write(&self, folder: &str, name: &str, file: &Path, replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        let parent = self.writable(folder)?;
        let mut opened = File::open(file).map_err(|error| error.to_string())?;
        let size = opened.metadata().map_err(|error| error.to_string())?.len();
        let replacing = replace.filter(|item| item.note.is_empty()).map(|item| item.id.clone());
        let resume = super::resume::key(&format!("google|{parent}|{name}"), &opened, size);
        let mut session = super::resume::load(&resume).unwrap_or_default();
        if !session.id.is_empty() {
            match Self::landed(&session.id, size) {
                Ok(held) if held >= size => {
                    super::resume::clear(&resume);
                    return Ok(());
                }
                Ok(held) => session.done = held,
                Err(_) => session = super::resume::Session::default(),
            }
        }
        if session.id.is_empty() {
            session.id = self.start_upload(&parent, name, replacing.as_deref())?;
            session.done = 0;
        }
        self.send_parts(&mut session, &resume, &mut opened, size, tick)
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        let parent = self.writable(folder)?;
        self.send_json(reqwest::Method::POST, &format!("{API}/files?supportsAllDrives=true"), &json!({ "name": name, "mimeType": FOLDER, "parents": [parent] }))?;
        Ok(())
    }

    fn remove(&self, path: &str, _item: &Item) -> Result<String, String> {
        let found = self.find(path)?;
        self.send_json(reqwest::Method::PATCH, &format!("{API}/files/{}?supportsAllDrives=true", found.id), &json!({ "trashed": true }))?;
        self.lock().remove(path);
        Ok(found.id)
    }

    fn restore(&self, _path: &str, token: &str) -> Result<(), String> {
        self.send_json(reqwest::Method::PATCH, &format!("{API}/files/{token}?supportsAllDrives=true"), &json!({ "trashed": false }))?;
        Ok(())
    }

    fn relocate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let found = self.find(path)?;
        let from = self.find(super::parent_of(path))?;
        let to = self.writable(folder)?;
        // A Google Doc keeps its name without the type its download gets.
        let name = export(&found.mime, self.pdf).and_then(|(_, extension)| name.strip_suffix(extension)).unwrap_or(name);
        let mut address = format!("{API}/files/{}?supportsAllDrives=true", found.id);
        if from.id != to {
            address.push_str(&format!("&addParents={to}&removeParents={}", from.id));
        }
        self.send_json(reqwest::Method::PATCH, &address, &json!({ "name": name }))?;
        self.lock().remove(path);
        let _ = item;
        Ok(())
    }

    fn duplicate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let found = self.find(path)?;
        let to = self.writable(folder)?;
        if item.folder {
            // Drive copies files only; a folder is made anew and filled.
            self.make_folder(folder, name)?;
            let inner = join(folder, name);
            for child in self.list(path)? {
                self.duplicate(&join(path, &child.name), &child, &inner, &child.name)?;
            }
            return Ok(());
        }
        let name = export(&found.mime, self.pdf).and_then(|(_, extension)| name.strip_suffix(extension)).unwrap_or(name);
        self.send_json(reqwest::Method::POST, &format!("{API}/files/{}/copy?supportsAllDrives=true", found.id), &json!({ "name": name, "parents": [to] }))?;
        Ok(())
    }

    fn has_bin(&self) -> bool {
        true
    }

    fn thumbnail(&self, path: &str, item: &Item, edge: u32) -> Result<Option<Vec<u8>>, String> {
        if item.folder {
            return Ok(None);
        }
        let found = self.find(path)?;
        let link = self.get(&format!("{API}/files/{}?fields=thumbnailLink&supportsAllDrives=true", found.id))?;
        let Some(link) = link["thumbnailLink"].as_str() else { return Ok(None) };
        // The link names its size at the end, as `=s220`.
        let sized = match link.rfind("=s") {
            Some(at) => format!("{}=s{edge}", &link[..at]),
            None => link.to_string(),
        };
        let response = self.signed.send(|bearer| http::client().get(&sized).header("authorization", bearer))?;
        Ok(response.bytes().ok().map(|bytes| bytes.to_vec()))
    }

    fn search(&self, _folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let mut address = url::Url::parse(&format!("{API}/files")).map_err(|error| error.to_string())?;
        address
            .query_pairs_mut()
            .append_pair("q", &format!("name contains '{}' and trashed = false", quoted(text)))
            .append_pair("fields", &format!("files({FIELDS},parents)"))
            .append_pair("pageSize", "100");
        let found = self.get(address.as_str())?;
        let values = found["files"].as_array().cloned().unwrap_or_default();
        let mut memo = HashMap::new();
        let mut results = Vec::new();
        for (value, (item, known)) in values.iter().zip(items_of(&values, self.pdf)) {
            let Some(parent) = value["parents"][0].as_str().and_then(|parent| self.path_of_id(parent, &mut memo)) else { continue };
            self.lock().insert(join(&parent, &item.name), known);
            results.push((parent, item));
        }
        Ok(results)
    }

    fn space(&self) -> Result<Option<(u64, u64)>, String> {
        let about = self.get(&format!("{API}/about?fields=storageQuota"))?;
        let number = |key: &str| about["storageQuota"][key].as_str().and_then(|text| text.parse::<u64>().ok());
        Ok(number("usage").map(|used| (used, number("limit").unwrap_or(0))))
    }

    fn share(&self, path: &str, _item: &Item) -> Result<String, String> {
        let found = self.find(path)?;
        self.send_json(reqwest::Method::POST, &format!("{API}/files/{}/permissions?supportsAllDrives=true", found.id), &json!({ "role": "reader", "type": "anyone" }))?;
        let link = self.get(&format!("{API}/files/{}?fields=webViewLink&supportsAllDrives=true", found.id))?;
        link["webViewLink"].as_str().map(str::to_string).ok_or_else(|| "Google made no link".into())
    }

    fn versions(&self, path: &str, item: &Item) -> Result<Vec<Version>, String> {
        let found = self.find(path)?;
        if item.folder || found.mime.starts_with("application/vnd.google-apps.") {
            return Ok(Vec::new());
        }
        let listed = self.get(&format!("{API}/files/{}/revisions?fields=revisions(id,modifiedTime,size)", found.id))?;
        let mut versions: Vec<Version> = listed["revisions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|value| Version {
                id: value["id"].as_str().unwrap_or_default().to_string(),
                size: value["size"].as_str().and_then(|size| size.parse().ok()).unwrap_or(0),
                modified: super::ticks_from_text(value["modifiedTime"].as_str().unwrap_or_default()),
            })
            .collect();
        // The newest is the file as it is.
        versions.pop();
        versions.reverse();
        Ok(versions)
    }

    fn bring_back(&self, path: &str, item: &Item, version: &str) -> Result<(), String> {
        let found = self.find(path)?;
        let staged = std::env::temp_dir().join(format!("perli-revision-{}", http::random_text(8)));
        let address = format!("{API}/files/{}/revisions/{}?alt=media", found.id, http::encode(version));
        let response = self.signed.send(|bearer| http::client().get(&address).header("authorization", bearer))?;
        let mut file = File::create(&staged).map_err(|error| error.to_string())?;
        http::pour(response, &mut file, 0, &mut |_| true)?;
        drop(file);
        let sent = self.write(super::parent_of(path), &item.name, &staged, Some(item), &mut |_| true);
        let _ = std::fs::remove_file(&staged);
        sent
    }
}

/// The bytes Google's `Range` answer says it holds, as `bytes=0-1234`.
fn held(response: &reqwest::blocking::Response) -> u64 {
    let last = response.headers().get("range").and_then(|value| value.to_str().ok()?.rsplit('-').next()?.parse::<u64>().ok());
    last.map_or(0, |last| last + 1)
}

/// Writes all but the first `left` bytes it is given.
struct SkipWrite<'a> {
    out: &'a mut dyn std::io::Write,
    left: u64,
}

impl std::io::Write for SkipWrite<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let skip = (self.left.min(bytes.len() as u64)) as usize;
        self.left -= skip as u64;
        self.out.write_all(&bytes[skip..])?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_drive_shares_get_numbers_and_docs_get_their_download_type() {
        let values = vec![
            json!({ "id": "1", "name": "Plan", "mimeType": "application/vnd.google-apps.document", "version": "3" }),
            json!({ "id": "2", "name": "a.txt", "mimeType": "text/plain", "size": "5" }),
            json!({ "id": "3", "name": "A.txt", "mimeType": "text/plain", "size": "6" }),
            json!({ "id": "4", "name": "Link", "mimeType": "application/vnd.google-apps.shortcut", "shortcutDetails": { "targetId": "9", "targetMimeType": FOLDER } }),
        ];
        let rows = items_of(&values, false);
        let names: Vec<_> = rows.iter().map(|(item, _)| item.name.as_str()).collect();
        assert_eq!(names, ["Plan.docx", "a.txt", "A (2).txt", "Link"]);
        assert_eq!(rows[0].0.note, "Google Doc");
        assert!(rows[3].0.folder);
        assert_eq!(rows[3].1.id, "9");
        assert_eq!(items_of(&values[..1], true)[0].0.name, "Plan.pdf");
        assert_eq!(numbered("archive.tar.gz", 3), "archive.tar (3).gz");
        assert_eq!(numbered("notes", 2), "notes (2)");
    }

    #[test]
    fn a_resumed_export_skips_what_came_down_before() {
        let mut out = Vec::new();
        let mut skip = SkipWrite { out: &mut out, left: 3 };
        std::io::Write::write_all(&mut skip, b"ab").unwrap();
        std::io::Write::write_all(&mut skip, b"cdef").unwrap();
        assert_eq!(out, b"def");
    }
}
