//! S3 and the storage that speaks its language: Amazon, Cloudflare R2, Backblaze B2, Wasabi,
//! MinIO. Each request is signed with Signature Version 4 from the key Windows keeps.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::blocking::{RequestBuilder, Response};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::http::{self, encode, Failure};
use super::{join, Item, Service, Tick, Version};

/// Files up to this size go in one request. Bigger ones go in parts of it, each one kept.
const PART: u64 = 16 * 1024 * 1024;
/// Links last as long as S3 lets a signed one: a week.
const LINK_SECONDS: u64 = 7 * 24 * 3600;
/// A search reads at most this many names.
const MOST_SEARCHED: usize = 100_000;
/// One copy request holds up to 5 GB. A bigger file is copied by the service in parts of this size.
const COPY_MOST: u64 = 5 * 1024 * 1024 * 1024;
const COPY_PART: u64 = 1024 * 1024 * 1024;
/// DeleteObjects takes up to this many keys at once.
const DELETE_MOST: usize = 1000;
/// A file restored from Glacier stays readable this many days.
const RESTORED_DAYS: u32 = 7;

const UNSIGNED: &str = "UNSIGNED-PAYLOAD";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// Which service it is, such as "aws" or "r2", for the settings to show.
    pub preset: String,
    /// Such as `https://s3.eu-west-1.amazonaws.com`, without the bucket.
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    /// The bucket in the path rather than in the host name, as MinIO wants.
    #[serde(default)]
    pub path_style: bool,
    pub key_id: String,
}

pub struct S3 {
    setup: Setup,
    secret: String,
}

fn encode_path(key: &str) -> String {
    key.split('/').map(encode).collect::<Vec<_>>().join("/")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hmac(key: &[u8], text: &str) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key length works");
    mac.update(text.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// `seconds` after 1970 as S3's date and time, such as `20130524` and `20130524T000000Z`.
fn stamp(seconds: u64) -> (String, String) {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // The civil date of a day count, the inverse of the one in `parse_time`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let of_era = z - era * 146_097;
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 { shifted + 3 } else { shifted - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let date = format!("{year:04}{month:02}{day:02}");
    let time = format!("{date}T{:02}{:02}{:02}Z", rest / 3600, rest / 60 % 60, rest % 60);
    (date, time)
}

/// What Signature Version 4 signs: the request in a fixed form, under the day's key.
struct Signing<'a> {
    key_id: &'a str,
    secret: &'a str,
    region: &'a str,
    method: &'a str,
    host: &'a str,
    path: &'a str,
    /// Already encoded, sorted by name.
    query: Vec<(String, String)>,
    /// Lowercase names, signed and sent.
    headers: Vec<(String, String)>,
    payload: &'a str,
}

impl Signing<'_> {
    fn signature(&self, date: &str, time: &str) -> (String, String) {
        let mut headers = self.headers.clone();
        headers.push(("host".into(), self.host.into()));
        headers.sort();
        let canonical_headers: String = headers.iter().map(|(name, value)| format!("{name}:{}\n", value.trim())).collect();
        let signed = headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(";");
        let mut query = self.query.clone();
        query.sort();
        let query = query.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&");
        let canonical = format!("{}\n{}\n{query}\n{canonical_headers}\n{signed}\n{}", self.method, self.path, self.payload);
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let to_sign = format!("AWS4-HMAC-SHA256\n{time}\n{scope}\n{}", hex(&Sha256::digest(canonical.as_bytes())));
        let mut key = hmac(format!("AWS4{}", self.secret).as_bytes(), date);
        for part in [self.region, "s3", "aws4_request"] {
            key = hmac(&key, part);
        }
        (hex(&hmac(&key, &to_sign)), signed)
    }

    fn authorization(&self, date: &str, time: &str) -> String {
        let (signature, signed) = self.signature(date, time);
        format!("AWS4-HMAC-SHA256 Credential={}/{date}/{}/s3/aws4_request, SignedHeaders={signed}, Signature={signature}", self.key_id, self.region)
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_secs())
}

/// Each `<record>`'s children as name to text, in order.
fn records(xml: &str, record: &str) -> Vec<HashMap<String, String>> {
    let mut reader = Reader::from_str(xml);
    let (mut found, mut current, mut tag) = (Vec::new(), None::<HashMap<String, String>>, String::new());
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                let name = start.local_name().as_ref().to_string();
                if name == record {
                    current = Some(HashMap::new());
                }
                tag = name;
            }
            Ok(Event::Text(text)) => {
                if let Some(fields) = current.as_mut() {
                    fields.entry(tag.clone()).or_default().push_str(&text.xml10_content());
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if let Some(fields) = current.as_mut() {
                    let named = match reference.as_ref() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => reference.resolve_char_ref().ok().flatten(),
                    };
                    fields.entry(tag.clone()).or_default().extend(named);
                }
            }
            Ok(Event::End(end)) => {
                if end.local_name().as_ref() == record {
                    found.extend(current.take());
                }
                tag.clear();
            }
            Ok(Event::Eof) | Err(_) => return found,
            _ => {}
        }
    }
}

