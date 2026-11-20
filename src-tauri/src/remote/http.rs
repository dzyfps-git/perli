//! What every cloud service shares: one HTTP client that tries again when the network trips,
//! sign-ins in the browser, and secrets kept by Windows.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::blocking::{Client, RequestBuilder, Response};
use sha2::{Digest, Sha256};
use windows::core::{HSTRING, PWSTR};
use windows::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};
use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

/// How many times a request goes before its failure is the answer.
const TRIES: u32 = 4;
/// A sign-in the user never finishes in the browser gives up after this.
const SIGN_IN_WAIT: Duration = Duration::from_secs(5 * 60);
/// The port sign-ins come back on, as registered with Dropbox. Another one is used if it's taken.
const SIGN_IN_PORT: u16 = 52816;
/// Windows keeps at most this many bytes in one credential, so a longer secret goes in parts.
const PART: usize = 2048;

pub fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!("Perli/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .timeout(None)
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// A request that failed, with the service's own words for why.
#[derive(Debug)]
pub struct Failure {
    /// The HTTP status, or 0 when nothing answered.
    pub status: u16,
    pub message: String,
}

impl From<Failure> for String {
    fn from(failure: Failure) -> Self {
        failure.message
    }
}

impl Failure {
    pub fn new(message: impl Into<String>) -> Self {
        Self { status: 0, message: message.into() }
    }
}

/// The service's message out of an error body: JSON from most, XML from S3.
fn said(body: &str) -> Option<String> {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
        let error = &json["error"];
        let found = [&error["message"], &json["error_description"], &json["error_summary"], &json["message"], error]
            .into_iter()
            .find_map(|value| value.as_str().filter(|text| !text.is_empty()));
        return found.map(str::to_string);
    }
    let start = body.find("<Message>")? + "<Message>".len();
    Some(body[start..start + body[start..].find("</Message>")?].to_string())
}

fn failure(response: Response) -> Failure {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let reason = said(&body).unwrap_or_else(|| status.canonical_reason().unwrap_or("The service refused").to_string());
    let reason: String = reason.chars().take(300).collect();
    Failure { status: status.as_u16(), message: format!("{reason} ({})", status.as_u16()) }
}

fn plain(error: &reqwest::Error) -> Failure {
    let mut source: Option<&dyn std::error::Error> = Some(error);
    let mut text = error.to_string();
    while let Some(inner) = source.and_then(std::error::Error::source) {
        text = inner.to_string();
        source = Some(inner);
    }
    Failure::new(if error.is_timeout() { "The service took too long to answer".to_string() } else { format!("The network failed: {text}") })
}

/// Sends what `request` builds, again after a pause when the network trips or the service is
/// busy, as long as the request can be built again.
pub fn send(request: impl Fn() -> RequestBuilder) -> Result<Response, Failure> {
    send_with(request, |status| (200..300).contains(&status))
}

/// `send`, with `fine` saying which answers are no failure, as Google's 308 for a part that landed.
pub fn send_with(request: impl Fn() -> RequestBuilder, fine: impl Fn(u16) -> bool) -> Result<Response, Failure> {
    let mut wait = Duration::from_millis(600);
    for attempt in 1..=TRIES {
        let last = attempt == TRIES;
        match request().send() {
            Ok(response) if fine(response.status().as_u16()) => return Ok(response),
            Ok(response) => {
                let status = response.status().as_u16();
                if last || !(status == 429 || status >= 500) {
                    return Err(failure(response));
                }
                let asked = response.headers().get("retry-after").and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
                std::thread::sleep(asked.map_or(wait, |seconds| Duration::from_secs(seconds.min(60))));
            }
            Err(error) if last || !(error.is_connect() || error.is_timeout() || error.is_request() || error.is_body()) => return Err(plain(&error)),
            Err(_) => std::thread::sleep(wait),
        }
        wait *= 2;
    }
    Err(Failure::new("The service didn't answer"))
}

/// Copies a download into `out`, telling how far it got. False from `tick` stops it.
pub fn pour(mut body: impl Read, out: &mut dyn Write, mut done: u64, tick: super::Tick) -> Result<u64, String> {
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let read = body.read(&mut buffer).map_err(|error| format!("The download broke off: {error}"))?;
        if read == 0 {
            return Ok(done);
        }
        out.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
        done += read as u64;
        if !tick(done) {
            return Err(super::STOPPED.into());
        }
    }
}

/// Reads up to `size` bytes of `file` from `at`, for one part of an upload.
pub fn chunk(file: &mut std::fs::File, at: u64, size: u64) -> Result<Vec<u8>, String> {
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(at)).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(size).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes)
}

pub fn json(response: Response) -> Result<serde_json::Value, Failure> {
    let text = response.text().map_err(|error| plain(&error))?;
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| Failure::new("The service answered with something Perli can't read"))
}

/// Everything but what a URL leaves as it is, as S3's signing and Graph's paths both want it.
const ENCODE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

