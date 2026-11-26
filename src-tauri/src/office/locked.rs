//! Office documents under a password, as Office 2007 and later lock them: the whole package is
//! encrypted inside a compound file. Both of Office's ways are read, the "agile" one of 2010 and
//! later and the "standard" one of 2007. Perli only reads: it never locks anything.

use std::io::Read as _;
use std::path::Path;

use aes::cipher::{BlockCipherDecrypt, KeyInit};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

use super::{attribute, walk, Node, Opened, WRONG_PASSWORD};

const SEGMENT: usize = 4096;
const VERIFIER_INPUT: [u8; 8] = [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79];
const VERIFIER_VALUE: [u8; 8] = [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e];
const KEY_VALUE: [u8; 8] = [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6];
const STANDARD_SPINS: u32 = 50_000;
/// Office uses 100,000; a file asking for far more would keep Perli busy for nothing.
const MOST_SPINS: u32 = 10_000_000;

pub(super) fn is_locked(path: &Path) -> bool {
    cfb::open(path).is_ok_and(|file| file.is_stream("/EncryptionInfo") && file.is_stream("/EncryptedPackage"))
}

fn failed(reason: &str) -> Opened {
    Opened::Failed(reason.into())
}

/// The package inside, unlocked with `password`.
pub(super) fn unlock(path: &Path, password: &str) -> Result<Vec<u8>, Opened> {
    let mut file = cfb::open(path).map_err(|_| failed("It isn't a document Perli can read"))?;
    let mut read = |name: &str| -> Result<Vec<u8>, Opened> {
        let mut bytes = Vec::new();
        file.open_stream(name).map_err(|_| failed("Its lock looks damaged"))?.read_to_end(&mut bytes).map_err(|error| failed(&error.to_string()))?;
        Ok(bytes)
    };
    let info = read("/EncryptionInfo")?;
    let package = read("/EncryptedPackage")?;
    let password: Vec<u8> = password.encode_utf16().flat_map(u16::to_le_bytes).collect();
    match (info.get(0..2), info.get(2..4)) {
        (Some([4, 0]), Some([4, 0])) => agile(&info, &package, &password),
        (Some([3 | 4, 0]), Some([2, 0])) => standard(&info, &package, &password),
        _ => Err(failed("It is locked in a way Perli doesn't know. Office opens it")),
    }
}

#[derive(Clone, Copy)]
enum Hash {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    fn named(name: &str) -> Option<Hash> {
        Some(match name.to_ascii_uppercase().replace('-', "").as_str() {
            "SHA1" => Hash::Sha1,
            "SHA256" => Hash::Sha256,
            "SHA384" => Hash::Sha384,
            "SHA512" => Hash::Sha512,
            _ => return None,
        })
    }

    fn of(self, parts: &[&[u8]]) -> Vec<u8> {
        fn run<D: Digest>(parts: &[&[u8]]) -> Vec<u8> {
            let mut digest = D::new();
            for part in parts {
                digest.update(part);
            }
            digest.finalize().to_vec()
        }
        match self {
            Hash::Sha1 => run::<Sha1>(parts),
            Hash::Sha256 => run::<Sha256>(parts),
            Hash::Sha384 => run::<Sha384>(parts),
            Hash::Sha512 => run::<Sha512>(parts),
        }
    }
}

/// `bytes` cut or filled with 0x36 to `length`, as Office sizes keys and starting blocks.
fn sized(mut bytes: Vec<u8>, length: usize) -> Vec<u8> {
    bytes.resize(length, 0x36);
    bytes
}

enum Cipher {
    Aes128(aes::Aes128),
    Aes192(aes::Aes192),
    Aes256(aes::Aes256),
}

impl Cipher {
    fn new(key: &[u8]) -> Result<Cipher, Opened> {
        let bad = |_| failed("Its key has a size Perli doesn't know");
        Ok(match key.len() {
            16 => Cipher::Aes128(aes::Aes128::new_from_slice(key).map_err(bad)?),
            24 => Cipher::Aes192(aes::Aes192::new_from_slice(key).map_err(bad)?),
            32 => Cipher::Aes256(aes::Aes256::new_from_slice(key).map_err(bad)?),
            _ => return Err(failed("Its key has a size Perli doesn't know")),
        })
    }

    fn block(&self, bytes: &mut [u8]) {
        let mut block = aes::Block::try_from(&bytes[..16]).unwrap_or_default();
        match self {
            Cipher::Aes128(cipher) => cipher.decrypt_block(&mut block),
            Cipher::Aes192(cipher) => cipher.decrypt_block(&mut block),
            Cipher::Aes256(cipher) => cipher.decrypt_block(&mut block),
        }
        bytes[..16].copy_from_slice(&block);
    }

