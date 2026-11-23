//! Terminal colour schemes: iTerm2 `.itermcolors` files in `~/.metroterm/themes/black/` (for the
//! dark and Gold app themes) and `~/.metroterm/themes/white/` (for the light theme). More schemes
//! are added by dropping files there (e.g. from https://terminalthemes.com/themes); the UI parses
//! them (src/lib/terminal/itermcolors.ts) and Settings → TERMINAL COLORS picks one per app theme.
//!
//! On first use each folder without any scheme gets MetroTerm's defaults (src-rust/themes/, made
//! from src/lib/terminal/scheme.ts by .devtools/gen_themes.py): “MetroTerm Dark” in black/ (the dark
//! and Gold themes share it) and “MetroTerm Light” in white/.

use crate::common::config;
use serde::Serialize;
use std::{fs, path::PathBuf};

pub const FOLDERS: [&str; 2] = ["black", "white"];
const EXTENSION: &str = "itermcolors";
/// A scheme is a small XML plist (~10 KB); anything far bigger is not one.
const MAX_SIZE: u64 = 1024 * 1024;

const DEFAULTS: [(&str, &str, &str); 2] = [
    (
        "black",
        "MetroTerm Dark",
        include_str!("../../themes/black/MetroTerm Dark.itermcolors"),
    ),
    (
        "white",
        "MetroTerm Light",
        include_str!("../../themes/white/MetroTerm Light.itermcolors"),
    ),
];

#[derive(Serialize)]
pub struct ThemeList {
    pub dir: String,
    pub black: Vec<String>,
    pub white: Vec<String>,
}

fn themes_dir() -> Result<PathBuf, String> {
    Ok(config::config_dir()?.join("themes"))
}

fn names(dir: &PathBuf) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_scheme = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case(EXTENSION));
            if !is_scheme || !path.is_file() {
                return None;
            }
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names
}

/// The Gold theme had its own default scheme until it was merged into “MetroTerm Dark”: the file
/// older versions wrote to `themes/black/` (FNV-1a 64 of its bytes) is removed when it is still
/// exactly that file; an edited copy is the user's and stays.
const RETIRED: [(&str, u64); 1] = [("MetroTerm Gold", 0x9c18_3427_7f05_5be2)];

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn remove_retired(dir: &std::path::Path) {
    for (name, hash) in RETIRED {
        let path = dir.join(format!("{name}.{EXTENSION}"));
        if fs::read(&path).is_ok_and(|bytes| fnv1a(&bytes) == hash) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Creates `themes/black` and `themes/white`; a folder without any scheme gets the defaults.
pub fn ensure() -> Result<PathBuf, String> {
    let root = config::ensure_dir()?.join("themes");
    for folder in FOLDERS {
        let dir = root.join(folder);
        fs::create_dir_all(&dir)
            .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
        remove_retired(&dir);
        if !names(&dir).is_empty() {
            continue;
        }
        for (_, name, text) in DEFAULTS.iter().filter(|(of, _, _)| *of == folder) {
            let path = dir.join(format!("{name}.{EXTENSION}"));
            fs::write(&path, text)
                .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        }
    }
    Ok(root)
}

/// The schemes of both folders (file names without `.itermcolors`, sorted).
pub fn list() -> Result<ThemeList, String> {
    let root = ensure()?;
    Ok(ThemeList {
        dir: root.display().to_string(),
        black: names(&root.join("black")),
        white: names(&root.join("white")),
    })
}

/// The text of one scheme file. `folder` is black / white; `name` a plain file name (no path).
pub fn load(folder: &str, name: &str) -> Result<String, String> {
    if !FOLDERS.contains(&folder) {
        return Err(format!("Unknown theme folder: {folder}"));
    }
    let plain = !name.is_empty()
        && name.len() <= 200
        && !name.contains(['/', '\\', '\0'])
        && name != "."
        && name != "..";
    if !plain {
        return Err(format!("Invalid theme name: {name}"));
    }
    let dir = themes_dir()?.join(folder);
    let mut path = dir.join(format!("{name}.{EXTENSION}"));
    if !path.is_file() {
        // The extension in another case (Theme.ITERMCOLORS).
        if let Some(found) = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .find(|entry| {
                let entry = entry.path();
                entry.file_stem().and_then(|stem| stem.to_str()) == Some(name)
                    && entry
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case(EXTENSION))
            })
        {
            path = found.path();
        } else {
            return Err(format!("Theme not found: {}", path.display()));
        }
    }
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_SIZE {
        return Err(format!(
            "{} is too large for a colour scheme",
            path.display()
        ));
    }
    fs::read_to_string(&path).map_err(|error| format!("cannot read {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn defaults_are_plists() {
        for (_, name, text) in super::DEFAULTS {
            assert!(text.contains("<plist"), "{name}");
            assert_eq!(text.matches("<key>Ansi ").count(), 16, "{name}");
        }
    }

    #[test]
    fn fnv1a_matches_the_reference_values() {
        assert_eq!(super::fnv1a(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(super::fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn only_an_unedited_retired_default_is_removed() {
        let dir = std::env::temp_dir().join(format!("metroterm-themes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("MetroTerm Gold.itermcolors");
        std::fs::write(&path, "edited").unwrap();
        super::remove_retired(&dir);
        assert!(path.exists(), "an edited copy stays");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
