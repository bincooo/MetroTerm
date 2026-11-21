//! Incremental UTF-8 decoding for terminal output: a read may end in the middle of a
//! multi-byte character (CJK, emoji, box drawing…). The incomplete tail is kept for the
//! next chunk instead of being replaced by U+FFFD.

#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let split = incomplete_tail_start(&self.pending);
        let tail = self.pending.split_off(split);
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending = tail;
        text
    }

    /// Whatever is left when the stream ends.
    pub fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

/// Index where a trailing, not-yet-complete UTF-8 sequence starts (or `len` if none).
fn incomplete_tail_start(bytes: &[u8]) -> usize {
    let len = bytes.len();
    // A sequence is at most 4 bytes: look back up to 3 bytes for its lead byte.
    for back in 1..=len.min(3) {
        let byte = bytes[len - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte
        }
        let expected = match byte {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => 1, // invalid lead byte: let the lossy decoder handle it
        };
        return if expected > back { len - back } else { len };
    }
    len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_split_characters() {
        let text = "终端 ✓ ok";
        let bytes = text.as_bytes();
        let mut stream = Utf8Stream::default();
        let mut out = String::new();
        for chunk in bytes.chunks(1) {
            out.push_str(&stream.decode(chunk));
        }
        out.push_str(&stream.finish());
        assert_eq!(out, text);
    }
}
