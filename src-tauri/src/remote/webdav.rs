//! WebDAV, as Nextcloud, ownCloud, Synology, a NAS or IIS serve it: PROPFIND to list, GET and PUT
//! for files, and the server's own MKCOL, MOVE, COPY and DELETE for the rest. It goes straight to
//! the server, so it works with Windows' WebClient service off.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{sync_channel, Receiver};

use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::blocking::{Body, RequestBuilder};
use reqwest::Method;

use super::{http, join, Item, Server, Service, Tick, STOPPED};

/// Rows at most a search looks through, as it lists each folder one by one.
const SEARCH_LIMIT: usize = 20_000;

pub struct WebDav {
    /// The address everything is under, with no `/` at its end.
    base: String,
    user: String,
    password: String,
}

/// A body fed a chunk at a time from the thread that reads the file, so that thread can tell
/// how far it got. An empty chunk ends it; a feed dropped early fails it.
struct Fed {
    from: Receiver<Vec<u8>>,
    held: Vec<u8>,
    at: usize,
}

impl Read for Fed {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.at == self.held.len() {
            self.held = self.from.recv().map_err(|_| std::io::Error::other(STOPPED))?;
            self.at = 0;
        }
        let count = buffer.len().min(self.held.len() - self.at);
        buffer[..count].copy_from_slice(&self.held[self.at..self.at + count]);
        self.at += count;
        Ok(count)
    }
}

impl WebDav {
    pub fn new(server: &Server, password: &str) -> Result<Self, String> {
        let address = server.host.trim();
        let address = if address.contains("://") { address.to_string() } else { format!("https://{address}") };
        let parsed = url::Url::parse(&address).map_err(|_| format!("{address} isn't an address Perli can use"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("A WebDAV address starts with https:// or http://".into());
        }
        Ok(Self { base: address.trim_end_matches('/').to_string(), user: server.user.clone(), password: password.to_string() })
    }

    fn url(&self, path: &str, folder: bool) -> String {
        let mut url = self.base.clone();
        for part in path.split('/').filter(|part| !part.is_empty()) {
            url.push('/');
            url.push_str(&http::encode(part));
        }
        if folder {
            url.push('/');
        }
        url
    }

    fn request(&self, method: &str, url: &str) -> RequestBuilder {
        let method = Method::from_bytes(method.as_bytes()).unwrap_or(Method::GET);
        let request = http::client().request(method, url);
        if self.user.is_empty() { request } else { request.basic_auth(&self.user, Some(&self.password)) }
    }

    fn propfind(&self, path: &str, depth: &str, body: &'static str) -> Result<String, String> {
        let url = self.url(path, true);
        let response = http::send(|| self.request("PROPFIND", &url).header("Depth", depth).header("Content-Type", "application/xml").body(body))?;
        response.text().map_err(|error| error.to_string())
    }

    /// Sends a MOVE or COPY of `path` to `target`, refusing to land on something there.
    fn carry(&self, method: &str, path: &str, item: &Item, target: &str) -> Result<(), String> {
        let (from, to) = (self.url(path, item.folder), self.url(target, item.folder));
        http::send(|| self.request(method, &from).header("Destination", &to).header("Overwrite", "F"))?;
        Ok(())
    }
}

const LIST_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>"#;
const SPACE_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>"#;

/// One `<response>` of a multistatus answer: its address and the properties it was given.
#[derive(Debug, Default, PartialEq)]
struct Entry {
    href: String,
    folder: bool,
    size: u64,
    modified: String,
    etag: String,
    used: Option<u64>,
    free: Option<u64>,
}

fn entries(xml: &str) -> Vec<Entry> {
    let mut reader = Reader::from_str(xml);
    let (mut found, mut current, mut tag) = (Vec::new(), None::<Entry>, String::new());
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                let name = start.local_name().as_ref().to_string();
                if name == "response" {
                    current = Some(Entry::default());
                }
                if name == "collection" {
                    current.iter_mut().for_each(|entry| entry.folder = true);
                }
                tag = name;
            }
            Ok(Event::Empty(empty)) => {
                if empty.local_name().as_ref() == "collection" {
                    current.iter_mut().for_each(|entry| entry.folder = true);
                }
            }
            Ok(Event::Text(text)) => {
                let Some(entry) = current.as_mut() else { continue };
                let text = text.xml10_content().to_string();
                match tag.as_str() {
                    "href" => entry.href.push_str(&text),
                    "getcontentlength" => entry.size = text.trim().parse().unwrap_or(0),
                    "getlastmodified" => entry.modified.push_str(&text),
                    "getetag" => entry.etag.push_str(&text),
                    "quota-used-bytes" => entry.used = text.trim().parse().ok(),
                    "quota-available-bytes" => entry.free = text.trim().parse().ok(),
                    _ => {}
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                let Some(entry) = current.as_mut() else { continue };
                let named = match reference.as_ref() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    _ => reference.resolve_char_ref().ok().flatten(),
                };
                match tag.as_str() {
                    "href" => entry.href.extend(named),
                    "getetag" => entry.etag.extend(named),
                    _ => {}
                }
            }
            Ok(Event::End(end)) => {
                if end.local_name().as_ref() == "response" {
                    found.extend(current.take());
                }
                tag.clear();
            }
            Ok(Event::Eof) | Err(_) => return found,
            _ => {}
        }
    }
}

