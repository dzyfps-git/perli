//! OneDrive, personal or for work and school, through Microsoft Graph. Its own files go by
//! path; what others shared goes by the ids its listing gave, under "Shared with me".

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::http::{self, App, Signed};
use super::{join, Item, Service, Tick, Version};

/// Perli's registration with Microsoft, filled in once it is registered.
const CLIENT_ID: &str = "";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
/// The folder at the top that holds what others shared.
pub const SHARED: &str = "Shared with me";
/// Files up to this size go in one request; bigger ones in parts of this size, a multiple of 320 KB as Graph asks.
const PART: u64 = 10 * 1024 * 1024;
const SMALL: u64 = 4 * 1024 * 1024;
/// How long a copy made by OneDrive itself is waited for.
const COPY_WAIT: Duration = Duration::from_secs(15 * 60);

pub static APP: App = App {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    client_id: CLIENT_ID,
    client_secret: None,
    scopes: "Files.ReadWrite.All User.Read offline_access",
    extra: &[("prompt", "select_account")],
    name: "Microsoft",
};

/// Where an item of another's drive is.
#[derive(Clone)]
struct Ref {
    drive: String,
    id: String,
}

pub struct OneDrive {
    signed: Signed,
    /// Items under "Shared with me", by path, as their listings gave them.
    shared: Mutex<HashMap<String, Ref>>,
}

fn encode_path(path: &str) -> String {
    path.split('/').map(super::http::encode).collect::<Vec<_>>().join("/")
}

fn item_of(value: &Value) -> Item {
    let remote = &value["remoteItem"];
    let pick = |key: &str| if value[key].is_null() { &remote[key] } else { &value[key] };
    let folder = !pick("folder").is_null() || !pick("package").is_null();
    Item {
        name: value["name"].as_str().unwrap_or_default().to_string(),
        folder,
        size: pick("size").as_u64().unwrap_or(0),
        modified: super::ticks_from_text(pick("lastModifiedDateTime").as_str().unwrap_or_default()),
        version: value["cTag"].as_str().or(value["eTag"].as_str()).unwrap_or_default().to_string(),
        id: value["id"].as_str().unwrap_or_default().to_string(),
        note: if pick("package").is_null() { String::new() } else { "OneNote notebook".into() },
        cold: false,
    }
}

impl OneDrive {
    pub fn new(place: &str, refresh: &str) -> Result<Self, String> {
        Ok(Self { signed: Signed::new(&APP, place, refresh), shared: Mutex::new(HashMap::new()) })
    }

    /// Signs in and says who did, for the place's name.
    pub fn sign_in() -> Result<(String, String), String> {
        let tokens = http::sign_in(&APP)?;
        let me = http::json(http::send(|| http::client().get(format!("{GRAPH}/me")).header("authorization", format!("Bearer {}", tokens.access)))?)?;
        let who = me["userPrincipalName"].as_str().or(me["mail"].as_str()).unwrap_or("OneDrive").to_string();
        Ok((who, tokens.refresh))
    }

