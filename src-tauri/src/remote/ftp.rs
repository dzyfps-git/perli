//! FTP and FTPS (explicit TLS, as `AUTH TLS`), over one connection kept open and made again when
//! it drops. Paths are under the folder the place opens at, or the one the server signs in to.

use std::fs::File;
use std::io::{Read, Write};
use std::net::ToSocketAddrs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use suppaftp::list::{File as Listed, ListParser};
use suppaftp::types::FileType;
use suppaftp::{FtpError, RustlsConnector, RustlsFtpStream as FtpStream};

use super::{http, join, lock, Item, Server, Service, Tick, STOPPED};

const WAIT: Duration = Duration::from_secs(20);
/// Rows at most a search looks through, as it lists each folder one by one.
const SEARCH_LIMIT: usize = 20_000;

pub struct Ftp {
    server: Server,
    password: String,
    open: Mutex<Option<FtpStream>>,
}

fn said(error: FtpError) -> String {
    match error {
        FtpError::ConnectionError(error) => format!("The server didn't answer: {error}"),
        FtpError::UnexpectedResponse(response) => {
            let text = String::from_utf8_lossy(&response.body).trim().to_string();
            if text.is_empty() { format!("The server refused ({})", response.status.code()) } else { text }
        }
        other => other.to_string(),
    }
}

/// A row of a listing, in the MLSD form where the server speaks it, else as `ls -l` or DOS shows it.
fn item_of(line: &str, facts: bool) -> Option<Item> {
    let found = if facts { ListParser::parse_mlsd(line).ok()? } else { Listed::try_from(line).ok()? };
    let name = found.name().to_string();
    if name == "." || name == ".." || name.is_empty() {
        return None;
    }
    let seconds = found.modified().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_secs() as i64);
    let modified = if seconds > 0 { super::ticks_from_unix(seconds) } else { 0 };
    let size = if found.is_directory() { 0 } else { found.size() as u64 };
    Some(Item { name: super::local_name(&name), folder: found.is_directory(), size, modified, version: format!("{size}-{modified}"), ..Item::default() })
}

/// One TLS setup for every connection, so each data connection takes up the control
/// connection's session again, as FileZilla Server and vsftpd ask.
fn tls() -> Result<Arc<rustls::ClientConfig>, String> {
    static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            for certificate in rustls_native_certs::load_native_certs().certs {
                let _ = roots.add(certificate);
            }
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let config = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().map_err(|error| error.to_string())?;
            Ok(Arc::new(config.with_root_certificates(roots).with_no_client_auth()))
        })
        .clone()
}

impl Ftp {
    pub fn new(server: &Server, password: &str) -> Self {
        Self { server: server.clone(), password: password.to_string(), open: Mutex::new(None) }
    }

    fn connect(&self) -> Result<FtpStream, String> {
        let host = self.server.host.trim().trim_start_matches("ftp://").trim_start_matches("ftps://").trim_end_matches('/');
        let port = if self.server.port == 0 { 21 } else { self.server.port };
        let address = (host, port).to_socket_addrs().map_err(|_| format!("{host} can't be found"))?.next().ok_or_else(|| format!("{host} can't be found"))?;
        let mut stream = FtpStream::connect_timeout(address, WAIT).map_err(said)?;
        if self.server.secure {
            stream = stream.into_secure(RustlsConnector::from(tls()?), host).map_err(said)?;
        }
        let user = if self.server.user.is_empty() { "anonymous" } else { self.server.user.as_str() };
        stream.login(user, &self.password).map_err(said)?;
        stream.set_passive_nat_workaround(true);
        stream.transfer_type(FileType::Binary).map_err(said)?;
        Ok(stream)
    }

    /// Runs `work` on the connection, made again once when the one kept has dropped.
    fn with<T>(&self, work: impl Fn(&mut FtpStream) -> Result<T, FtpError>) -> Result<T, String> {
        let mut open = lock(&self.open);
        if let Some(stream) = open.as_mut() {
            match work(stream) {
                Ok(done) => return Ok(done),
                // The server's own no is the answer; anything else may be a dropped connection.
                Err(FtpError::UnexpectedResponse(response)) => return Err(said(FtpError::UnexpectedResponse(response))),
                Err(_) => *open = None,
            }
        }
        let mut stream = self.connect()?;
        let done = work(&mut stream).map_err(said);
        *open = Some(stream);
        done
    }

    /// The server's path for a path inside the place.
    fn full(&self, inner: &str) -> String {
        let base = self.server.folder.trim_end_matches('/');
        match (base.is_empty(), inner.is_empty()) {
            (true, true) => ".".into(),
            (true, false) => inner.into(),
            (false, true) => base.into(),
            (false, false) => format!("{base}/{inner}"),
        }
    }

    fn rows(stream: &mut FtpStream, path: &str) -> Result<Vec<Item>, FtpError> {
        match stream.mlsd(Some(path)) {
            Ok(lines) => Ok(lines.iter().filter_map(|line| item_of(line, true)).collect()),
            Err(FtpError::UnexpectedResponse(response)) if response.status.code() / 100 == 5 => {
                Ok(stream.list(Some(path))?.iter().filter_map(|line| item_of(line, false)).collect())
            }
            Err(error) => Err(error),
        }
    }