/// The path part of an href, decoded, with no `/` at either end.
fn href_path(href: &str) -> String {
    let path = url::Url::parse(href).map_or_else(|_| href.to_string(), |url| url.path().to_string());
    percent_encoding::percent_decode_str(path.trim_matches('/')).decode_utf8_lossy().to_string()
}

/// An HTTP date, such as `Wed, 26 Nov 2026 09:30:00 GMT`, as FILETIME ticks. 0 for anything else.
fn ticks_of_http_date(text: &str) -> u64 {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let parts: Vec<&str> = text.split_whitespace().collect();
    let [_, day, month, year, time, ..] = parts[..] else { return 0 };
    let Some(month) = MONTHS.iter().position(|name| month.eq_ignore_ascii_case(name)) else { return 0 };
    let (Ok(day), Ok(year)) = (day.parse::<u32>(), year.parse::<u32>()) else { return 0 };
    super::ticks_from_text(&format!("{year:04}-{:02}-{day:02}T{time}Z", month + 1))
}

/// The rows of a folder's listing, leaving out the folder itself.
fn items_of(xml: &str, folder_url: &str) -> Vec<Item> {
    let own = href_path(folder_url);
    entries(xml)
        .into_iter()
        .filter_map(|entry| {
            let path = href_path(&entry.href);
            if path == own {
                return None;
            }
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            let modified = ticks_of_http_date(&entry.modified);
            let version = if entry.etag.is_empty() { format!("{}-{modified}", entry.size) } else { entry.etag.trim_matches('"').to_string() };
            Some(Item { name: super::local_name(&name), folder: entry.folder, size: if entry.folder { 0 } else { entry.size }, modified, version, ..Item::default() })
        })
        .collect()
}

