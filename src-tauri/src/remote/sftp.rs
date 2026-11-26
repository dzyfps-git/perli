//! SFTP over SSH, through russh. One connection is kept open and made again when it drops. The
//! server's host key is taken the first time and must be the same every time after, as SSH's own
//! known hosts work. A key file, the OpenSSH agent or a password signs in.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use tauri::async_runtime::block_on;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::{join, lock, Item, Server, Service, Tick, STOPPED};

/// Where Windows' own OpenSSH agent listens.
const AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
const CHUNK: usize = 256 * 1024;
/// Rows at most a search looks through, as it lists each folder one by one.
const SEARCH_LIMIT: usize = 20_000;
pub const KEY_CHANGED: &str =
    "The server's host key isn't the one it had when this place was added. If nobody changed the server, something may be in between: don't sign in";

/// Checks the host key against the one taken, noting the one the server showed.
struct Keys {
    want: String,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Keys {
    type Error = russh::Error;

    async fn check_server_key(&mut self, shown: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match shown {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(certificate) => PublicKey::new(certificate.public_key().clone(), ""),
        };
        let print = key.fingerprint(HashAlg::Sha256).to_string();
        *lock(&self.seen) = Some(print.clone());
        Ok(self.want.is_empty() || self.want == print)
    }
}

struct Open {
    _ssh: Handle<Keys>,
    sftp: SftpSession,
}

pub struct Sftp {
    server: Server,
    secret: String,
    open: Mutex<Option<Open>>,
    /// The host key the server showed last, as `SHA256:...`.
    seen: Arc<Mutex<Option<String>>>,
}

fn said(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl Sftp {
    pub fn new(server: &Server, secret: &str) -> Self {
        Self { server: server.clone(), secret: secret.to_string(), open: Mutex::new(None), seen: Arc::new(Mutex::new(None)) }
    }

    /// The host key the server showed when last asked.
    pub fn host_key(&self) -> Option<String> {
        lock(&self.seen).clone()
    }

    async fn sign_in(&self, ssh: &mut Handle<Keys>) -> Result<(), String> {
        let user = if self.server.user.is_empty() { "root" } else { self.server.user.as_str() };
        let refused = "The server refused the sign-in";
        if !self.server.key_file.is_empty() {
            let passphrase = (!self.secret.is_empty()).then_some(self.secret.as_str());
            let key = load_secret_key(&self.server.key_file, passphrase).map_err(|error| format!("The key file can't be read: {error}"))?;
            let hash = ssh.best_supported_rsa_hash().await.map_err(said)?.flatten();
            let answer = ssh.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(said)?;
            return if answer.success() { Ok(()) } else { Err(format!("{refused} with that key")) };
        }
        if !self.secret.is_empty() {
            let answer = ssh.authenticate_password(user, &self.secret).await.map_err(said)?;
            return if answer.success() { Ok(()) } else { Err(format!("{refused}: check the user name and password")) };
        }
        // No password and no key file: the keys Windows' OpenSSH agent holds.
        let mut agent = AgentClient::connect_named_pipe(AGENT_PIPE).await.map_err(|_| "Give a password or a key file: Windows' OpenSSH agent isn't running".to_string())?;
        let hash = ssh.best_supported_rsa_hash().await.map_err(said)?.flatten();
        for identity in agent.request_identities().await.map_err(said)? {
            let key = identity.public_key().into_owned();
            if ssh.authenticate_publickey_with(user, key, hash, &mut agent).await.is_ok_and(|answer| answer.success()) {
                return Ok(());
            }
        }
        Err(format!("{refused} with every key the OpenSSH agent holds"))
    }

    fn connect(&self) -> Result<Open, String> {
        let host = self.server.host.trim().trim_start_matches("sftp://").trim_end_matches('/').to_string();
        let port = if self.server.port == 0 { 22 } else { self.server.port };
        block_on(async {
            let config = client::Config { inactivity_timeout: Some(Duration::from_secs(600)), keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() };
            let keys = Keys { want: self.server.host_key.clone(), seen: self.seen.clone() };
            let connecting = client::connect(Arc::new(config), (host.as_str(), port), keys);
            let mut ssh = match tokio::time::timeout(Duration::from_secs(20), connecting).await {
                Err(_) => return Err(format!("{host} didn't answer")),
                Ok(Err(_)) if !self.server.host_key.is_empty() && lock(&self.seen).as_deref().is_some_and(|seen| seen != self.server.host_key) => {
                    return Err(KEY_CHANGED.into());
                }
                Ok(Err(error)) => return Err(format!("{host} can't be reached: {error}")),
                Ok(Ok(ssh)) => ssh,
            };
            self.sign_in(&mut ssh).await?;
            let channel = ssh.channel_open_session().await.map_err(said)?;
            channel.request_subsystem(true, "sftp").await.map_err(said)?;
            let sftp = SftpSession::new(channel.into_stream()).await.map_err(|error| format!("The server has no SFTP: {error}"))?;
            Ok(Open { _ssh: ssh, sftp })
        })
    }

    /// Runs `work` on the connection, made again once when the one kept has dropped.
    fn with<T>(&self, work: impl Fn(&SftpSession) -> Result<T, String>) -> Result<T, String> {
        let mut open = lock(&self.open);
        if let Some(kept) = open.as_ref() {
            match work(&kept.sftp) {
                Ok(done) => return Ok(done),
                // A refusal from SFTP itself is the answer; anything else may be a dropped connection.
                Err(message) if !message.starts_with("I/O") && !message.contains("closed") && message != "Timeout" => return Err(message),
                Err(_) => *open = None,
            }
        }
        let fresh = self.connect()?;
        let done = work(&fresh.sftp);
        *open = Some(fresh);
        done
    }

    fn full(&self, inner: &str) -> String {
        let base = self.server.folder.trim_end_matches('/');
        match (base.is_empty(), inner.is_empty()) {
            (true, true) => ".".into(),
            (true, false) => inner.into(),
            (false, true) => base.into(),
            (false, false) => format!("{base}/{inner}"),
        }
    }

    async fn rows(sftp: &SftpSession, path: &str) -> Result<Vec<Item>, String> {
        let mut items = Vec::new();
        for entry in sftp.read_dir(path).await.map_err(said)? {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let mut facts = entry.metadata();
            if facts.file_type().is_symlink() {
                // A link goes by what it points at, as `ls` shows it.
                if let Ok(target) = sftp.metadata(format!("{path}/{name}")).await {
                    facts = target;
                }
            }
            let folder = facts.is_dir();
            let size = if folder { 0 } else { facts.size.unwrap_or(0) };
            let modified = facts.mtime.map_or(0, |seconds| super::ticks_from_unix(i64::from(seconds)));
            items.push(Item { name: super::local_name(&name), folder, size, modified, version: format!("{size}-{modified}"), ..Item::default() });
        }
        Ok(items)
    }

    async fn remove_tree(sftp: &SftpSession, path: &str) -> Result<(), String> {
        for item in Self::rows(sftp, path).await? {
            let child = format!("{path}/{}", item.name);
            if item.folder {
                Box::pin(Self::remove_tree(sftp, &child)).await?;
            } else {
                sftp.remove_file(child).await.map_err(said)?;
            }
        }
        sftp.remove_dir(path).await.map_err(said)
    }
}

impl Service for Sftp {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String> {
        let path = self.full(folder);
        self.with(|sftp| block_on(Self::rows(sftp, &path)))
    }

    fn read(&self, path: &str, _item: &Item, from: u64, out: &mut dyn Write, tick: Tick) -> Result<(), String> {
        let path = self.full(path);
        let file = self.with(|sftp| block_on(sftp.open(path.as_str())).map_err(said))?;
        block_on(async move {
            let mut file = file;
            file.seek(std::io::SeekFrom::Start(from)).await.map_err(said)?;
            let mut buffer = vec![0u8; CHUNK];
            let mut done = 0u64;
            loop {
                let read = file.read(&mut buffer).await.map_err(|error| format!("The download broke off: {error}"))?;
                if read == 0 {
                    return Ok(());
                }
                out.write_all(&buffer[..read]).map_err(said)?;
                done += read as u64;
                if !tick(done) {
                    return Err(STOPPED.into());
                }
            }
        })
    }

    fn write(&self, folder: &str, name: &str, file: &Path, replace: Option<&Item>, tick: Tick) -> Result<(), String> {
        let path = self.full(&join(folder, name));
        // It goes in under a name of its own and takes the real one at the end, so a send cut off
        // leaves the file there as it was.
        let part = format!("{path}.perli-part");
        let mut source = File::open(file).map_err(said)?;
        let target = self.with(|sftp| block_on(sftp.create(part.as_str())).map_err(said))?;
        let sent: Result<(), String> = block_on(async {
            let mut target = target;
            let mut buffer = vec![0u8; CHUNK];
            let mut done = 0u64;
            loop {
                let read = source.read(&mut buffer).map_err(said)?;
                if read == 0 {
                    break;
                }
                target.write_all(&buffer[..read]).await.map_err(|error| format!("The send broke off: {error}"))?;
                done += read as u64;
                if !tick(done) {
                    return Err(STOPPED.into());
                }
            }
            target.shutdown().await.map_err(said)
        });
        let open = lock(&self.open);
        let sftp = &open.as_ref().ok_or("The connection dropped")?.sftp;
        if let Err(message) = sent {
            let _ = block_on(sftp.remove_file(part.as_str()));
            return Err(message);
        }
        block_on(async {
            // posix-rename lands over a file there; plain SFTP rename refuses to.
            if sftp.posix_rename(part.as_str(), path.as_str()).await.unwrap_or(false) {
                return Ok(());
            }
            if replace.is_some() {
                sftp.remove_file(path.as_str()).await.map_err(said)?;
            }
            sftp.rename(part.as_str(), path.as_str()).await.map_err(said)
        })
    }

    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String> {
        let path = self.full(&join(folder, name));
        self.with(|sftp| block_on(sftp.create_dir(path.as_str())).map_err(said))
    }

    fn remove(&self, path: &str, item: &Item) -> Result<String, String> {
        let path = self.full(path);
        self.with(|sftp| block_on(async { if item.folder { Self::remove_tree(sftp, &path).await } else { sftp.remove_file(path.as_str()).await.map_err(said) } }))?;
        Ok(String::new())
    }

    fn restore(&self, _path: &str, _token: &str) -> Result<(), String> {
        Err("An SFTP server keeps no bin".into())
    }

    fn relocate(&self, path: &str, _item: &Item, folder: &str, name: &str) -> Result<(), String> {
        let (from, to) = (self.full(path), self.full(&join(folder, name)));
        self.with(|sftp| block_on(sftp.rename(from.as_str(), to.as_str())).map_err(said))
    }

    fn duplicate(&self, _path: &str, _item: &Item, _folder: &str, _name: &str) -> Result<(), String> {
        Err("SFTP can't copy on the server. Copy it to this PC and back".into())
    }

    fn has_bin(&self) -> bool {
        false
    }

    fn search(&self, folder: &str, text: &str) -> Result<Vec<(String, Item)>, String> {
        let needle = text.to_lowercase();
        let (mut found, mut todo, mut seen) = (Vec::new(), vec![folder.to_string()], 0);
        // ponytail: walks folder by folder and stops at SEARCH_LIMIT rows; running `find` over SSH would be faster.
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
        let path = self.full("");
        let facts = self.with(|sftp| block_on(sftp.fs_info(path.as_str())).map_err(said))?;
        Ok(facts.map(|facts| {
            let unit = if facts.fragment_size > 0 { facts.fragment_size } else { facts.block_size };
            ((facts.blocks - facts.blocks_free) * unit, facts.blocks * unit)
        }))
    }

    fn share(&self, _path: &str, _item: &Item) -> Result<String, String> {
        Err("An SFTP server has no links to give".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_sit_under_the_folder_the_place_opens_at() {
        let sftp = |folder: &str| Sftp::new(&Server { folder: folder.into(), ..Server::default() }, "");
        assert_eq!(sftp("").full(""), ".");
        assert_eq!(sftp("/home/me/").full("a/b"), "/home/me/a/b");
    }

    #[test]
    #[ignore = "reaches test.rebex.net, a public read-only test server"]
    fn reads_a_public_test_server_over_sftp_and_ftp() {
        let server = Server { host: "test.rebex.net".into(), user: "demo".into(), ..Server::default() };
        let sftp = Sftp::new(&server, "password");
        let items = sftp.list("").unwrap();
        println!("sftp key {:?}: {:?}", sftp.host_key(), items.iter().map(|item| (&item.name, item.folder, item.size)).collect::<Vec<_>>());
        let readme = items.iter().find(|item| item.name == "readme.txt").unwrap();
        let mut bytes = Vec::new();
        sftp.read("readme.txt", readme, 0, &mut bytes, &mut |_| true).unwrap();
        assert_eq!(bytes.len() as u64, readme.size);
        let mut tail = Vec::new();
        sftp.read("readme.txt", readme, 10, &mut tail, &mut |_| true).unwrap();
        assert_eq!(tail, bytes[10..]);
        let wrong = Sftp::new(&Server { host_key: "SHA256:not-it".into(), ..server.clone() }, "password");
        assert_eq!(wrong.list("").unwrap_err(), KEY_CHANGED);
        for secure in [false, true] {
            let ftp = super::super::ftp::Ftp::new(&Server { secure, ..server.clone() }, "password");
            let items = ftp.list("").unwrap();
            println!("ftp secure {secure}: {:?}", items.iter().map(|item| (&item.name, item.folder, item.size)).collect::<Vec<_>>());
            let mut again = Vec::new();
            ftp.read("readme.txt", readme, 0, &mut again, &mut |_| true).unwrap();
            assert_eq!(again, bytes);
            let mut tail = Vec::new();
            ftp.read("readme.txt", readme, 10, &mut tail, &mut |_| true).unwrap();
            assert_eq!(tail, bytes[10..]);
        }
    }

    #[test]
    fn a_server_that_isnt_there_says_so() {
        let sftp = Sftp::new(&Server { host: "127.0.0.1".into(), port: 1, ..Server::default() }, "x");
        let failed = sftp.list("").unwrap_err();
        assert!(failed.contains("can't be reached") || failed.contains("didn't answer"), "{failed}");
    }
}