    /// Deletes a folder with all it holds, as RMD takes only an empty one.
    fn remove_tree(stream: &mut FtpStream, path: &str) -> Result<(), FtpError> {
        for item in Self::rows(stream, path)? {
            let child = format!("{path}/{}", item.name);
            if item.folder { Self::remove_tree(stream, &child)? } else { stream.rm(&child)? }
        }
        stream.rmdir(path)
    }
}

impl Service for Ftp {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        let path = self.full(folder);
        self.with(|stream| Self::rows(stream, &path))
    }

    fn read(&self, path: &str, _item: &Item, from: u64, out: &mut dyn Write, tick: Tick) -> Result<(), String> {
        let path = self.full(path);
        let mut open = lock(&self.open);
        let mut stream = match open.take() {
            Some(mut kept) => {
                if kept.noop().is_ok() { kept } else { self.connect()? }
            }
            None => self.connect()?,
        };
        if from > 0 {
            stream.resume_transfer(from as usize).map_err(said)?;
        }
        let mut download = stream.retr_as_stream(&path).map_err(said)?;
        let poured = http::pour(&mut download, out, 0, tick);
        if poured.is_err() {
            // A transfer cut off leaves the connection in the middle of it: the next call makes a new one.
            drop(download);
            return poured.map(drop);
        }
        download.finish().map_err(said)?;
        *open = Some(stream);
        Ok(())
    }

    fn write(&self, folder: &str, name: &str, file: &Path, _replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        let path = self.full(&join(folder, name));
        let mut source = File::open(file).map_err(|error| error.to_string())?;
        let mut open = lock(&self.open);
        let mut stream = match open.take() {
            Some(mut kept) => {
                if kept.noop().is_ok() { kept } else { self.connect()? }
            }
            None => self.connect()?,
        };
        let mut upload = stream.put_with_stream(&path).map_err(said)?;
        let mut buffer = vec![0u8; 256 * 1024];
        let mut done = 0u64;
        loop {
            let read = source.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            upload.write_all(&buffer[..read]).map_err(|error| format!("The send broke off: {error}"))?;
            done += read as u64;
            if !tick(done) {
                return Err(STOPPED.into());
            }
        }
        upload.finish().map_err(said)?;
        *open = Some(stream);
        Ok(())
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        let path = self.full(&join(folder, name));
        self.with(|stream| stream.mkdir(&path))
    }

    fn remove(&self, path: &str, item: &Item) -> Result<String, String> {
        let path = self.full(path);
        self.with(|stream| if item.folder { Self::remove_tree(stream, &path) } else { stream.rm(&path) })?;
        Ok(String::new())
    }

    fn restore(&self, _path: &str, _token: &str) -> Result<(), String> {
        Err("An FTP server keeps no bin".into())
    }

    fn relocate(&self, path: &str, _item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let (from, to) = (self.full(path), self.full(&join(folder, name)));
        self.with(|stream| stream.rename(&from, &to))
    }

    fn duplicate(&self, _path: &str, _item: &Item, _folder: &str, _name: &str) -> Result<(), String> {
        Err("FTP can't copy on the server. Copy it to this PC and back".into())
    }

    fn has_bin(&self) -> bool {
        false
    }

    fn search(&self, folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let needle = text.to_lowercase();
        let (mut found, mut todo, mut seen) = (Vec::new(), vec![folder.to_string()], 0);
        // ponytail: walks folder by folder and stops at SEARCH_LIMIT rows; FTP has no search of its own.
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

    fn share(&self, _path: &str, _item: &Item) -> Result<String, String> {
        Err("An FTP server has no links to give".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listings_read_in_each_form_servers_send() {
        let file = item_of("type=file;size=1024;modify=20261118093000; report.pdf", true).unwrap();
        assert_eq!((file.name.as_str(), file.folder, file.size), ("report.pdf", false, 1024));
        assert_eq!(file.modified, super::super::ticks_from_text("2026-11-18T09:30:00Z"));
        let folder = item_of("type=dir;modify=20261118093000; Photos", true).unwrap();
        assert!(folder.folder);
        assert!(item_of("type=cdir;modify=20261118093000; .", true).is_none());
        let unix = item_of("-rw-r--r-- 1 me staff 12 Nov 18 2026 a b.txt", false).unwrap();
        assert_eq!((unix.name.as_str(), unix.size), ("a b.txt", 12));
        let dos = item_of("11-18-26  09:30AM       <DIR>          Music", false).unwrap();
        assert!(dos.folder);
    }

    #[test]
    fn paths_sit_under_the_folder_the_place_opens_at() {
        let ftp = |folder: &str| Ftp::new(&Server { folder: folder.into(), ..Server::default() }, "");
        assert_eq!(ftp("").full(""), ".");
        assert_eq!(ftp("").full("a/b"), "a/b");
        assert_eq!(ftp("/srv/").full(""), "/srv");
        assert_eq!(ftp("/srv").full("a"), "/srv/a");
    }
}