/// The XML that ends a multipart upload or copy: each part's number and tag.
fn completed(tags: &[String]) -> String {
    let parts: String = tags.iter().enumerate().map(|(at, tag)| format!("<Part><PartNumber>{}</PartNumber><ETag>{tag}</ETag></Part>", at + 1)).collect();
    format!("<CompleteMultipartUpload>{parts}</CompleteMultipartUpload>")
}

/// Where each part of a copy of `size` bytes starts and ends, both counted.
fn copy_ranges(size: u64) -> Vec<(u64, u64)> {
    (0..size.div_ceil(COPY_PART)).map(|at| (at * COPY_PART, ((at + 1) * COPY_PART).min(size) - 1)).collect()
}

/// A DeleteObjects body for `keys`, which answers only of keys it couldn't delete.
fn delete_body(keys: &[String]) -> String {
    let objects: String = keys.iter().map(|key| format!("<Object><Key>{}</Key></Object>", quick_xml::escape::escape(key.as_str()))).collect();
    format!("<Delete><Quiet>true</Quiet>{objects}</Delete>")
}

/// The headers of a body Amazon wants a checksum of, as DeleteObjects and RestoreObject do.
fn summed(body: &str) -> Vec<(&'static str, String)> {
    use base64::Engine;
    vec![
        ("content-type", "application/xml".into()),
        ("x-amz-checksum-sha256", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(body.as_bytes()))),
        ("x-amz-sdk-checksum-algorithm", "SHA256".into()),
    ]
}

/// What a row says of a file's storage class, and whether it can be restored from Glacier now:
/// a cold one with no copy restored or on its way, as Amazon's `RestoreStatus` tells.
fn class_of(fields: &HashMap<String, String>) -> (String, bool) {
    let Some(class) = fields.get("StorageClass").filter(|class| *class != "STANDARD") else { return (String::new(), false) };
    let name = class_name(class);
    if !matches!(class.as_str(), "GLACIER" | "DEEP_ARCHIVE") {
        return (name, false);
    }
    let short = name.split(':').next().unwrap_or_default();
    if fields.get("IsRestoreInProgress").is_some_and(|going| going == "true") {
        return (format!("{short}: coming back, opens in a few hours"), false);
    }
    match fields.get("RestoreExpiryDate") {
        Some(until) => (format!("{short}: restored until {}", until.get(..10).unwrap_or(until)), false),
        None => (name, true),
    }
}

/// The text of the first `<tag>` anywhere.
fn first(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = xml[start..].find(&format!("</{tag}>"))?;
    Some(xml[start..start + end].replace("&quot;", "\"").replace("&amp;", "&"))
}

impl S3 {
    pub fn new(setup: Setup, secret: String) -> Self {
        Self { setup, secret }
    }

    /// The host and the path to a key, as this service wants the bucket named.
    fn host_and_path(&self, key: &str) -> Result<(String, String, String), String> {
        let base = url::Url::parse(self.setup.endpoint.trim_end_matches('/')).map_err(|_| "The address of this place isn't a web address")?;
        let scheme = base.scheme().to_string();
        let mut host = base.host_str().ok_or("The address of this place has no host")?.to_string();
        if let Some(port) = base.port() {
            host = format!("{host}:{port}");
        }
        let key = encode_path(key);
        Ok(if self.setup.path_style {
            (scheme, host, format!("/{}/{key}", encode(&self.setup.bucket)))
        } else {
            (scheme, format!("{}.{host}", self.setup.bucket), format!("/{key}"))
        })
    }