pub fn encode(text: &str) -> String {
    percent_encoding::utf8_percent_encode(text, ENCODE).to_string()
}

/// A form body, as sign-ins post.
pub fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

/// `count` random bytes from Windows, as text safe in a URL.
pub fn random_text(count: usize) -> String {
    let mut bytes = vec![0u8; count];
    // ponytail: a failure here leaves zeros; BCryptGenRandom with the system RNG doesn't fail in practice.
    let _ = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn target(id: &str, part: usize) -> HSTRING {
    HSTRING::from(format!("Perli cloud {id} {part}"))
}

/// Keeps a place's secret, a key or a sign-in, in Windows Credential Manager.
pub fn keep_secret(id: &str, secret: &str) -> Result<(), String> {
    forget_secret(id);
    for (part, bytes) in secret.as_bytes().chunks(PART).enumerate().chain(secret.is_empty().then_some((0, &[][..]))) {
        let name = target(id, part);
        let mut blob = bytes.to_vec();
        let credential = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_ptr().cast_mut()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&credential, 0) }.map_err(|error| format!("Windows didn't keep the key: {}", error.message()))?;
    }
    Ok(())
}

pub fn secret(id: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut parts = 0;
    loop {
        let mut found: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(&target(id, parts), CRED_TYPE_GENERIC, None, &mut found) }.is_err() {
            break;
        }
        parts += 1;
        unsafe {
            let credential = &*found;
            if !credential.CredentialBlob.is_null() {
                bytes.extend_from_slice(std::slice::from_raw_parts(credential.CredentialBlob, credential.CredentialBlobSize as usize));
            }
            CredFree(found.cast());
        }
    }
    if parts == 0 { None } else { String::from_utf8(bytes).ok() }
}

pub fn forget_secret(id: &str) {
    for part in 0.. {
        if unsafe { CredDeleteW(&target(id, part), CRED_TYPE_GENERIC, None) }.is_err() {
            break;
        }
    }
}

/// A service's registration for signing in: where its pages are, and who Perli is to it.
pub struct App {
    pub authorize: &'static str,
    pub token: &'static str,
    pub client_id: &'static str,
    /// Google gives desktop apps one; it isn't kept from the user, as it can't be.
    pub client_secret: Option<&'static str>,
    pub scopes: &'static str,
    /// More the service wants on its sign-in page, such as asking for a lasting sign-in.
    pub extra: &'static [(&'static str, &'static str)],
    pub name: &'static str,
}

#[derive(Clone)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
    pub expires: Instant,
}

/// Set to give up a sign-in waiting in the browser.
static GIVE_UP: AtomicBool = AtomicBool::new(false);

pub fn cancel_sign_in() {
    GIVE_UP.store(true, Ordering::Relaxed);
}

fn tokens_from(json: &serde_json::Value, old_refresh: &str) -> Result<Tokens, String> {
    let access = json["access_token"].as_str().ok_or("The sign-in gave no key")?.to_string();
    let refresh = json["refresh_token"].as_str().unwrap_or(old_refresh).to_string();
    let seconds = json["expires_in"].as_u64().unwrap_or(3600);
    Ok(Tokens { access, refresh, expires: Instant::now() + Duration::from_secs(seconds.saturating_sub(120)) })
}

fn post_token(app: &App, pairs: &mut Vec<(&str, &str)>) -> Result<serde_json::Value, String> {
    pairs.push(("client_id", app.client_id));
    if let Some(secret) = app.client_secret {
        pairs.push(("client_secret", secret));
    }
    let body = form(pairs);
    let response = send(|| client().post(app.token).header("content-type", "application/x-www-form-urlencoded").body(body.clone()))?;
    Ok(json(response)?)
}

/// Signs in through the browser: the service's own page, which sends the user back to a port
/// on this PC with a code, proven with a secret only this sign-in knows (PKCE).
pub fn sign_in(app: &App) -> Result<Tokens, String> {
    if app.client_id.is_empty() {
        return Err(format!("Perli isn't registered with {} yet, so it can't sign in there", app.name));
    }
    GIVE_UP.store(false, Ordering::Relaxed);
    let listeners: Vec<TcpListener> = match TcpListener::bind(("127.0.0.1", SIGN_IN_PORT)) {
        Ok(first) => std::iter::once(first).chain(TcpListener::bind(("::1", SIGN_IN_PORT)).ok()).collect(),
        Err(_) => vec![TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?],
    };
    let port = listeners[0].local_addr().map_err(|error| error.to_string())?.port();
    for listener in &listeners {
        listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    }
    let redirect = format!("http://localhost:{port}/");
    let verifier = random_text(48);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_text(16);
    let mut params = vec![
        ("client_id", app.client_id),
        ("response_type", "code"),
        ("redirect_uri", redirect.as_str()),
        ("scope", app.scopes),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    params.extend_from_slice(app.extra);
    let page = url::Url::parse_with_params(app.authorize, params.iter().filter(|(_, value)| !value.is_empty())).map_err(|error| error.to_string())?;
    crate::shell::open_link(page.as_str()).map_err(|error| error.message())?;
    let query = wait_for_return(&listeners)?;
    let asked: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    let value = |key: &str| asked.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone());
    if value("state").as_deref() != Some(state.as_str()) {
        return Err("The sign-in came back from somewhere else, so Perli ignored it".into());
    }
    let code = value("code").ok_or_else(|| value("error_description").or_else(|| value("error")).unwrap_or_else(|| "The sign-in was turned down".into()))?;
    let json = post_token(app, &mut vec![("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", &redirect), ("code_verifier", &verifier)])?;
    let tokens = tokens_from(&json, "")?;
    if tokens.refresh.is_empty() {
        return Err("The sign-in didn't give Perli a lasting key".into());
    }
    Ok(tokens)
}

