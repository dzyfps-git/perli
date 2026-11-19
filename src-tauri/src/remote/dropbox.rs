//! Dropbox, through its API v2. Everything goes by path, and what others shared with the user
//! one file at a time shows under "Shared with me".

use std::fs::File;
use std::path::Path;

use reqwest::blocking::Response;
use serde_json::{json, Value};

use super::http::{self, App, Failure, Signed};
use super::{join, Item, Service, Tick, Version};

/// Perli's registration with Dropbox, filled in once it is registered.
const CLIENT_ID: &str = "";
const API: &str = "https://api.dropboxapi.com/2";
const CONTENT: &str = "https://content.dropboxapi.com/2";
/// Files shared with the user one by one, which sit in no folder of theirs.
pub const SHARED: &str = "Shared with me";
/// Files up to this size go in one request; bigger ones in parts of this size.
const PART: u64 = 8 * 1024 * 1024;
/// Files of a deleted folder that Undo brings back one by one, at most.
const MOST_RESTORED: usize = 2000;

pub static APP: App = App {
    authorize: "https://www.dropbox.com/oauth2/authorize",
    token: "https://api.dropboxapi.com/oauth2/token",
    client_id: CLIENT_ID,
    client_secret: None,
    // The app's permissions are set where it is registered.
    scopes: "",
    extra: &[("token_access_type", "offline")],
    name: "Dropbox",
};

pub struct Dropbox {
    signed: Signed,
}

/// Dropbox's path for one inside the place: `""` for the top, else with a leading slash.
fn path_of(path: &str) -> String {
    if path.is_empty() { String::new() } else { format!("/{path}") }
}

