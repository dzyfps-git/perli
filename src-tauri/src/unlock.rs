//! Unlocks a ZIP entry's squeezed bytes, for the one way of squeezing the zip crate can't read
//! without a C library: Zstandard. WinZip AES and the old ZIP scheme both come out here as the
//! squeezed bytes, which Perli then reads through ruzstd.
use std::io::{self, Read};

use aes::cipher::{BlockCipherEncrypt, KeyInit};
use hmac::{Mac, SimpleHmacReset};
use sha1::Sha1;
use zip::result::ZipError;

/// What WinZip AES adds to an entry's local header extra field.
const AES_FIELD: u16 = 0x9901;
const AES_ROUNDS: u32 = 1000;
const AES_CHECK: usize = 2;
const AES_AUTH: usize = 10;

/// WinZip AES: the vendor version, of which only 1 keeps the CRC, and the key's length.
fn aes_of(extra: &[u8]) -> Option<(u16, usize)> {
    let mut at = 0;
    while at + 4 <= extra.len() {
        let id = u16::from_le_bytes([extra[at], extra[at + 1]]);
        let size = u16::from_le_bytes([extra[at + 2], extra[at + 3]]) as usize;
        let body = extra.get(at + 4..at + 4 + size)?;
        if id == AES_FIELD && size >= 7 {
            let key = match body[4] {
                1 => 16,
                2 => 24,
                3 => 32,
                _ => return None,
            };
            return Some((u16::from_le_bytes([body[0], body[1]]), key));
        }
        at += 4 + size;
    }
    None
}

enum Cipher {
    Aes128(aes::Aes128),
    Aes192(aes::Aes192),
    Aes256(aes::Aes256),
}

impl Cipher {
    fn new(key: &[u8]) -> Option<Self> {
        Some(match key.len() {
            16 => Self::Aes128(aes::Aes128::new_from_slice(key).ok()?),
            24 => Self::Aes192(aes::Aes192::new_from_slice(key).ok()?),
            _ => Self::Aes256(aes::Aes256::new_from_slice(key).ok()?),
        })
    }

    /// The key stream for one counter, which WinZip counts from 1, little-endian.
    fn stream(&self, counter: u128) -> [u8; 16] {
        let mut block = aes::Block::from(counter.to_le_bytes());
        match self {
            Self::Aes128(cipher) => cipher.encrypt_block(&mut block),
            Self::Aes192(cipher) => cipher.encrypt_block(&mut block),
            Self::Aes256(cipher) => cipher.encrypt_block(&mut block),
        }
        block.into()
    }
}

/// WinZip AES, which checks what it read against its code at the end.
struct AesRead<R> {
    from: R,
    left: u64,
    cipher: Cipher,
    counter: u128,
    stream: [u8; 16],
    used: usize,
    mac: SimpleHmacReset<Sha1>,
    checked: bool,
}

impl<R: Read> Read for AesRead<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            if !self.checked && !buffer.is_empty() {
                self.checked = true;
                let mut code = [0; AES_AUTH];
                self.from.read_exact(&mut code)?;
                if self.mac.clone().finalize().into_bytes()[..AES_AUTH] != code {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid checksum"));
                }
            }
            return Ok(0);
        }
        let wanted = buffer.len().min(self.left as usize);
        let count = self.from.read(&mut buffer[..wanted])?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.mac.update(&buffer[..count]);
        for byte in &mut buffer[..count] {
            if self.used == self.stream.len() {
                self.stream = self.cipher.stream(self.counter);
                self.counter += 1;
                self.used = 0;
            }
            *byte ^= self.stream[self.used];
            self.used += 1;
        }
        self.left -= count as u64;
        Ok(count)
    }
}

/// One byte into a CRC-32, as the old ZIP scheme moves its keys.
fn crc_byte(crc: u32, byte: u8) -> u32 {
    let mut part = (crc ^ u32::from(byte)) & 0xFF;
    for _ in 0..8 {
        part = if part & 1 != 0 { 0xEDB8_8320 ^ (part >> 1) } else { part >> 1 };
    }
    part ^ (crc >> 8)
}

/// The old ZIP scheme's three keys.
struct Keys([u32; 3]);

impl Keys {
    fn new(password: &[u8]) -> Self {
        let mut keys = Self([0x1234_5678, 0x2345_6789, 0x3456_7890]);
        for &byte in password {
            keys.take(byte);
        }
        keys
    }

    fn take(&mut self, plain: u8) {
        let [first, second, third] = &mut self.0;
        *first = crc_byte(*first, plain);
        *second = second.wrapping_add(*first & 0xFF).wrapping_mul(134_775_813).wrapping_add(1);
        *third = crc_byte(*third, (*second >> 24) as u8);
    }

    fn unlock(&mut self, locked: u8) -> u8 {
        let mixed = (self.0[2] | 2) as u16;
        let plain = locked ^ (mixed.wrapping_mul(mixed ^ 1) >> 8) as u8;
        self.take(plain);
        plain
    }

    #[cfg(test)]
    fn lock(&mut self, plain: u8) -> u8 {
        let mixed = (self.0[2] | 2) as u16;
        let locked = plain ^ (mixed.wrapping_mul(mixed ^ 1) >> 8) as u8;
        self.take(plain);
        locked
    }
}

struct Legacy<R> {
    from: R,
    keys: Keys,
}

impl<R: Read> Read for Legacy<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.from.read(buffer)?;
        for byte in &mut buffer[..count] {
            *byte = self.keys.unlock(*byte);
        }
        Ok(count)
    }
}