    fn known(&self, path: &str) -> Option<Ref> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner).get(path).cloned()
    }

    fn is_shared(path: &str) -> bool {
        path == SHARED || path.starts_with(&format!("{SHARED}/"))
    }

    /// Graph's address of an item, without a trailing `:`.
    fn address(&self, path: &str) -> Result<String, String> {
        if path.is_empty() {
            return Ok(format!("{GRAPH}/me/drive/root"));
        }
        if Self::is_shared(path) {
            let found = self.known(path).ok_or("Open Shared with me again to reach this")?;
            return Ok(format!("{GRAPH}/drives/{}/items/{}", found.drive, found.id));
        }
        Ok(format!("{GRAPH}/me/drive/root:/{}:", encode_path(path)))
    }

    /// The address of `name` in `folder`, which may not exist yet, ready for `/content` and the like.
    fn child(&self, folder: &str, name: &str) -> Result<String, String> {
        if folder == SHARED {
            return Err("Files go into a folder someone shared, not into Shared with me itself".into());
        }
        if Self::is_shared(folder) {
            let found = self.known(folder).ok_or("Open Shared with me again to reach this")?;
            return Ok(format!("{GRAPH}/drives/{}/items/{}:/{}:", found.drive, found.id, super::http::encode(name)));
        }
        Ok(format!("{GRAPH}/me/drive/root:/{}:", encode_path(&join(folder, name))))
    }

    /// Ends an address made for a path with what Graph wants after the item: `/children` and the like.
    fn then(address: &str, rest: &str) -> String {
        format!("{address}{rest}")
    }

    fn pages(&self, first: String) -> Result<Vec<Value>, String> {
        let mut values = Vec::new();
        let mut next = Some(first);
        while let Some(address) = next.take() {
            let page = self.signed.json(|bearer| http::client().get(&address).header("authorization", bearer))?;
            values.extend(page["value"].as_array().cloned().unwrap_or_default());
            next = page["@odata.nextLink"].as_str().map(str::to_string);
        }
        Ok(values)
    }

    fn remember(&self, folder: &str, values: &[Value]) {
        let mut shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        for value in values {
            let remote = &value["remoteItem"];
            let (drive, id) = if remote.is_null() {
                (value["parentReference"]["driveId"].as_str(), value["id"].as_str())
            } else {
                (remote["parentReference"]["driveId"].as_str(), remote["id"].as_str())
            };
            if let (Some(drive), Some(id), Some(name)) = (drive, id, value["name"].as_str()) {
                shared.insert(join(folder, name), Ref { drive: drive.into(), id: id.into() });
            }
        }
    }

    fn folder_ref(&self, folder: &str) -> Result<Value, String> {
        let address = self.address(folder)?;
        self.signed.json(|bearer| http::client().get(&address).header("authorization", bearer))
    }

    fn post(&self, address: &str, body: &Value) -> Result<reqwest::blocking::Response, String> {
        let body = body.to_string();
        Ok(self.signed.send(|bearer| http::client().post(address).header("authorization", bearer).header("content-type", "application/json").body(body.clone()))?)
    }

    fn upload_session(&self, address: &str, file: &mut File, size: u64, tick: Tick) -> Result<(), String> {
        let resume = super::resume::key(address, file, size);
        let mut session = super::resume::load(&resume).unwrap_or_default();
        if !session.id.is_empty() {
            // Where OneDrive wants the next part, as it may have more than was noted.
            match http::send(|| http::client().get(&session.id)).and_then(http::json) {
                Ok(status) => {
                    let next = status["nextExpectedRanges"][0].as_str().and_then(|range| range.split('-').next()?.parse().ok());
                    session.done = next.unwrap_or(session.done);
                }
                Err(_) => session = super::resume::Session::default(),
            }
        }
        if session.id.is_empty() {
            let started = self.post(&Self::then(address, "/createUploadSession"), &json!({ "item": { "@microsoft.graph.conflictBehavior": "replace" } }))?;
            let started = http::json(started)?;
            session.id = started["uploadUrl"].as_str().ok_or("OneDrive didn't start the upload")?.to_string();
            session.done = 0;
        }
        while session.done < size {
            let bytes = http::chunk(file, session.done, PART)?;
            let end = session.done + bytes.len() as u64 - 1;
            let range = format!("bytes {}-{end}/{size}", session.done);
            let url = session.id.clone();
            // The upload's own address needs no key, and Graph refuses one sent there.
            match http::send(|| http::client().put(&url).header("content-range", &range).body(bytes.clone())) {
                Err(failure) if failure.status == 404 => {
                    super::resume::clear(&resume);
                    return Err(format!("{} Try again to send it from the start.", failure.message));
                }
                other => {
                    other?;
                }
            }
            session.done = end + 1;
            super::resume::save(&resume, &session);
            if !tick(session.done) {
                return Err(super::STOPPED.into());
            }
        }
        super::resume::clear(&resume);
        Ok(())
    }
}

