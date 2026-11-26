//! Logical key names → the bytes a terminal sends for them (MCP `send_keys`: `esc`, `ctrl+c` …).
//!
//! Names are case-insensitive: `enter`, `esc`, `tab`, `shift+tab`, `backspace`, `delete`, `insert`,
//! `up` / `down` / `left` / `right`, `home`, `end`, `pageup`, `pagedown`, `space`, `f1`…`f12`, a
//! single character (`y`, `1`, `/`), with modifiers `ctrl+`, `alt+`, `shift+` (`ctrl+c`, `alt+b`,
//! `shift+up`, `ctrl+left`). Arrows and Home / End follow the terminal's cursor-key mode.

#[derive(Default, Clone, Copy)]
struct Mods {
    ctrl: bool,
    alt: bool,
    shift: bool,
}

impl Mods {
    /// xterm's modifier parameter (`CSI 1 ; m A`), None without modifiers.
    fn param(self) -> Option<u8> {
        let value = 1 + u8::from(self.shift) + 2 * u8::from(self.alt) + 4 * u8::from(self.ctrl);
        (value > 1).then_some(value)
    }
}

/// One key; Err = the name is not known (nothing is sent then).
pub fn encode(name: &str, application_cursor: bool) -> Result<Vec<u8>, String> {
    let unknown = || format!("unknown key {name:?}");
    let lower = name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return Err(unknown());
    }
    // "ctrl++" / "+": the last part may itself be "+".
    let (mods_text, key) = match lower.strip_suffix("++") {
        Some(rest) => (format!("{rest}+"), "+".to_owned()),
        None => match lower.rsplit_once('+') {
            Some((mods, key)) if !key.is_empty() => (format!("{mods}+"), key.to_owned()),
            _ => (String::new(), lower.clone()),
        },
    };
    let mut mods = Mods::default();
    for part in mods_text.split('+').filter(|part| !part.is_empty()) {
        match part {
            "ctrl" | "control" => mods.ctrl = true,
            "alt" | "meta" | "option" => mods.alt = true,
            "shift" => mods.shift = true,
            _ => return Err(unknown()),
        }
    }
    // The original spelling of a single character (`Y` stays upper case).
    let original_key = if key == "+" {
        "+"
    } else {
        name.trim().rsplit('+').next().unwrap_or_default()
    };
    let csi = |final_byte: char| -> Vec<u8> {
        match mods.param() {
            Some(m) => format!("\x1b[1;{m}{final_byte}").into_bytes(),
            None if application_cursor => format!("\x1bO{final_byte}").into_bytes(),
            None => format!("\x1b[{final_byte}").into_bytes(),
        }
    };
    let tilde = |code: u8| -> Vec<u8> {
        match mods.param() {
            Some(m) => format!("\x1b[{code};{m}~").into_bytes(),
            None => format!("\x1b[{code}~").into_bytes(),
        }
    };
    let alt = |bytes: Vec<u8>| -> Vec<u8> {
        if mods.alt {
            let mut out = vec![0x1b];
            out.extend(bytes);
            out
        } else {
            bytes
        }
    };
    let bytes = match key.as_str() {
        "enter" | "return" | "cr" => alt(b"\r".to_vec()),
        "esc" | "escape" => alt(b"\x1b".to_vec()),
        "tab" if mods.shift => b"\x1b[Z".to_vec(),
        "tab" => alt(b"\t".to_vec()),
        "backtab" => b"\x1b[Z".to_vec(),
        "backspace" | "bs" if mods.ctrl => alt(vec![0x08]),
        "backspace" | "bs" => alt(vec![0x7f]),
        "space" if mods.ctrl => alt(vec![0]),
        "space" => alt(b" ".to_vec()),
        "up" => csi('A'),
        "down" => csi('B'),
        "right" => csi('C'),
        "left" => csi('D'),
        "home" => csi('H'),
        "end" => csi('F'),
        "insert" | "ins" => tilde(2),
        "delete" | "del" => tilde(3),
        "pageup" | "pgup" => tilde(5),
        "pagedown" | "pgdn" => tilde(6),
        "f1" | "f2" | "f3" | "f4" => {
            let final_byte = (b'P' + key[1..].parse::<u8>().unwrap() - 1) as char;
            match mods.param() {
                Some(m) => format!("\x1b[1;{m}{final_byte}").into_bytes(),
                None => format!("\x1bO{final_byte}").into_bytes(),
            }
        }
        _ if key.starts_with('f') && key.len() <= 3 && key[1..].parse::<u8>().is_ok() => {
            let code = match key[1..].parse::<u8>().unwrap() {
                5 => 15,
                6 => 17,
                7 => 18,
                8 => 19,
                9 => 20,
                10 => 21,
                11 => 23,
                12 => 24,
                _ => return Err(unknown()),
            };
            tilde(code)
        }
        _ => {
            let mut chars = original_key.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else {
                return Err(unknown());
            };
            if mods.ctrl {
                let control = match c.to_ascii_lowercase() {
                    c @ 'a'..='z' => c as u8 - b'a' + 1,
                    '@' | '2' | ' ' => 0,
                    '[' | '3' => 0x1b,
                    '\\' | '4' => 0x1c,
                    ']' | '5' => 0x1d,
                    '^' | '6' => 0x1e,
                    '_' | '-' | '7' => 0x1f,
                    '?' | '8' => 0x7f,
                    _ => return Err(unknown()),
                };
                alt(vec![control])
            } else {
                let c = if mods.shift {
                    c.to_ascii_uppercase()
                } else {
                    c
                };
                alt(c.to_string().into_bytes())
            }
        }
    };
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::encode;

    fn key(name: &str) -> Vec<u8> {
        encode(name, false).unwrap()
    }

    #[test]
    fn keys() {
        assert_eq!(key("Enter"), b"\r");
        assert_eq!(key("esc"), b"\x1b");
        assert_eq!(key("ctrl+c"), [3]);
        assert_eq!(key("Ctrl+D"), [4]);
        assert_eq!(key("ctrl+["), [0x1b]);
        assert_eq!(key("shift+tab"), b"\x1b[Z");
        assert_eq!(key("backspace"), [0x7f]);
        assert_eq!(key("up"), b"\x1b[A");
        assert_eq!(encode("up", true).unwrap(), b"\x1bOA");
        assert_eq!(encode("shift+up", true).unwrap(), b"\x1b[1;2A");
        assert_eq!(key("ctrl+left"), b"\x1b[1;5D");
        assert_eq!(key("delete"), b"\x1b[3~");
        assert_eq!(key("pagedown"), b"\x1b[6~");
        assert_eq!(key("f1"), b"\x1bOP");
        assert_eq!(key("f5"), b"\x1b[15~");
        assert_eq!(key("f12"), b"\x1b[24~");
        assert_eq!(key("alt+b"), b"\x1bb");
        assert_eq!(key("y"), b"y");
        assert_eq!(key("Y"), b"Y");
        assert_eq!(key("shift+y"), b"Y");
        assert_eq!(key("1"), b"1");
        assert_eq!(key("+"), b"+");
        assert_eq!(key("space"), b" ");
        assert_eq!(key("中"), "中".as_bytes());
        for bad in ["", "hyper+x", "f13", "enterr", "ctrl+é", "ab"] {
            assert!(encode(bad, false).is_err(), "{bad}");
        }
    }
}