    fn signing<'a>(&'a self, method: &'a str, host: &'a str, path: &'a str, query: &[(&str, String)], headers: &[(&str, String)]) -> Signing<'a> {
        Signing {
            key_id: &self.setup.key_id,
            secret: &self.secret,
            region: if self.setup.region.is_empty() { "us-east-1" } else { &self.setup.region },
            method,
            host,
            path,
            query: query.iter().map(|(name, value)| (encode(name), encode(value))).collect(),
            headers: headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.clone())).collect(),
            payload: UNSIGNED,
        }
    }

    /// A signed request for `key`, sent again when the network trips. `headers` named `x-amz-…` are signed too.
    fn send(&self, method: Method, key: &str, query: &[(&str, String)], headers: &[(&str, String)], body: Option<&[u8]>) -> Result<Response, Failure> {
        let (scheme, host, path) = self.host_and_path(key).map_err(Failure::new)?;
        let signed_headers: Vec<(&str, String)> = headers.iter().filter(|(name, _)| name.starts_with("x-amz-")).cloned().collect();
        let address = {
            let query: Vec<String> = query.iter().map(|(name, value)| format!("{}={}", encode(name), encode(value))).collect();
            format!("{scheme}://{host}{path}{}{}", if query.is_empty() { "" } else { "?" }, query.join("&"))
        };
        let build = || -> RequestBuilder {
            let (date, time) = stamp(now());
            let mut all = signed_headers.clone();
            all.push(("x-amz-date", time.clone()));
            all.push(("x-amz-content-sha256", UNSIGNED.to_string()));
            let authorization = self.signing(method.as_str(), &host, &path, query, &all).authorization(&date, &time);
            let mut request = http::client().request(method.clone(), &address).header("authorization", authorization);
            for (name, value) in all.iter().chain(headers.iter().filter(|(name, _)| !name.starts_with("x-amz-"))) {
                request = request.header(*name, value);
            }
            match body {
                Some(bytes) => request.body(bytes.to_vec()),
                None => request,
            }
        };
        http::send(build)
    }

    fn text(&self, method: Method, key: &str, query: &[(&str, String)], headers: &[(&str, String)], body: Option<&[u8]>) -> Result<String, String> {
        let text = self.send(method, key, query, headers, body)?.text().map_err(|error| error.to_string())?;
        // A copy can answer 200 and still have failed, saying so in its body.
        if text.contains("<Error>") {
            return Err(first(&text, "Message").unwrap_or_else(|| "The service refused".into()));
        }
        Ok(text)
    }

    /// Every key under `prefix`, with no folders made of the slashes, as (key, size).
    fn keys(&self, prefix: &str) -> Result<Vec<(String, u64)>, String> {
        let mut keys = Vec::new();
        let mut token = String::new();
        loop {
            let mut query = vec![("list-type", "2".to_string()), ("prefix", prefix.to_string())];
            if !token.is_empty() {
                query.push(("continuation-token", token.clone()));
            }
            let xml = self.text(Method::GET, "", &query, &[], None)?;
            for fields in records(&xml, "Contents") {
                keys.push((fields.get("Key").cloned().unwrap_or_default(), fields.get("Size").and_then(|size| size.parse().ok()).unwrap_or(0)));
            }
            match first(&xml, "NextContinuationToken") {
                Some(next) if first(&xml, "IsTruncated").as_deref() == Some("true") && keys.len() < MOST_SEARCHED => token = next,
                _ => return Ok(keys),
            }
        }
    }

    /// A copy made by the service: in one request up to 5 GB, in parts past that.
    fn copy_key(&self, from: &str, to: &str, version: Option<&str>, size: u64) -> Result<(), String> {
        let mut source = format!("/{}/{}", self.setup.bucket, encode_path(from));
        if let Some(version) = version {
            source.push_str(&format!("?versionId={}", encode(version)));
        }
        if size <= COPY_MOST {
            return self.text(Method::PUT, to, &[], &[("x-amz-copy-source", source)], None).map(|_| ());
        }
        let xml = self.text(Method::POST, to, &[("uploads", String::new())], &[], None)?;
        let id = first(&xml, "UploadId").ok_or("The service didn't start the copy")?;
        let tags = copy_ranges(size)
            .into_iter()
            .enumerate()
            .map(|(at, (start, end))| {
                let query = [("partNumber", (at + 1).to_string()), ("uploadId", id.clone())];
                let headers = [("x-amz-copy-source", source.clone()), ("x-amz-copy-source-range", format!("bytes={start}-{end}"))];
                first(&self.text(Method::PUT, to, &query, &headers, None)?, "ETag").ok_or_else(|| "The service didn't copy a part".to_string())
            })
            .collect::<Result<Vec<_>, _>>();
        let done = tags.and_then(|tags| {
            let body = completed(&tags);
            self.text(Method::POST, to, &[("uploadId", id.clone())], &[("content-type", "application/xml".into())], Some(body.as_bytes())).map(|_| ())
        });
        if done.is_err() {
            // A copy cut short leaves no parts behind to pay for.
            let _ = self.send(Method::DELETE, to, &[("uploadId", id)], &[], None);
        }
        done
    }

    /// Each key of a file or of everything in a folder, with where it goes under `to` and its size.
    fn under(&self, path: &str, item: &Item, to: &str) -> Result<Vec<(String, String, u64)>, String> {
        if !item.folder {
            return Ok(vec![(path.to_string(), to.to_string(), item.size)]);
        }
        let prefix = format!("{path}/");
        Ok(self.keys(&prefix)?.into_iter().map(|(key, size)| (key.clone(), format!("{to}/{}", &key[prefix.len()..]), size)).collect())
    }

    /// Deletes each key, up to 1000 in one request. A service that won't take that, or says no to
    /// a key in it, has them deleted one at a time, which says what went wrong.
    fn delete_keys(&self, keys: &[String]) -> Result<(), String> {
        for batch in keys.chunks(DELETE_MOST) {
            let body = delete_body(batch);
            if batch.len() > 1 && self.text(Method::POST, "", &[("delete", String::new())], &summed(&body), Some(body.as_bytes())).is_ok() {
                continue;
            }
            for key in batch {
                match self.send(Method::DELETE, key, &[], &[], None) {
                    Err(failure) if failure.status == 404 => {}
                    other => {
                        other?;
                    }
                }
            }
        }
        Ok(())
    }

    fn upload_parts(&self, key: &str, file: &mut File, size: u64, tick: Tick) -> Result<(), String> {
        let resume = super::resume::key(&format!("s3|{}|{}", self.setup.bucket, key), file, size);
        let mut session = super::resume::load(&resume).filter(|session| !session.id.is_empty());
        if session.is_none() {
            let xml = self.text(Method::POST, key, &[("uploads", String::new())], &[], None)?;
            let id = first(&xml, "UploadId").ok_or("The service didn't start the upload")?;
            session = Some(super::resume::Session { id, done: 0, parts: Vec::new() });
        }
        let mut session = session.unwrap_or_default();
        while session.done < size {
            let number = session.parts.len() + 1;
            let bytes = http::chunk(file, session.done, PART)?;
            let response = self.send(Method::PUT, key, &[("partNumber", number.to_string()), ("uploadId", session.id.clone())], &[], Some(&bytes));
            let response = match response {
                Err(failure) if failure.status == 404 => {
                    // The service forgot the upload: it starts again from the top.
                    super::resume::clear(&resume);
                    return Err(format!("{} Try again to send it from the start.", failure.message));
                }
                other => other?,
            };
            let tag = response.headers().get("etag").and_then(|value| value.to_str().ok()).unwrap_or_default().to_string();
            session.parts.push(tag);
            session.done += bytes.len() as u64;
            super::resume::save(&resume, &session);
            if !tick(session.done) {
                return Err(super::STOPPED.into());
            }
        }
        let body = completed(&session.parts);
        self.text(Method::POST, key, &[("uploadId", session.id.clone())], &[("content-type", "application/xml".into())], Some(body.as_bytes()))?;
        super::resume::clear(&resume);
        Ok(())
    }
}