/// The squeezed bytes of a locked entry, read from its raw data `raw` of `length` bytes, and
/// whether the CRC the archive keeps is of the file. `crc` and `time` (in DOS form) are what the
/// old scheme's one-byte check can be against. A wrong password fails at once.
pub fn unlocked<'a>(mut raw: impl Read + 'a, length: u64, extra: &[u8], password: &[u8], crc: u32, time: u16) -> Result<(Box<dyn Read + 'a>, bool), ZipError> {
    if let Some((version, key)) = aes_of(extra) {
        // 8, 12 or 16 bytes, half the key.
        let salt_length = key / 2;
        let mut salt = vec![0; salt_length];
        raw.read_exact(&mut salt)?;
        let mut check = [0; AES_CHECK];
        raw.read_exact(&mut check)?;
        let mut derived = vec![0; key * 2 + AES_CHECK];
        pbkdf2::pbkdf2::<SimpleHmacReset<Sha1>>(password, &salt, AES_ROUNDS, &mut derived).map_err(|_| ZipError::InvalidPassword)?;
        if derived[key * 2..] != check {
            return Err(ZipError::InvalidPassword);
        }
        let left = length.checked_sub((salt_length + AES_CHECK + AES_AUTH) as u64).ok_or(ZipError::InvalidPassword)?;
        let cipher = Cipher::new(&derived[..key]).ok_or(ZipError::InvalidPassword)?;
        let mac = SimpleHmacReset::<Sha1>::new_from_slice(&derived[key..key * 2]).map_err(|_| ZipError::InvalidPassword)?;
        let reader = AesRead { from: raw, left, cipher, counter: 1, stream: [0; 16], used: 16, mac, checked: false };
        return Ok((Box::new(reader), version == 1));
    }
    let mut keys = Keys::new(password);
    let mut header = [0; 12];
    raw.read_exact(&mut header)?;
    let last = header.iter().fold(0, |_, &byte| keys.unlock(byte));
    // The check is the CRC's top byte, or the time's when the CRC came after the data.
    if last != (crc >> 24) as u8 && last != (time >> 8) as u8 {
        return Err(ZipError::InvalidPassword);
    }
    Ok((Box::new(Legacy { from: raw.take(length.saturating_sub(12)), keys }), true))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use zip::unstable::write::FileOptionsExt;
    use zip::write::SimpleFileOptions;

    use super::*;

    /// The raw data, extra field, CRC and DOS time of the one file in a ZIP the zip crate locked.
    fn locked(options: SimpleFileOptions, text: &[u8]) -> (Vec<u8>, Vec<u8>, u32, u16) {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("a.bin", options.compression_method(zip::CompressionMethod::Stored)).unwrap();
        zip.write_all(text).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut raw = archive.by_index_raw(0).unwrap();
        let (extra, crc, time) = (raw.extra_data().unwrap_or_default(), raw.crc32(), raw.last_modified().map_or(0, |time| time.timepart()));
        let mut data = Vec::new();
        raw.read_to_end(&mut data).unwrap();
        (data, extra, crc, time)
    }

    fn read(data: &[u8], extra: &[u8], password: &[u8], crc: u32, time: u16) -> Result<(Vec<u8>, bool), ZipError> {
        let (mut reader, keeps_crc) = unlocked(data, data.len() as u64, extra, password, crc, time)?;
        let mut out = Vec::new();
        reader.read_to_end(&mut out)?;
        Ok((out, keeps_crc))
    }

    #[test]
    fn what_the_zip_crate_locks_unlocks_here() {
        let long = b"long enough to keep its CRC in AE-1".as_slice();
        for mode in [zip::AesMode::Aes128, zip::AesMode::Aes192, zip::AesMode::Aes256] {
            let (data, extra, crc, time) = locked(SimpleFileOptions::default().with_aes_encryption(mode, "pw"), long);
            assert_eq!(read(&data, &extra, b"pw", crc, time).unwrap(), (long.to_vec(), true), "{mode:?}");
            assert!(matches!(read(&data, &extra, b"no", crc, time), Err(ZipError::InvalidPassword)));
        }
        // A short file is AE-2, whose CRC is left out.
        let (data, extra, crc, time) = locked(SimpleFileOptions::default().with_aes_encryption(zip::AesMode::Aes256, "pw"), b"short");
        assert_eq!(read(&data, &extra, b"pw", crc, time).unwrap(), (b"short".to_vec(), false));
        // Changed data fails its code at the end.
        let mut spoiled = data.clone();
        spoiled[18] ^= 1;
        assert!(read(&spoiled, &extra, b"pw", crc, time).is_err());

        let (data, extra, crc, time) = locked(SimpleFileOptions::default().with_deprecated_encryption(b"pw").unwrap(), long);
        assert_eq!(read(&data, &extra, b"pw", crc, time).unwrap(), (long.to_vec(), true));
        assert!(matches!(read(&data, &extra, b"no", crc, time), Err(ZipError::InvalidPassword)));
    }

    #[test]
    fn the_old_scheme_locks_and_unlocks_alike() {
        let (mut lock, mut unlock) = (Keys::new(b"secret"), Keys::new(b"secret"));
        let locked: Vec<u8> = b"any bytes at all".iter().map(|&byte| lock.lock(byte)).collect();
        let unlocked: Vec<u8> = locked.iter().map(|&byte| unlock.unlock(byte)).collect();
        assert_eq!(unlocked, b"any bytes at all");
        assert_eq!(crc_byte(0xFFFF_FFFF, b'a') ^ 0xFFFF_FFFF, 0xE8B7_BE43, "CRC-32 of \"a\"");
    }
}