    /// CBC from `start`. Whole blocks only; a ragged end is left as it is.
    fn chained(&self, data: &[u8], start: &[u8]) -> Vec<u8> {
        let mut out = data.to_vec();
        let mut before: [u8; 16] = start.get(..16).and_then(|start| start.try_into().ok()).unwrap_or([0; 16]);
        for block in out.as_chunks_mut::<16>().0 {
            let sealed = *block;
            self.block(block);
            for (byte, mask) in block.iter_mut().zip(before) {
                *byte ^= mask;
            }
            before = sealed;
        }
        out
    }

    fn each(&self, data: &[u8]) -> Vec<u8> {
        let mut out = data.to_vec();
        for block in out.as_chunks_mut::<16>().0 {
            self.block(block);
        }
        out
    }
}

fn base64(text: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text.trim()).unwrap_or_default()
}

fn agile(info: &[u8], package: &[u8], password: &[u8]) -> Result<Vec<u8>, Opened> {
    let xml = String::from_utf8_lossy(info.get(8..).unwrap_or_default()).into_owned();
    let (mut key_data, mut sealed) = (None, None);
    walk(&xml, |node| {
        if let Node::Open(name, start) = node {
            let read = |key: &str| attribute(start, key).unwrap_or_default();
            let fields = || {
                [
                    "saltValue",
                    "hashAlgorithm",
                    "keyBits",
                    "blockSize",
                    "spinCount",
                    "encryptedVerifierHashInput",
                    "encryptedVerifierHashValue",
                    "encryptedKeyValue",
                    "uri",
                ]
                .map(read)
            };
            match name {
                "keyData" => key_data = Some(fields()),
                // Only the password's key: a certificate's key has no verifier of this kind.
                "encryptedKey" if !read("encryptedVerifierHashInput").is_empty() => sealed = Some(fields()),
                _ => {}
            }
        }
    });
    let (Some(data), Some(key)) = (key_data, sealed) else { return Err(failed("Its lock looks damaged")) };
    let number = |text: &str| text.parse::<usize>().map_err(|_| failed("Its lock looks damaged"));
    let hash = Hash::named(&key[1]).ok_or_else(|| failed("It is locked in a way Perli doesn't know. Office opens it"))?;
    let (key_bytes, block_size) = (number(&key[2])? / 8, number(&key[3])?);
    let spins = (number(&key[4])? as u32).min(MOST_SPINS);
    let salt = base64(&key[0]);
    let mut digest = hash.of(&[&salt, password]);
    for spin in 0..spins {
        digest = hash.of(&[&spin.to_le_bytes(), &digest]);
    }
    let key_for = |block: &[u8]| sized(hash.of(&[&digest, block]), key_bytes);
    let start = sized(salt.clone(), block_size);
    let input = Cipher::new(&key_for(&VERIFIER_INPUT))?.chained(&base64(&key[5]), &start);
    let value = Cipher::new(&key_for(&VERIFIER_VALUE))?.chained(&base64(&key[6]), &start);
    let wanted = hash.of(&[input.get(..salt.len()).unwrap_or(&input)]);
    if value.get(..wanted.len()) != Some(&wanted[..]) {
        return Err(Opened::Failed(WRONG_PASSWORD.into()));
    }
    let secret = Cipher::new(&key_for(&KEY_VALUE))?.chained(&base64(&key[7]), &start);
    let data_hash = Hash::named(&data[1]).unwrap_or(hash);
    let data_key = secret.get(..number(&data[2])? / 8).ok_or_else(|| failed("Its lock looks damaged"))?;
    let data_block = number(&data[3])?;
    let data_salt = base64(&data[0]);
    let cipher = Cipher::new(data_key)?;
    let size = u64::from_le_bytes(package.get(..8).and_then(|size| size.try_into().ok()).ok_or_else(|| failed("Its lock looks damaged"))?) as usize;
    let mut out = Vec::with_capacity(size.min(package.len()));
    for (index, segment) in package[8..].chunks(SEGMENT).enumerate() {
        let start = sized(data_hash.of(&[&data_salt, &(index as u32).to_le_bytes()]), data_block);
        out.extend(cipher.chained(segment, &start));
    }
    out.truncate(size);
    Ok(out)
}

