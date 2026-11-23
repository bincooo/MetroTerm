//! UTF-8 locale for shells. A backend started without a UTF-8 locale (a bare container, a
//! systemd service, a macOS app launched from Finder …) would hand its shells the C locale:
//! readline / zle then treat every byte of a CJK character as a separate Meta key, so typed
//! Chinese turns into garbage and Backspace deletes single bytes. Like iTerm2's "set locale
//! variables automatically", shells get a UTF-8 locale when the inherited one isn't.

use std::sync::OnceLock;

fn is_utf8(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("utf-8") || value.contains("utf8")
}

fn var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

/// The locale that decides the character set: LC_ALL, then LC_CTYPE, then LANG.
fn effective() -> Option<String> {
    var("LC_ALL")
        .or_else(|| var("LC_CTYPE"))
        .or_else(|| var("LANG"))
}

/// Best UTF-8 locale of this machine: the inherited language in UTF-8 if installed, else C.UTF-8,
/// else en_US.UTF-8, else any installed UTF-8 locale.
fn pick(installed: &[String], language: Option<&str>) -> String {
    let has = |name: &str| {
        installed
            .iter()
            .find(|item| item.eq_ignore_ascii_case(name))
            .cloned()
    };
    if let Some(language) =
        language.filter(|language| !language.is_empty() && *language != "C" && *language != "POSIX")
    {
        for suffix in [".UTF-8", ".utf8"] {
            if let Some(found) = has(&format!("{language}{suffix}")) {
                return found;
            }
        }
    }
    for name in ["C.UTF-8", "C.utf8", "en_US.UTF-8", "en_US.utf8"] {
        if let Some(found) = has(name) {
            return found;
        }
    }
    installed
        .iter()
        .find(|item| is_utf8(item))
        .cloned()
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "en_US.UTF-8".into()
            } else {
                "C.UTF-8".into()
            }
        })
}

/// UTF-8 locale to use when the inherited one is not UTF-8 (`None` when it already is).
fn fallback() -> Option<&'static str> {
    static CHOSEN: OnceLock<Option<String>> = OnceLock::new();
    CHOSEN
        .get_or_init(|| {
            if effective().as_deref().is_some_and(is_utf8) {
                return None;
            }
            let installed = std::process::Command::new("locale")
                .arg("-a")
                .output()
                .ok()
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(String::from)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            // "zh_CN.GB18030" → "zh_CN"
            let language = effective().map(|value| {
                value
                    .split(['.', '@'])
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            });
            Some(pick(&installed, language.as_deref()))
        })
        .as_deref()
}

/// Environment overrides for a local shell. Variables that are set but not UTF-8 are replaced
/// (LC_ALL wins over everything, so it must not stay e.g. "C"); LANG is always made UTF-8.
#[cfg(not(windows))]
pub fn local_shell_env() -> Vec<(&'static str, String)> {
    let Some(locale) = fallback() else {
        return Vec::new();
    };
    let mut env = Vec::new();
    for key in ["LC_ALL", "LC_CTYPE"] {
        if var(key).is_some_and(|value| !is_utf8(&value)) {
            env.push((key, locale.to_owned()));
        }
    }
    if !var("LANG").as_deref().is_some_and(is_utf8) {
        env.push(("LANG", locale.to_owned()));
    }
    env
}

/// LANG sent to SSH servers (OpenSSH's `SendEnv LANG`): the local UTF-8 locale. Servers that
/// don't accept it (no `AcceptEnv LANG`) simply ignore it and keep their own default.
pub fn ssh_lang() -> String {
    match effective() {
        Some(value) if is_utf8(&value) => value,
        _ => fallback().unwrap_or("C.UTF-8").to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn detects_utf8() {
        assert!(is_utf8("en_US.UTF-8"));
        assert!(is_utf8("C.utf8"));
        assert!(!is_utf8("C"));
        assert!(!is_utf8("zh_CN.GB18030"));
    }

    #[test]
    fn picks_language_then_c_utf8() {
        assert_eq!(
            pick(
                &list(&["C", "C.utf8", "POSIX", "zh_CN.utf8"]),
                Some("zh_CN")
            ),
            "zh_CN.utf8"
        );
        assert_eq!(
            pick(&list(&["C", "C.utf8", "POSIX"]), Some("zh_CN")),
            "C.utf8"
        );
        assert_eq!(pick(&list(&["C", "C.utf8", "POSIX"]), None), "C.utf8");
        assert_eq!(pick(&list(&["C", "en_US.UTF-8"]), Some("C")), "en_US.UTF-8");
        assert_eq!(pick(&list(&["C", "de_DE.utf8"]), None), "de_DE.utf8");
    }
}