impl Service for WebDav {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        let xml = self.propfind(folder, "1", LIST_BODY)?;
        Ok(items_of(&xml, &self.url(folder, true)))
    }

    fn read(&self, path: &str, _item: &Item, from: u64, out: &mut dyn Write, tick: Tick) -> Result<(), String> {
        let url = self.url(path, false);
        let response = http::send(|| {
            let request = self.request("GET", &url);
            if from > 0 { request.header("Range", format!("bytes={from}-")) } else { request }
        })?;
        // 206 is the part asked for; a server that sends all of it again answers 200.
        let skip = if from > 0 && response.status().as_u16() != 206 { from } else { 0 };
        let mut body = response;
        std::io::copy(&mut (&mut body).take(skip), &mut std::io::sink()).map_err(|error| format!("The download broke off: {error}"))?;
        http::pour(body, out, 0, tick).map(|_| ())
    }

    fn write(&self, folder: &str, name: &str, file: &Path, _replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        let url = self.url(&join(folder, name), false);
        let mut opened = File::open(file).map_err(|error| error.to_string())?;
        let size = opened.metadata().map_err(|error| error.to_string())?.len();
        let (feed, fed) = sync_channel::<Vec<u8>>(4);
        std::thread::scope(|scope| {
            // ponytail: one PUT, so a send that trips starts over; chunked uploads differ on each server.
            let sending = scope.spawn(move || self.request("PUT", &url).body(Body::sized(Fed { from: fed, held: Vec::new(), at: 0 }, size)).send());
            let mut buffer = vec![0u8; 256 * 1024];
            let mut done = 0u64;
            let fed_all = loop {
                let read = match opened.read(&mut buffer) {
                    Ok(read) => read,
                    Err(error) => break Err(error.to_string()),
                };
                if read == 0 {
                    let _ = feed.send(Vec::new());
                    break Ok(());
                }
                if feed.send(buffer[..read].to_vec()).is_err() {
                    // The request ended early; its answer says why.
                    break Ok(());
                }
                done += read as u64;
                if !tick(done) {
                    break Err(STOPPED.to_string());
                }
            };
            drop(feed);
            let answer = sending.join().map_err(|_| "The send broke off".to_string())?;
            fed_all?;
            let response = answer.map_err(|error| format!("The send broke off: {error}"))?;
            if !response.status().is_success() {
                return Err(format!("The server refused the file ({})", response.status().as_u16()));
            }
            Ok(())
        })
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        let url = self.url(&join(folder, name), true);
        http::send(|| self.request("MKCOL", &url))?;
        Ok(())
    }

    fn remove(&self, path: &str, item: &Item) -> Result<String, String> {
        let url = self.url(path, item.folder);
        http::send(|| self.request("DELETE", &url))?;
        Ok(String::new())
    }

    fn restore(&self, _path: &str, _token: &str) -> Result<(), String> {
        Err("This server keeps no bin Perli can reach".into())
    }

    fn relocate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        self.carry("MOVE", path, item, &join(folder, name))
    }

    fn duplicate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        self.carry("COPY", path, item, &join(folder, name))
    }

    fn has_bin(&self) -> bool {
        false
    }

    fn search(&self, folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let needle = text.to_lowercase();
        let (mut found, mut todo, mut seen) = (Vec::new(), vec![folder.to_string()], 0);
        // ponytail: walks folder by folder, as many servers refuse Depth: infinity; stops at SEARCH_LIMIT rows.
        while let Some(path) = todo.pop() {
            for item in self.list(&path)? {
                seen += 1;
                if item.folder {
                    todo.push(join(&path, &item.name));
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
    }

    fn space(&self) -> Result<Option<(u64, u64)>, String> {
        let xml = self.propfind("", "0", SPACE_BODY)?;
        let top = entries(&xml).into_iter().next().unwrap_or_default();
        Ok(top.used.zip(top.free).map(|(used, free)| (used, used + free)))
    }

    fn share(&self, _path: &str, _item: &Item) -> Result<String, String> {
        Err("Share it from the server's own site: WebDAV has no links to give".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/files/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/files/me/Photos/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Wed, 18 Nov 2026 09:30:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
  <d:response><d:href>https://cloud.example.com/dav/files/me/a%20b%26c.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getetag>&quot;abc&quot;</d:getetag></d:prop></d:propstat></d:response>
</d:multistatus>"#;

    #[test]
    fn a_listing_gives_its_rows_but_not_the_folder_itself() {
        let items = items_of(LISTING, "https://cloud.example.com/dav/files/me/");
        assert_eq!(items.len(), 2);
        assert_eq!((items[0].name.as_str(), items[0].folder), ("Photos", true));
        assert_eq!(items[0].modified, super::super::ticks_from_text("2026-11-18T09:30:00Z"));
        assert_eq!((items[1].name.as_str(), items[1].folder, items[1].size), ("a b&c.txt", false, 12));
        assert_eq!(items[1].version, "abc");
    }

    #[test]
    fn addresses_take_each_part_encoded() {
        let server = Server { host: "cloud.example.com/dav/".into(), ..Server::default() };
        let dav = WebDav::new(&server, "").unwrap();
        assert_eq!(dav.url("a b/c#d.txt", false), "https://cloud.example.com/dav/a%20b/c%23d.txt");
        assert_eq!(dav.url("", true), "https://cloud.example.com/dav/");
        assert!(WebDav::new(&Server { host: "ftp://x".into(), ..Server::default() }, "").is_err());
        assert_eq!(ticks_of_http_date("nonsense"), 0);
    }
}