fn standard(info: &[u8], package: &[u8], password: &[u8]) -> Result<Vec<u8>, Opened> {
    let damaged = || failed("Its lock looks damaged");
    let u32_at = |at: usize| info.get(at..at + 4).and_then(|bytes| bytes.try_into().ok()).map(u32::from_le_bytes).ok_or_else(damaged);
    let header_size = u32_at(8)? as usize;
    let header = 12;
    if u32_at(header + 8)? & 0xFF00 != 0x6600 {
        return Err(failed("It is locked in a way Perli doesn't know. Office opens it"));
    }
    let key_bytes = u32_at(header + 16)? as usize / 8;
    let verifier = header + header_size;
    let salt_size = u32_at(verifier)? as usize;
    let salt = info.get(verifier + 4..verifier + 4 + salt_size).ok_or_else(damaged)?;
    let sealed_verifier = info.get(verifier + 4 + salt_size..verifier + 20 + salt_size).ok_or_else(damaged)?;
    let sealed_hash = info.get(verifier + 24 + salt_size..verifier + 56 + salt_size).ok_or_else(damaged)?;
    let mut digest = Hash::Sha1.of(&[salt, password]);
    for spin in 0..STANDARD_SPINS {
        digest = Hash::Sha1.of(&[&spin.to_le_bytes(), &digest]);
    }
    let last = Hash::Sha1.of(&[&digest, &0u32.to_le_bytes()]);
    let mixed = |fill: u8| {
        let mut buffer = [fill; 64];
        for (byte, from) in buffer.iter_mut().zip(&last) {
            *byte ^= from;
        }
        Hash::Sha1.of(&[&buffer])
    };
    let key = [mixed(0x36), mixed(0x5c)].concat();
    let cipher = Cipher::new(key.get(..key_bytes).ok_or_else(damaged)?)?;
    let verifier = cipher.each(sealed_verifier);
    let wanted = Hash::Sha1.of(&[&verifier]);
    if cipher.each(sealed_hash).get(..20) != Some(&wanted[..]) {
        return Err(Opened::Failed(WRONG_PASSWORD.into()));
    }
    let size = u64::from_le_bytes(package.get(..8).and_then(|size| size.try_into().ok()).ok_or_else(damaged)?) as usize;
    let mut out = cipher.each(&package[8..]);
    out.truncate(size);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockCipherEncrypt;
    use std::io::Write;

    fn seal(key: &[u8], data: &[u8], start: Option<&[u8]>) -> Vec<u8> {
        let cipher: Box<dyn Fn(&mut aes::Block)> = if key.len() == 32 {
            let cipher = aes::Aes256::new_from_slice(key).unwrap();
            Box::new(move |block: &mut aes::Block| cipher.encrypt_block(block))
        } else {
            let cipher = aes::Aes128::new_from_slice(key).unwrap();
            Box::new(move |block: &mut aes::Block| cipher.encrypt_block(block))
        };
        let mut padded = data.to_vec();
        padded.resize(data.len().div_ceil(16) * 16, 0);
        let mut before: [u8; 16] = start.map(|start| start[..16].try_into().unwrap()).unwrap_or([0; 16]);
        for chunk in padded.as_chunks_mut::<16>().0 {
            if start.is_some() {
                for (byte, mask) in chunk.iter_mut().zip(before) {
                    *byte ^= mask;
                }
            }
            let mut block = aes::Block::try_from(&chunk[..]).unwrap();
            cipher(&mut block);
            chunk.copy_from_slice(&block);
            before = *chunk;
        }
        padded
    }

    fn password(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    fn encode(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// A package locked the agile way, as Office 2010 and later write it, with few spins.
    fn agile_locked(secret_package: &[u8], pass: &str) -> (Vec<u8>, Vec<u8>) {
        let hash = Hash::Sha512;
        let (key_salt, data_salt) = ([7u8; 16], [9u8; 16]);
        let spins = 10u32;
        let mut digest = hash.of(&[&key_salt, &password(pass)]);
        for spin in 0..spins {
            digest = hash.of(&[&spin.to_le_bytes(), &digest]);
        }
        let key_for = |block: &[u8]| sized(hash.of(&[&digest, block]), 32);
        let secret = [5u8; 32];
        let input = [3u8; 16];
        let input_hash = hash.of(&[&input]);
        let xml = format!(
            r#"<?xml version="1.0"?><encryption xmlns="e" xmlns:p="p"><keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="{}"/><keyEncryptors><keyEncryptor uri="password"><p:encryptedKey spinCount="{spins}" saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="{}" encryptedVerifierHashInput="{}" encryptedVerifierHashValue="{}" encryptedKeyValue="{}"/></keyEncryptor></keyEncryptors></encryption>"#,
            encode(&data_salt),
            encode(&key_salt),
            encode(&seal(&key_for(&VERIFIER_INPUT), &input, Some(&key_salt))),
            encode(&seal(&key_for(&VERIFIER_VALUE), &input_hash, Some(&key_salt))),
            encode(&seal(&key_for(&KEY_VALUE), &secret, Some(&key_salt))),
        );
        let info = [&[4u8, 0, 4, 0, 0x40, 0, 0, 0][..], xml.as_bytes()].concat();
        let mut sealed = (secret_package.len() as u64).to_le_bytes().to_vec();
        for (index, segment) in secret_package.chunks(SEGMENT).enumerate() {
            let start = sized(hash.of(&[&data_salt, &(index as u32).to_le_bytes()]), 16);
            sealed.extend(seal(&secret, segment, Some(&start)));
        }
        (info, sealed)
    }

    #[test]
    fn unlocks_the_agile_way() {
        let secret: Vec<u8> = (0..5000u32).map(|at| (at % 251) as u8).collect();
        let (info, sealed) = agile_locked(&secret, "kiwi");
        assert_eq!(agile(&info, &sealed, &password("kiwi")).ok(), Some(secret));
        assert!(matches!(agile(&info, &sealed, &password("pear")), Err(Opened::Failed(reason)) if reason == WRONG_PASSWORD));
    }

    /// A package locked as a whole file: the compound file Office writes, holding the lock and
    /// the sealed package.
    fn write_locked(path: &Path, package: &[u8], pass: &str) {
        let (info, sealed) = agile_locked(package, pass);
        let mut file = cfb::create(path).unwrap();
        file.create_stream("/EncryptionInfo").unwrap().write_all(&info).unwrap();
        file.create_stream("/EncryptedPackage").unwrap().write_all(&sealed).unwrap();
        file.flush().unwrap();
    }

    #[test]
    fn a_locked_file_opens_whole_with_its_password() {
        let plain = super::super::tests::package("lockme.docx", &[("word/document.xml", b"<w:document/>")]);
        let bytes = std::fs::read(&plain).unwrap();
        let path = plain.with_file_name("locked.docx");
        write_locked(&path, &bytes, "kiwi");
        assert!(is_locked(&path));
        assert_eq!(unlock(&path, "kiwi").ok(), Some(bytes));
        assert!(matches!(unlock(&path, "pear"), Err(Opened::Failed(reason)) if reason == WRONG_PASSWORD));
    }

    /// Writes a locked copy of PERLI_LOCKED_IN to PERLI_LOCKED_OUT with the password "kiwi",
    /// for the real-app check.
    #[test]
    #[ignore]
    fn writes_a_locked_sample() {
        let (Ok(from), Ok(to)) = (std::env::var("PERLI_LOCKED_IN"), std::env::var("PERLI_LOCKED_OUT")) else { return };
        write_locked(Path::new(&to), &std::fs::read(from).unwrap(), "kiwi");
    }

    #[test]
    fn unlocks_the_standard_way() {
        let salt = [4u8; 16];
        let mut digest = Hash::Sha1.of(&[&salt, &password("fig")]);
        for spin in 0..STANDARD_SPINS {
            digest = Hash::Sha1.of(&[&spin.to_le_bytes(), &digest]);
        }
        let last = Hash::Sha1.of(&[&digest, &0u32.to_le_bytes()]);
        let mut buffer = [0x36u8; 64];
        for (byte, from) in buffer.iter_mut().zip(&last) {
            *byte ^= from;
        }
        let key = Hash::Sha1.of(&[&buffer])[..16].to_vec();
        let verifier = [8u8; 16];
        let verifier_hash = Hash::Sha1.of(&[&verifier]);
        let mut header = Vec::new();
        for value in [0u32, 0, 0x660E, 0x8004, 128, 0x18, 0, 0] {
            header.extend(value.to_le_bytes());
        }
        let mut info = vec![3, 0, 2, 0];
        info.extend(0x24u32.to_le_bytes());
        info.extend((header.len() as u32).to_le_bytes());
        info.extend(&header);
        info.extend(16u32.to_le_bytes());
        info.extend(salt);
        info.extend(seal(&key, &verifier, None));
        info.extend(20u32.to_le_bytes());
        info.extend(seal(&key, &verifier_hash, None));
        let secret = b"PK this is the package inside".to_vec();
        let mut sealed = (secret.len() as u64).to_le_bytes().to_vec();
        sealed.extend(seal(&key, &secret, None));
        assert_eq!(standard(&info, &sealed, &password("fig")).ok(), Some(secret));
        assert!(matches!(standard(&info, &sealed, &password("nut")), Err(Opened::Failed(reason)) if reason == WRONG_PASSWORD));
    }
}