/// Waits for the browser to come back with the sign-in's answer, and thanks it. Gives the query.
fn wait_for_return(listeners: &[TcpListener]) -> Result<String, String> {
    let deadline = Instant::now() + SIGN_IN_WAIT;
    while Instant::now() < deadline {
        if GIVE_UP.load(Ordering::Relaxed) {
            return Err("The sign-in was called off".into());
        }
        for listener in listeners {
            if let Ok((stream, _)) = listener.accept() {
                if let Some(query) = answer(stream) {
                    return Ok(query);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    Err("The sign-in took too long".into())
}

/// Reads one request from the browser. Gives its query when it is the sign-in coming back.
fn answer(mut stream: TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n") && head.len() < 8192 && stream.read(&mut byte).ok()? == 1 {
        head.push(byte[0]);
    }
    let line = String::from_utf8_lossy(&head);
    let target = line.split_whitespace().nth(1)?;
    let query = target.split_once('?').map(|(_, query)| query.to_string());
    let page = "<!doctype html><meta charset=utf-8><title>Perli</title><body style=\"font:16px Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#333\"><p>Perli has the sign-in. You can close this tab.</p>";
    let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}", page.len());
    query.filter(|query| query.contains("code=") || query.contains("error="))
}

/// A signed-in service's keys: a short-lived one for requests, renewed with the lasting one,
/// which Windows keeps and which some services hand out anew with each renewal.
pub struct Signed {
    app: &'static App,
    place: String,
    tokens: Mutex<Tokens>,
}

impl Signed {
    pub fn new(app: &'static App, place: &str, refresh: &str) -> Self {
        let tokens = Tokens { access: String::new(), refresh: refresh.to_string(), expires: Instant::now() };
        Self { app, place: place.to_string(), tokens: Mutex::new(tokens) }
    }

    fn renew(&self, tokens: &mut Tokens) -> Result<(), Failure> {
        let refresh = tokens.refresh.clone();
        let json = post_token(self.app, &mut vec![("grant_type", "refresh_token"), ("refresh_token", &refresh)])
            .map_err(|message| Failure::new(format!("Sign in to this place again: {message}")))?;
        let fresh = tokens_from(&json, &refresh).map_err(Failure::new)?;
        if fresh.refresh != refresh {
            let _ = keep_secret(&self.place, &fresh.refresh);
        }
        *tokens = fresh;
        Ok(())
    }

    fn bearer(&self, renew: bool) -> Result<String, Failure> {
        let mut tokens = self.tokens.lock().unwrap_or_else(PoisonError::into_inner);
        if renew || tokens.access.is_empty() || Instant::now() >= tokens.expires {
            self.renew(&mut tokens)?;
        }
        Ok(format!("Bearer {}", tokens.access))
    }

    /// Sends a request with the key, renewing it once if the service says it's stale.
    pub fn send(&self, request: impl Fn(&str) -> RequestBuilder) -> Result<Response, Failure> {
        let bearer = self.bearer(false)?;
        match send(|| request(&bearer)) {
            Err(failure) if failure.status == 401 => {
                let bearer = self.bearer(true)?;
                send(|| request(&bearer))
            }
            other => other,
        }
    }

    pub fn json(&self, request: impl Fn(&str) -> RequestBuilder) -> Result<serde_json::Value, String> {
        Ok(json(self.send(request)?)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_s_own_words_come_out_of_its_error() {
        assert_eq!(said(r#"{"error":{"code":"x","message":"Item not found"}}"#).as_deref(), Some("Item not found"));
        assert_eq!(said(r#"{"error":"invalid_grant","error_description":"Token expired"}"#).as_deref(), Some("Token expired"));
        assert_eq!(said(r#"{"error_summary":"path/not_found/.."}"#).as_deref(), Some("path/not_found/.."));
        assert_eq!(said("<Error><Code>NoSuchKey</Code><Message>The key does not exist.</Message></Error>").as_deref(), Some("The key does not exist."));
        assert_eq!(said("plain"), None);
    }

    #[test]
    fn random_text_is_random_and_url_safe() {
        let (a, b) = (random_text(32), random_text(32));
        assert_ne!(a, b);
        assert!(a.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_'));
    }
}