/// A storage class as Amazon's console names it. A file in the two cold ones must be restored
/// before it can be read.
fn class_name(class: &str) -> String {
    match class {
        "STANDARD_IA" => "Standard-IA",
        "ONEZONE_IA" => "One Zone-IA",
        "INTELLIGENT_TIERING" => "Intelligent-Tiering",
        "GLACIER_IR" => "Glacier Instant Retrieval",
        "GLACIER" => "Glacier Flexible Retrieval: restore it before opening",
        "DEEP_ARCHIVE" => "Glacier Deep Archive: restore it before opening",
        "REDUCED_REDUNDANCY" => "Reduced redundancy",
        "EXPRESS_ONEZONE" => "Express One Zone",
        other => other,
    }
    .to_string()
}

fn prefix_of(folder: &str) -> String {
    if folder.is_empty() { String::new() } else { format!("{folder}/") }
}

impl Service for S3 {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        let prefix = prefix_of(folder);
        let mut items = Vec::new();
        let mut token = String::new();
        // Only Amazon has Glacier, and others may refuse a header they don't know.
        let restores: Vec<(&str, String)> = if self.setup.preset == "aws" { vec![("x-amz-optional-object-attributes", "RestoreStatus".into())] } else { Vec::new() };
        loop {
            let mut query = vec![("list-type", "2".to_string()), ("prefix", prefix.clone()), ("delimiter", "/".to_string())];
            if !token.is_empty() {
                query.push(("continuation-token", token.clone()));
            }
            let xml = self.text(Method::GET, "", &query, &restores, None)?;
            for fields in records(&xml, "CommonPrefixes") {
                let name = fields.get("Prefix").map(|whole| whole[prefix.len().min(whole.len())..].trim_end_matches('/').to_string()).unwrap_or_default();
                if !name.is_empty() {
                    items.push(Item { name, folder: true, ..Item::default() });
                }
            }
            for fields in records(&xml, "Contents") {
                let key = fields.get("Key").cloned().unwrap_or_default();
                let name = key.get(prefix.len()..).unwrap_or_default();
                // The empty key a folder is made of, which stands for the folder itself.
                if name.is_empty() || name.contains('/') {
                    continue;
                }
                let (note, cold) = class_of(&fields);
                items.push(Item {
                    name: name.to_string(),
                    folder: false,
                    size: fields.get("Size").and_then(|size| size.parse().ok()).unwrap_or(0),
                    modified: fields.get("LastModified").map_or(0, |time| super::ticks_from_text(time)),
                    version: fields.get("ETag").cloned().unwrap_or_default(),
                    id: key,
                    note,
                    cold,
                });
            }
            match first(&xml, "NextContinuationToken") {
                Some(next) if first(&xml, "IsTruncated").as_deref() == Some("true") => token = next,
                _ => return Ok(items),
            }
        }
    }

    fn read(&self, path: &str, _item: &Item, from: u64, out: &mut dyn std::io::Write, tick: Tick) -> Result<(), String> {
        let range: Vec<(&str, String)> = if from > 0 { vec![("range", format!("bytes={from}-"))] } else { Vec::new() };
        let response = self.send(Method::GET, path, &[], &range, None)?;
        http::pour(response, out, from, tick).map(|_| ())
    }

    fn write(&self, folder: &str, name: &str, file: &Path, _replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        let key = join(folder, name);
        let mut opened = File::open(file).map_err(|error| error.to_string())?;
        let size = opened.metadata().map_err(|error| error.to_string())?.len();
        if size <= PART {
            let bytes = http::chunk(&mut opened, 0, size)?;
            self.send(Method::PUT, &key, &[], &[], Some(&bytes))?;
            tick(size);
            return Ok(());
        }
        self.upload_parts(&key, &mut opened, size, tick)
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        self.send(Method::PUT, &format!("{}/", join(folder, name)), &[], &[], Some(&[]))?;
        Ok(())
    }

    fn remove(&self, path: &str, item: &Item) -> Result<String, String> {
        let mut keys = self.under(path, item, "")?.into_iter().map(|(key, _, _)| key).collect::<Vec<_>>();
        if item.folder {
            keys.push(format!("{path}/"));
        }
        self.delete_keys(&keys)?;
        Ok(String::new())
    }

    fn restore(&self, _path: &str, _token: &str) -> Result<(), String> {
        Err("S3 has no recycle bin, so what was deleted there stays deleted".into())
    }

    fn relocate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        self.duplicate(path, item, folder, name)?;
        self.remove(path, item).map(|_| ())
    }

    fn duplicate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let to = join(folder, name);
        if item.folder {
            self.make_folder(folder, name)?;
        }
        for (from, into, size) in self.under(path, item, &to)? {
            self.copy_key(&from, &into, None, size)?;
        }
        Ok(())
    }

    fn has_bin(&self) -> bool {
        false
    }

    fn search(&self, folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let wanted = text.to_lowercase();
        let prefix = prefix_of(folder);
        Ok(self
            .keys(&prefix)?
            .into_iter()
            .filter_map(|(key, size)| {
                let (parent, name) = key.rsplit_once('/').unwrap_or(("", &key));
                (!name.is_empty() && name.to_lowercase().contains(&wanted)).then(|| (parent.to_string(), Item { name: name.to_string(), size, id: key.clone(), ..Item::default() }))
            })
            .collect())
    }

    fn space(&self) -> Result<Option<(u64, u64)>, String> {
        Ok(Some((self.keys("")?.iter().map(|(_, size)| size).sum(), 0)))
    }

    fn share(&self, path: &str, _item: &Item) -> Result<String, String> {
        let (scheme, host, address_path) = self.host_and_path(path)?;
        let (date, time) = stamp(now());
        let region = if self.setup.region.is_empty() { "us-east-1" } else { &self.setup.region };
        let credential = format!("{}/{date}/{region}/s3/aws4_request", self.setup.key_id);
        let query = vec![
            ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_string()),
            ("X-Amz-Credential", credential),
            ("X-Amz-Date", time.clone()),
            ("X-Amz-Expires", LINK_SECONDS.to_string()),
            ("X-Amz-SignedHeaders", "host".to_string()),
        ];
        let signing = self.signing("GET", &host, &address_path, &query, &[]);
        let (signature, _) = signing.signature(&date, &time);
        let mut encoded: Vec<String> = signing.query.iter().map(|(name, value)| format!("{name}={value}")).collect();
        encoded.sort();
        Ok(format!("{scheme}://{host}{address_path}?{}&X-Amz-Signature={signature}", encoded.join("&")))
    }

    fn versions(&self, path: &str, item: &Item) -> Result<Vec<Version>, String> {
        if item.folder {
            return Ok(Vec::new());
        }
        let xml = self.text(Method::GET, "", &[("versions", String::new()), ("prefix", path.to_string())], &[], None)?;
        Ok(records(&xml, "Version")
            .into_iter()
            .filter(|fields| fields.get("Key").map(String::as_str) == Some(path) && fields.get("IsLatest").map(String::as_str) != Some("true"))
            .map(|fields| Version {
                id: fields.get("VersionId").cloned().unwrap_or_default(),
                size: fields.get("Size").and_then(|size| size.parse().ok()).unwrap_or(0),
                modified: fields.get("LastModified").map_or(0, |time| super::ticks_from_text(time)),
            })
            .filter(|version| !version.id.is_empty() && version.id != "null")
            .collect())
    }

    fn bring_back(&self, path: &str, item: &Item, version: &str) -> Result<(), String> {
        let size = self.versions(path, item)?.into_iter().find(|old| old.id == version).map_or(0, |old| old.size);
        self.copy_key(path, path, Some(version), size)
    }

    fn warm(&self, path: &str, item: &Item) -> Result<(), String> {
        // Standard takes 3 to 5 hours from Flexible Retrieval and up to 12 from Deep Archive.
        let body = format!("<RestoreRequest><Days>{RESTORED_DAYS}</Days><GlacierJobParameters><Tier>Standard</Tier></GlacierJobParameters></RestoreRequest>");
        match self.send(Method::POST, path, &[("restore", String::new())], &summed(&body), Some(body.as_bytes())) {
            Err(failure) if failure.status == 409 => Err(format!("{} is already on its way back", item.name)),
            other => other.map(|_| ()).map_err(|failure| failure.message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_big_copy_goes_in_parts_and_deletes_go_in_batches() {
        let gib = COPY_PART;
        assert_eq!(copy_ranges(2 * gib + 5), [(0, gib - 1), (gib, 2 * gib - 1), (2 * gib, 2 * gib + 4)]);
        assert_eq!(copy_ranges(gib), [(0, gib - 1)]);
        assert_eq!(delete_body(&["a & b.txt".into(), "c".into()]), "<Delete><Quiet>true</Quiet><Object><Key>a &amp; b.txt</Key></Object><Object><Key>c</Key></Object></Delete>");
        assert!(summed("x").iter().any(|(name, sum)| *name == "x-amz-checksum-sha256" && sum == "LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE="));
    }

    #[test]
    fn a_glacier_file_says_whether_it_can_be_restored() {
        let fields = |pairs: &[(&str, &str)]| pairs.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect::<HashMap<_, _>>();
        let (note, cold) = class_of(&fields(&[("StorageClass", "GLACIER")]));
        assert!(cold && note.contains("restore"));
        let (note, cold) = class_of(&fields(&[("StorageClass", "DEEP_ARCHIVE"), ("IsRestoreInProgress", "true")]));
        assert!(!cold && note.contains("coming back"), "{note}");
        let (note, cold) = class_of(&fields(&[("StorageClass", "GLACIER"), ("IsRestoreInProgress", "false"), ("RestoreExpiryDate", "2026-11-26T00:00:00.000Z")]));
        assert_eq!((note.as_str(), cold), ("Glacier Flexible Retrieval: restored until 2026-11-26", false));
        assert_eq!(class_of(&fields(&[("StorageClass", "STANDARD_IA")])), ("Standard-IA".into(), false));
        assert_eq!(class_of(&fields(&[("StorageClass", "STANDARD")])), (String::new(), false));
    }

    #[test]
    fn a_cold_storage_class_says_to_restore_first() {
        assert!(class_name("DEEP_ARCHIVE").contains("restore"));
        assert!(class_name("GLACIER").contains("restore"));
        assert!(!class_name("GLACIER_IR").contains("restore"));
        assert_eq!(class_name("STANDARD_IA"), "Standard-IA");
        // One Amazon adds later shows as it comes.
        assert_eq!(class_name("NEW_CLASS"), "NEW_CLASS");
    }

    /// Amazon's own worked example of signing a GET of part of an object.
    #[test]
    fn a_request_is_signed_as_amazon_signs_it() {
        let signing = Signing {
            key_id: "AKIAIOSFODNN7EXAMPLE",
            secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            region: "us-east-1",
            method: "GET",
            host: "examplebucket.s3.amazonaws.com",
            path: "/test.txt",
            query: Vec::new(),
            headers: vec![
                ("range".into(), "bytes=0-9".into()),
                ("x-amz-content-sha256".into(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into()),
                ("x-amz-date".into(), "20130524T000000Z".into()),
            ],
            payload: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        };
        let (signature, signed) = signing.signature("20130524", "20130524T000000Z");
        assert_eq!(signed, "host;range;x-amz-content-sha256;x-amz-date");
        assert_eq!(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[test]
    fn dates_and_names_take_s3_s_forms() {
        assert_eq!(stamp(1_369_353_600), ("20130524".into(), "20130524T000000Z".into()));
        assert_eq!(stamp(951_782_400 + 3661), ("20000229".into(), "20000229T010101Z".into()));
        assert_eq!(encode_path("a b/c+d/é"), "a%20b/c%2Bd/%C3%A9");
    }

    #[test]
    fn a_listing_reads_its_folders_and_files() {
        let xml = r#"<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>
            <Contents><Key>photos/</Key><Size>0</Size></Contents>
            <Contents><Key>photos/a &amp; b.jpg</Key><LastModified>2026-11-18T09:30:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>42</Size><StorageClass>GLACIER</StorageClass></Contents>
            <CommonPrefixes><Prefix>photos/2025/</Prefix></CommonPrefixes></ListBucketResult>"#;
        let contents = records(xml, "Contents");
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[1]["Key"], "photos/a & b.jpg");
        assert_eq!(contents[1]["ETag"], "\"abc\"");
        assert_eq!(records(xml, "CommonPrefixes")[0]["Prefix"], "photos/2025/");
        assert_eq!(first(xml, "NextContinuationToken").as_deref(), Some("t1"));
    }
}