/// JSON for the `Dropbox-API-Arg` header, which takes only ASCII: the rest goes as `\u` escapes.
fn header_json(value: &Value) -> String {
    let mut out = String::new();
    for character in value.to_string().chars() {
        if character.is_ascii() {
            out.push(character);
        } else {
            let mut units = [0u16; 2];
            for unit in character.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

fn item_of(value: &Value) -> Item {
    let folder = value[".tag"] == "folder";
    let readable = value["is_downloadable"].as_bool() != Some(false);
    Item {
        name: value["name"].as_str().unwrap_or_default().to_string(),
        folder,
        size: value["size"].as_u64().unwrap_or(0),
        modified: super::ticks_from_text(value["server_modified"].as_str().or(value["time_invited"].as_str()).unwrap_or_default()),
        version: value["rev"].as_str().or(value["content_hash"].as_str()).unwrap_or_default().to_string(),
        id: value["preview_url"].as_str().or(value["id"].as_str()).unwrap_or_default().to_string(),
        note: if readable { String::new() } else { "Opens only on dropbox.com".into() },
        cold: false,
    }
}

/// The folder an item's `path_display` puts it in, inside the place.
fn parent_of_display(value: &Value) -> String {
    let display = value["path_display"].as_str().unwrap_or_default().trim_start_matches('/');
    super::parent_of(display).to_string()
}

impl Dropbox {
    pub fn new(place: &str, refresh: &str) -> Result<Self, String> {
        Ok(Self { signed: Signed::new(&APP, place, refresh) })
    }

    pub fn sign_in() -> Result<(String, String), String> {
        let tokens = http::sign_in(&APP)?;
        let bearer = format!("Bearer {}", tokens.access);
        let me = http::json(http::send(|| http::client().post(format!("{API}/users/get_current_account")).header("authorization", &bearer).header("content-type", "application/json").body("null"))?)?;
        Ok((me["email"].as_str().unwrap_or("Dropbox").to_string(), tokens.refresh))
    }

    fn call(&self, endpoint: &str, body: &Value) -> Result<Value, Failure> {
        let body = body.to_string();
        let address = format!("{API}/{endpoint}");
        http::json(self.signed.send(|bearer| http::client().post(&address).header("authorization", bearer).header("content-type", "application/json").body(body.clone()))?)
    }

    fn content(&self, endpoint: &str, arg: &Value, body: Option<Vec<u8>>, from: u64) -> Result<Response, Failure> {
        let arg = header_json(arg);
        let address = format!("{CONTENT}/{endpoint}");
        self.signed.send(|bearer| {
            let mut request = http::client().post(&address).header("authorization", bearer).header("dropbox-api-arg", &arg);
            if from > 0 {
                request = request.header("range", format!("bytes={from}-"));
            }
            match &body {
                Some(bytes) => request.header("content-type", "application/octet-stream").body(bytes.clone()),
                None => request,
            }
        })
    }

    fn entries(&self, first: &str, body: Value) -> Result<Vec<Value>, String> {
        let mut page = self.call(first, &body)?;
        let mut values = page["entries"].as_array().cloned().unwrap_or_default();
        let next = format!("{first}/continue");
        // A folder's listing says when it has more; shared files just give a cursor while they do.
        while page["has_more"].as_bool().unwrap_or(page["cursor"].is_string()) {
            page = self.call(&next, &json!({ "cursor": page["cursor"] }))?;
            values.extend(page["entries"].as_array().cloned().unwrap_or_default());
        }
        Ok(values)
    }

    fn send_parts(&self, target: &str, file: &mut File, size: u64, tick: Tick) -> Result<(), String> {
        let resume = super::resume::key(&format!("dropbox|{target}"), file, size);
        let mut session = super::resume::load(&resume).unwrap_or_default();
        if session.id.is_empty() {
            let started = http::json(self.content("files/upload_session/start", &json!({ "close": false }), Some(Vec::new()), 0)?)?;
            session.id = started["session_id"].as_str().ok_or("Dropbox didn't start the upload")?.to_string();
            session.done = 0;
        }
        while session.done < size {
            let bytes = http::chunk(file, session.done, PART)?;
            let arg = json!({ "cursor": { "session_id": session.id, "offset": session.done }, "close": false });
            match self.content("files/upload_session/append_v2", &arg, Some(bytes.clone()), 0) {
                Err(failure) if failure.status == 409 || failure.status == 404 => {
                    super::resume::clear(&resume);
                    return Err(format!("{} Try again to send it from the start.", failure.message));
                }
                other => {
                    other?;
                }
            }
            session.done += bytes.len() as u64;
            super::resume::save(&resume, &session);
            if !tick(session.done) {
                return Err(super::STOPPED.into());
            }
        }
        let arg = json!({ "cursor": { "session_id": session.id, "offset": size }, "commit": { "path": target, "mode": "overwrite", "mute": true } });
        self.content("files/upload_session/finish", &arg, Some(Vec::new()), 0)?;
        super::resume::clear(&resume);
        Ok(())
    }

    /// What brings back a folder once deleted: each file in it with its revision, as JSON, or
    /// `""` past `MOST_RESTORED` files.
    // ponytail: reads the whole folder before it goes, a request a 2000 entries; a big one takes a while.
    fn folder_token(&self, path: &str) -> String {
        let Ok(values) = self.entries("files/list_folder", json!({ "path": path_of(path), "recursive": true, "limit": 2000 })) else { return String::new() };
        let files: Vec<Value> = values.iter().filter(|value| value[".tag"] == "file").map(|value| json!([value["path_display"], value["rev"]])).collect();
        if files.len() > MOST_RESTORED {
            return String::new();
        }
        json!({ "folder": path_of(path), "files": files }).to_string()
    }

    fn no_writing(folder: &str) -> Result<(), String> {
        if folder == SHARED || folder.starts_with(&format!("{SHARED}/")) {
            return Err("What others shared one file at a time can be opened and copied, not changed".into());
        }
        Ok(())
    }
}

impl Service for Dropbox {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        if folder == SHARED {
            return Ok(self.entries("sharing/list_received_files", json!({ "limit": 300 }))?.iter().map(item_of).collect());
        }
        let values = self.entries("files/list_folder", json!({ "path": path_of(folder), "limit": 2000, "include_non_downloadable_files": true }))?;
        let mut items: Vec<Item> = values.iter().filter(|value| value[".tag"] != "deleted").map(item_of).collect();
        if folder.is_empty() {
            items.push(Item { name: SHARED.into(), folder: true, note: "Files others shared with you one by one".into(), ..Item::default() });
        }
        Ok(items)
    }

    fn read(&self, path: &str, item: &Item, from: u64, out: &mut dyn std::io::Write, tick: Tick) -> Result<(), String> {
        let response = if super::parent_of(path) == SHARED {
            self.content("sharing/get_shared_link_file", &json!({ "url": item.id }), None, from)?
        } else {
            self.content("files/download", &json!({ "path": path_of(path) }), None, from)?
        };
        http::pour(response, out, from, tick).map(|_| ())
    }

    fn write(&self, folder: &str, name: &str, file: &Path, _replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        Self::no_writing(folder)?;
        let target = path_of(&join(folder, name));
        let mut opened = File::open(file).map_err(|error| error.to_string())?;
        let size = opened.metadata().map_err(|error| error.to_string())?.len();
        if size <= PART {
            let bytes = http::chunk(&mut opened, 0, size)?;
            self.content("files/upload", &json!({ "path": target, "mode": "overwrite", "autorename": false, "mute": true }), Some(bytes), 0)?;
            tick(size);
            return Ok(());
        }
        self.send_parts(&target, &mut opened, size, tick)
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        Self::no_writing(folder)?;
        self.call("files/create_folder_v2", &json!({ "path": path_of(&join(folder, name)), "autorename": false }))?;
        Ok(())
    }

    fn remove(&self, path: &str, item: &Item) -> Result<String, String> {
        Self::no_writing(super::parent_of(path))?;
        // Dropbox brings back a deleted file by its revision, and so a folder by each file in it.
        let token = if item.folder { self.folder_token(path) } else { item.version.clone() };
        self.call("files/delete_v2", &json!({ "path": path_of(path) }))?;
        Ok(token)
    }

    fn erase(&self, path: &str, item: &Item) -> Result<Option<String>, String> {
        Self::no_writing(super::parent_of(path))?;
        // Only a team account may delete for good; others put it in Dropbox's deleted files.
        match self.call("files/permanently_delete", &json!({ "path": path_of(path) })) {
            Ok(_) => Ok(None),
            Err(_) => self.remove(path, item).map(Some),
        }
    }

    fn restore(&self, path: &str, token: &str) -> Result<(), String> {
        if token.is_empty() {
            return Err(format!("Dropbox brings back a folder of more than {MOST_RESTORED} files only from its deleted files on dropbox.com"));
        }
        if let Some(folder) = serde_json::from_str::<Value>(token).ok().filter(Value::is_object) {
            // The folder itself first, so one that was empty comes back too.
            let _ = self.call("files/create_folder_v2", &json!({ "path": folder["folder"], "autorename": false }));
            for file in folder["files"].as_array().into_iter().flatten() {
                self.call("files/restore", &json!({ "path": file[0], "rev": file[1] }))?;
            }
            return Ok(());
        }
        self.call("files/restore", &json!({ "path": path_of(path), "rev": token }))?;
        Ok(())
    }

    fn relocate(&self, path: &str, _item: &Item, folder: &str, name: &str) -> Result<(), String> {
        Self::no_writing(folder)?;
        self.call("files/move_v2", &json!({ "from_path": path_of(path), "to_path": path_of(&join(folder, name)), "autorename": false }))?;
        Ok(())
    }

    fn duplicate(&self, path: &str, _item: &Item, folder: &str, name: &str) -> Result<(), String> {
        Self::no_writing(folder)?;
        self.call("files/copy_v2", &json!({ "from_path": path_of(path), "to_path": path_of(&join(folder, name)), "autorename": false }))?;
        Ok(())
    }

    fn has_bin(&self) -> bool {
        true
    }

    fn thumbnail(&self, path: &str, item: &Item, edge: u32) -> Result<Option<Vec<u8>>, String> {
        if item.folder || super::parent_of(path) == SHARED {
            return Ok(None);
        }
        let size = [(256, "w256h256"), (480, "w480h320"), (640, "w640h480"), (960, "w960h640"), (1024, "w1024h768")].iter().find(|(most, _)| edge <= *most).map_or("w2048h1536", |(_, name)| name);
        let arg = json!({ "resource": { ".tag": "path", "path": path_of(path) }, "format": "jpeg", "size": size, "mode": "fitone_bestfit" });
        match self.content("files/get_thumbnail_v2", &arg, None, 0) {
            Ok(response) => Ok(response.bytes().ok().map(|bytes| bytes.to_vec())),
            Err(failure) if failure.status == 409 => Ok(None),
            Err(failure) => Err(failure.message),
        }
    }

    fn search(&self, folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let found = self.call("files/search_v2", &json!({ "query": text, "options": { "path": path_of(folder), "max_results": 200, "file_status": "active" } }))?;
        Ok(found["matches"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|found| &found["metadata"]["metadata"])
            .map(|value| (parent_of_display(value), item_of(value)))
            .collect())
    }

    fn space(&self) -> Result<Option<(u64, u64)>, String> {
        let usage = self.call("users/get_space_usage", &Value::Null)?;
        Ok(usage["used"].as_u64().zip(usage["allocation"]["allocated"].as_u64()))
    }

    fn share(&self, path: &str, item: &Item) -> Result<String, String> {
        if super::parent_of(path) == SHARED {
            return Ok(item.id.clone());
        }
        match self.call("sharing/create_shared_link_with_settings", &json!({ "path": path_of(path) })) {
            Ok(made) => made["url"].as_str().map(str::to_string).ok_or_else(|| "Dropbox made no link".into()),
            Err(failure) if failure.status == 409 => {
                let links = self.call("sharing/list_shared_links", &json!({ "path": path_of(path), "direct_only": true }))?;
                links["links"][0]["url"].as_str().map(str::to_string).ok_or(failure.message)
            }
            Err(failure) => Err(failure.message),
        }
    }

    fn versions(&self, path: &str, item: &Item) -> Result<Vec<Version>, String> {
        if item.folder || super::parent_of(path) == SHARED {
            return Ok(Vec::new());
        }
        let found = self.call("files/list_revisions", &json!({ "path": path_of(path), "mode": "path", "limit": 30 }))?;
        Ok(found["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .skip(1)
            .map(|value| Version {
                id: value["rev"].as_str().unwrap_or_default().to_string(),
                size: value["size"].as_u64().unwrap_or(0),
                modified: super::ticks_from_text(value["server_modified"].as_str().unwrap_or_default()),
            })
            .collect())
    }

    fn bring_back(&self, path: &str, _item: &Item, version: &str) -> Result<(), String> {
        self.call("files/restore", &json!({ "path": path_of(path), "rev": version }))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_json_is_ascii_and_paths_start_with_a_slash() {
        assert_eq!(header_json(&json!({ "path": "/\u{e9}\u{1f600}" })), r#"{"path":"/\u00e9\ud83d\ude00"}"#);
        assert_eq!(path_of(""), "");
        assert_eq!(path_of("a/b"), "/a/b");
        let value = json!({ ".tag": "file", "name": "b.txt", "size": 3, "rev": "r1", "path_display": "/Work/Notes/b.txt" });
        assert_eq!(parent_of_display(&value), "Work/Notes");
        assert_eq!(item_of(&value).version, "r1");
    }
}