impl Service for OneDrive {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        if folder == SHARED {
            let values = self.pages(format!("{GRAPH}/me/drive/sharedWithMe"))?;
            self.remember(folder, &values);
            return Ok(values.iter().map(item_of).collect());
        }
        let values = self.pages(Self::then(&self.address(folder)?, "/children?$top=1000"))?;
        if Self::is_shared(folder) {
            self.remember(folder, &values);
        }
        let mut items: Vec<Item> = values.iter().map(item_of).collect();
        if folder.is_empty() {
            items.push(Item { name: SHARED.into(), folder: true, note: "Files and folders others shared with you".into(), ..Item::default() });
        }
        Ok(items)
    }

    fn read(&self, path: &str, _item: &Item, from: u64, out: &mut dyn std::io::Write, tick: Tick) -> Result<(), String> {
        let address = Self::then(&self.address(path)?, "/content");
        let response = self.signed.send(|bearer| {
            let request = http::client().get(&address).header("authorization", bearer);
            if from > 0 { request.header("range", format!("bytes={from}-")) } else { request }
        })?;
        http::pour(response, out, from, tick).map(|_| ())
    }

    fn write(&self, folder: &str, name: &str, file: &Path, _replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        let address = self.child(folder, name)?;
        let mut opened = File::open(file).map_err(|error| error.to_string())?;
        let size = opened.metadata().map_err(|error| error.to_string())?.len();
        if size <= SMALL {
            let bytes = http::chunk(&mut opened, 0, size)?;
            let target = Self::then(&address, "/content?@microsoft.graph.conflictBehavior=replace");
            self.signed.send(|bearer| http::client().put(&target).header("authorization", bearer).body(bytes.clone()))?;
            tick(size);
            return Ok(());
        }
        self.upload_session(&address, &mut opened, size, tick)
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        if folder == SHARED {
            return Err("Folders go into a folder someone shared, not into Shared with me itself".into());
        }
        let target = Self::then(&self.address(folder)?, "/children");
        self.post(&target, &json!({ "name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail" }))?;
        Ok(())
    }

    fn remove(&self, path: &str, _item: &Item) -> Result<String, String> {
        let found = self.folder_ref(path)?;
        let (drive, id) = (found["parentReference"]["driveId"].as_str().unwrap_or_default().to_string(), found["id"].as_str().unwrap_or_default().to_string());
        let address = self.address(path)?;
        self.signed.send(|bearer| http::client().delete(&address).header("authorization", bearer))?;
        Ok(format!("{drive}:{id}"))
    }

    fn erase(&self, path: &str, item: &Item) -> Result<Option<String>, String> {
        // Work and school accounts delete for good; a personal one puts it in its recycle bin.
        let address = Self::then(&self.address(path)?, "/permanentDelete");
        match self.post(&address, &json!({})) {
            Ok(_) => Ok(None),
            Err(_) => self.remove(path, item).map(Some),
        }
    }

    fn restore(&self, _path: &str, token: &str) -> Result<(), String> {
        let (drive, id) = token.split_once(':').ok_or("Nothing to bring back")?;
        self.post(&format!("{GRAPH}/drives/{drive}/items/{id}/restore"), &json!({}))
            .map_err(|message| format!("{message}. OneDrive brings back deleted files only for personal accounts here; a work account's are in its recycle bin on the web."))?;
        Ok(())
    }

    fn relocate(&self, path: &str, _item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let target = self.folder_ref(folder)?;
        let address = self.address(path)?;
        let body = json!({ "name": name, "parentReference": { "id": target["id"], "driveId": target["parentReference"]["driveId"] } }).to_string();
        self.signed.send(|bearer| http::client().patch(&address).header("authorization", bearer).header("content-type", "application/json").body(body.clone()))?;
        Ok(())
    }

    fn duplicate(&self, path: &str, _item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let target = self.folder_ref(folder)?;
        let started = self.post(&Self::then(&self.address(path)?, "/copy"), &json!({ "name": name, "parentReference": { "id": target["id"], "driveId": target["parentReference"]["driveId"] } }))?;
        let monitor = started.headers().get("location").and_then(|value| value.to_str().ok()).ok_or("OneDrive didn't say where to follow the copy")?.to_string();
        let deadline = Instant::now() + COPY_WAIT;
        while Instant::now() < deadline {
            let status = http::json(http::send(|| http::client().get(&monitor))?)?;
            match status["status"].as_str() {
                Some("completed") => return Ok(()),
                Some("failed") => return Err(status["error"]["message"].as_str().unwrap_or("OneDrive's copy failed").to_string()),
                _ => std::thread::sleep(Duration::from_secs(1)),
            }
        }
        Err("OneDrive is still copying; it will finish on its own".into())
    }

    fn has_bin(&self) -> bool {
        true
    }

    fn thumbnail(&self, path: &str, item: &Item, edge: u32) -> Result<Option<Vec<u8>>, String> {
        if item.folder {
            return Ok(None);
        }
        let address = Self::then(&self.address(path)?, &format!("/thumbnails/0/c{edge}x{edge}/content"));
        match self.signed.send(|bearer| http::client().get(&address).header("authorization", bearer)) {
            Ok(response) => Ok(response.bytes().ok().map(|bytes| bytes.to_vec())),
            Err(failure) if failure.status == 404 => Ok(None),
            Err(failure) => Err(failure.message),
        }
    }

    fn search(&self, _folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let quoted = text.replace('\'', "''");
        let values = self.pages(format!("{GRAPH}/me/drive/root/search(q='{}')?$top=200", super::http::encode(&quoted)))?;
        Ok(values
            .iter()
            .map(|value| {
                let parent = value["parentReference"]["path"].as_str().unwrap_or_default();
                let parent = parent.split_once("root:").map_or("", |(_, rest)| rest).trim_start_matches('/');
                let parent = url::form_urlencoded::parse(format!("x={parent}").as_bytes()).next().map(|(_, decoded)| decoded.into_owned()).unwrap_or_default();
                (parent, item_of(value))
            })
            .collect())
    }

    fn space(&self) -> Result<Option<(u64, u64)>, String> {
        let drive = self.signed.json(|bearer| http::client().get(format!("{GRAPH}/me/drive")).header("authorization", bearer))?;
        Ok(drive["quota"]["used"].as_u64().zip(drive["quota"]["total"].as_u64()))
    }

    fn share(&self, path: &str, _item: &Item) -> Result<String, String> {
        let address = Self::then(&self.address(path)?, "/createLink");
        let made = self.post(&address, &json!({ "type": "view", "scope": "anonymous" })).or_else(|_| self.post(&address, &json!({ "type": "view", "scope": "organization" })))?;
        let made = http::json(made)?;
        made["link"]["webUrl"].as_str().map(str::to_string).ok_or_else(|| "OneDrive made no link".into())
    }

    fn versions(&self, path: &str, item: &Item) -> Result<Vec<Version>, String> {
        if item.folder {
            return Ok(Vec::new());
        }
        let values = self.pages(Self::then(&self.address(path)?, "/versions"))?;
        Ok(values
            .iter()
            .skip(1)
            .map(|value| Version {
                id: value["id"].as_str().unwrap_or_default().to_string(),
                size: value["size"].as_u64().unwrap_or(0),
                modified: super::ticks_from_text(value["lastModifiedDateTime"].as_str().unwrap_or_default()),
            })
            .collect())
    }

    fn revision(&self, path: &str, item: &Item) -> Result<Option<String>, String> {
        if item.folder {
            return Ok(None);
        }
        // The first is the file as it is.
        let values = self.pages(Self::then(&self.address(path)?, "/versions"))?;
        Ok(values.first().and_then(|value| value["id"].as_str()).map(str::to_string))
    }

    fn bring_back(&self, path: &str, _item: &Item, version: &str) -> Result<(), String> {
        let address = Self::then(&self.address(path)?, &format!("/versions/{}/restoreVersion", super::http::encode(version)));
        self.post(&address, &json!({}))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_s_items_read_as_rows() {
        let file = json!({ "name": "a.txt", "size": 5, "lastModifiedDateTime": "1970-01-01T00:00:01Z", "cTag": "c1", "id": "X", "file": {} });
        let item = item_of(&file);
        assert_eq!((item.name.as_str(), item.folder, item.size, item.version.as_str()), ("a.txt", false, 5, "c1"));
        assert_eq!(item.modified, 116_444_736_010_000_000);
        let shared = json!({ "name": "Team", "id": "Y", "remoteItem": { "id": "R", "folder": {}, "size": 9, "parentReference": { "driveId": "D" } } });
        assert!(item_of(&shared).folder);
        assert_eq!(item_of(&shared).size, 9);
        assert_eq!(encode_path("a b/c#d"), "a%20b/c%23d");
    }
}
