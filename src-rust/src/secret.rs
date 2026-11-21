//! Remembered SSH passwords ("Remember password" in the session dialog).
//!
//! Stored in sessions.json as `"savedPassword": "v1:<hex>"` — AES-256-GCM with a random nonce.
//! The key is derived from this computer and user (machine-id, home directory, uid), so the
//! file is useless when copied elsewhere and no separate key file is needed. This protects the
//! password from casual reading / syncing of the config; it is not a replacement for an OS keyring
//! against software running as the same user.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};

const PREFIX: &str = "v1:";

fn machine_secret() -> Vec<u8> {
    let mut material = b"metroterm-saved-password-v1\0".to_vec();
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(id) = std::fs::read_to_string(path) {
            material.extend_from_slice(id.trim().as_bytes());
            break;
        }
    }
    material.push(0);
    if let Some(home) = dirs::home_dir() {
        material.extend_from_slice(home.to_string_lossy().as_bytes());
    }
    material.push(0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Some(uid) = dirs::home_dir()
            .and_then(|home| std::fs::metadata(home).ok())
            .map(|meta| meta.uid())
        {
            material.extend_from_slice(uid.to_string().as_bytes());
        }
    }
    #[cfg(windows)]
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        material.extend_from_slice(name.as_bytes());
    }
    material
}

fn key() -> LessSafeKey {
    let hash = digest(&SHA256, &machine_secret());
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, hash.as_ref()).expect("32-byte key"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(text.get(index..index + 2)?, 16).ok())
        .collect()
}

/// Encrypt a password for sessions.json.
pub fn seal(plain: &str) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "no random source".to_owned())?;
    let mut data = plain.as_bytes().to_vec();
    key()
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
        .map_err(|_| "encryption failed".to_owned())?;
    Ok(format!("{PREFIX}{}{}", hex(&nonce), hex(&data)))
}

/// Decrypt a saved password; `None` when it was saved on another computer / user or is damaged.
pub fn open(sealed: &str) -> Option<String> {
    let bytes = unhex(sealed.strip_prefix(PREFIX)?)?;
    if bytes.len() <= NONCE_LEN {
        return None;
    }
    let (nonce, data) = bytes.split_at(NONCE_LEN);
    let mut data = data.to_vec();
    let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
    let plain = key().open_in_place(nonce, Aad::empty(), &mut data).ok()?;
    String::from_utf8(plain.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        let sealed = super::seal("metro123 密码").unwrap();
        assert!(sealed.starts_with("v1:"));
        assert_eq!(super::open(&sealed).as_deref(), Some("metro123 密码"));
        assert_eq!(super::open("v1:00"), None);
        let mut broken = sealed.clone();
        let flipped = if sealed.ends_with('0') { "1" } else { "0" };
        broken.replace_range(sealed.len() - 1.., flipped);
        assert_eq!(super::open(&broken), None);
    }
}
