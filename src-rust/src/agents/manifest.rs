//! Detection rules of one agent CLI: a TOML manifest and its evaluation.
//!
//! A manifest is a list of rules. Each rule names a state (`idle` / `working` / `blocked` /
//! `unknown`), a priority and a region of the screen, and a gate of matchers over that region:
//! - `contains`   — every needle occurs in the region (case-insensitive)
//! - `regex`      — every pattern matches the region
//! - `line_regex` — every pattern matches at least one line of the region
//! - `all` / `any` / `not` — nested gates: all match / at least one matches / none matches
//!
//! Every rule is evaluated; the matching rule with the highest priority wins (the first one on a
//! tie). Nothing matching means `idle` (the agent runs, but shows none of its busy / question
//! screens). `skip_state_update` rules (a transcript viewer that hides the live screen) keep the
//! previous state.

use regex::Regex;
use serde::Deserialize;

/// Highest `min_engine_version` this engine supports (the regions of engine 3).
const ENGINE_VERSION: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Idle,
    Working,
    Blocked,
    Unknown,
}

/// Result of evaluating a manifest on one screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    pub state: State,
    /// Matched rule asks to keep the previous state.
    pub skip_state_update: bool,
    /// The screen visibly shows the agent waiting for a prompt / a question / a busy indicator
    /// (not just "no busy screen found").
    pub visible_idle: bool,
    pub visible_blocker: bool,
    pub visible_working: bool,
    /// Id of the matched rule (None = idle fallback).
    pub rule: Option<String>,
    /// The matched rule looks at the screen (not at the OSC title / progress).
    pub on_screen: bool,
}

/// What the rules look at: the visible rows of the terminal as plain text, plus the last OSC 0/2
/// window title and OSC 9 payload the program sent.
#[derive(Debug, Clone, Copy)]
pub struct Input<'a> {
    pub screen: &'a str,
    pub osc_title: &'a str,
    pub osc_progress: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    id: String,
    #[serde(rename = "version")]
    _version: Option<toml::Value>,
    min_engine_version: Option<u32>,
    #[serde(rename = "updated_at")]
    _updated_at: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    rules: Vec<RuleFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleFile {
    id: String,
    state: Option<State>,
    #[serde(default)]
    priority: i32,
    #[serde(default = "default_region")]
    region: String,
    #[serde(default)]
    visible_idle: bool,
    #[serde(default)]
    visible_blocker: bool,
    #[serde(default)]
    visible_working: bool,
    #[serde(default)]
    skip_state_update: bool,
    // The rule's own gate (serde's `flatten` can't be combined with `deny_unknown_fields`).
    #[serde(default)]
    all: Vec<GateFile>,
    #[serde(default)]
    any: Vec<GateFile>,
    #[serde(default, rename = "not")]
    not_gate: Vec<GateFile>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

impl RuleFile {
    fn take_gate(&mut self) -> GateFile {
        GateFile {
            all: std::mem::take(&mut self.all),
            any: std::mem::take(&mut self.any),
            not_gate: std::mem::take(&mut self.not_gate),
            contains: std::mem::take(&mut self.contains),
            regex: std::mem::take(&mut self.regex),
            line_regex: std::mem::take(&mut self.line_regex),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GateFile {
    #[serde(default)]
    all: Vec<GateFile>,
    #[serde(default)]
    any: Vec<GateFile>,
    #[serde(default, rename = "not")]
    not_gate: Vec<GateFile>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

impl GateFile {
    pub(super) fn new(
        all: Vec<GateFile>,
        any: Vec<GateFile>,
        not_gate: Vec<GateFile>,
        contains: Vec<String>,
        regex: Vec<String>,
        line_regex: Vec<String>,
    ) -> Self {
        Self {
            all,
            any,
            not_gate,
            contains,
            regex,
            line_regex,
        }
    }
}

fn default_region() -> String {
    "whole_recent".to_owned()
}

#[derive(Debug)]
pub(super) struct Gate {
    all: Vec<Gate>,
    any: Vec<Gate>,
    not_gate: Vec<Gate>,
    /// Lowercased needles.
    contains: Vec<String>,
    regex: Vec<Regex>,
    line_regex: Vec<Regex>,
}

/// Part of the screen a rule looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Region {
    WholeRecent,
    OscTitle,
    OscProgress,
    BottomLines(usize),
    BottomNonEmptyLines(usize),
    TopNonEmptyLines(usize),
    AfterLastPromptMarker,
    BeforeCurrentPromptMarker,
    WholeRecentWithoutCurrentPromptMarker,
    CurrentPromptBlockMarker,
    AfterCurrentPromptBlockMarker,
    PromptBoxBody,
    AbovePromptBox,
    LastNonEmptyAbovePromptBox,
    AfterLastHorizontalRule,
}

#[derive(Debug)]
struct Rule {
    id: String,
    state: State,
    priority: i32,
    region: Region,
    visible_idle: bool,
    visible_blocker: bool,
    visible_working: bool,
    skip_state_update: bool,
    gate: Gate,
}

/// A parsed and compiled manifest.
#[derive(Debug)]
pub struct Manifest {
    pub id: String,
    pub aliases: Vec<String>,
    rules: Vec<Rule>,
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let file: ManifestFile = toml::from_str(text).map_err(|error| error.to_string())?;
        if let Some(version) = file.min_engine_version {
            if version > ENGINE_VERSION {
                return Err(format!(
                    "needs detection engine {version} (this MetroTerm has {ENGINE_VERSION})"
                ));
            }
        }
        if file.id.trim().is_empty() {
            return Err("id is empty".into());
        }
        let rules = file
            .rules
            .into_iter()
            .map(|mut rule| {
                let region = Region::parse(&rule.region)
                    .ok_or_else(|| format!("rule {}: unknown region {:?}", rule.id, rule.region))?;
                let gate = Gate::compile(&rule.take_gate())
                    .map_err(|error| format!("rule {}: {error}", rule.id))?;
                Ok(Rule {
                    state: rule.state.unwrap_or(State::Unknown),
                    priority: rule.priority,
                    region,
                    visible_idle: rule.visible_idle,
                    visible_blocker: rule.visible_blocker,
                    visible_working: rule.visible_working,
                    skip_state_update: rule.skip_state_update,
                    gate,
                    id: rule.id,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self {
            id: file.id,
            aliases: file.aliases,
            rules,
        })
    }

    /// Evaluates every rule; the highest priority match decides (idle when nothing matches).
    pub fn detect(&self, input: Input<'_>) -> Detection {
        let mut best: Option<&Rule> = None;
        for rule in &self.rules {
            if !rule.gate.matches_region(rule.region.text(input)) {
                continue;
            }
            match best {
                Some(previous) if previous.priority >= rule.priority => {}
                _ => best = Some(rule),
            }
        }
        match best {
            None => Detection {
                state: State::Idle,
                skip_state_update: false,
                visible_idle: false,
                visible_blocker: false,
                visible_working: false,
                rule: None,
                on_screen: false,
            },
            Some(rule) => Detection {
                state: rule.state,
                skip_state_update: rule.skip_state_update,
                visible_idle: rule.visible_idle && rule.state == State::Idle,
                visible_blocker: rule.visible_blocker && rule.state == State::Blocked,
                visible_working: rule.visible_working && rule.state == State::Working,
                rule: Some(rule.id.clone()),
                on_screen: !matches!(rule.region, Region::OscTitle | Region::OscProgress),
            },
        }
    }
}

impl Gate {
    pub(super) fn compile(file: &GateFile) -> Result<Self, String> {
        let compile_all = |gates: &[GateFile]| {
            gates
                .iter()
                .map(Gate::compile)
                .collect::<Result<Vec<_>, _>>()
        };
        let regexes = |patterns: &[String]| {
            patterns
                .iter()
                .map(|pattern| Regex::new(pattern).map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()
        };
        let gate = Self {
            all: compile_all(&file.all)?,
            any: compile_all(&file.any)?,
            not_gate: compile_all(&file.not_gate)?,
            contains: file
                .contains
                .iter()
                .map(|needle| needle.to_lowercase())
                .collect(),
            regex: regexes(&file.regex)?,
            line_regex: regexes(&file.line_regex)?,
        };
        if gate.is_empty() {
            return Err("a gate without any matcher matches everything".into());
        }
        Ok(gate)
    }

    fn is_empty(&self) -> bool {
        self.contains.is_empty()
            && self.regex.is_empty()
            && self.line_regex.is_empty()
            && self.all.is_empty()
            && self.any.is_empty()
            && self.not_gate.is_empty()
    }

    pub(super) fn matches_region(&self, text: &str) -> bool {
        self.matches(text, &text.to_lowercase())
    }

    fn matches(&self, text: &str, lower: &str) -> bool {
        self.contains
            .iter()
            .all(|needle| lower.contains(needle.as_str()))
            && self.regex.iter().all(|regex| regex.is_match(text))
            && self
                .line_regex
                .iter()
                .all(|regex| text.lines().any(|line| regex.is_match(line)))
            && self.all.iter().all(|gate| gate.matches(text, lower))
            && (self.any.is_empty() || self.any.iter().any(|gate| gate.matches(text, lower)))
            && !self.not_gate.iter().any(|gate| gate.matches(text, lower))
    }
}

impl Region {
    pub(super) fn parse(spec: &str) -> Option<Self> {
        let spec = spec.trim();
        Some(match spec {
            "whole_recent" => Self::WholeRecent,
            "osc_title" => Self::OscTitle,
            "osc_progress" => Self::OscProgress,
            "after_last_prompt_marker" => Self::AfterLastPromptMarker,
            "before_current_prompt_marker" => Self::BeforeCurrentPromptMarker,
            "whole_recent_without_current_prompt_marker" => {
                Self::WholeRecentWithoutCurrentPromptMarker
            }
            "current_prompt_block_marker" => Self::CurrentPromptBlockMarker,
            "after_current_prompt_block_marker" => Self::AfterCurrentPromptBlockMarker,
            "prompt_box_body" => Self::PromptBoxBody,
            "above_prompt_box" => Self::AbovePromptBox,
            "last_non_empty_above_prompt_box" => Self::LastNonEmptyAbovePromptBox,
            "after_last_horizontal_rule" => Self::AfterLastHorizontalRule,
            _ => {
                // A canonical count: digits only, no leading zero, 1 ..= 65535.
                let count = |name: &str| {
                    let digits = spec
                        .strip_prefix(name)?
                        .strip_prefix('(')?
                        .strip_suffix(')')?;
                    if digits.starts_with('0') || !digits.bytes().all(|byte| byte.is_ascii_digit())
                    {
                        return None;
                    }
                    digits
                        .parse::<usize>()
                        .ok()
                        .filter(|count| (1..=u16::MAX as usize).contains(count))
                };
                if let Some(n) = count("bottom_lines") {
                    Self::BottomLines(n)
                } else if let Some(n) = count("bottom_non_empty_lines") {
                    Self::BottomNonEmptyLines(n)
                } else {
                    Self::TopNonEmptyLines(count("top_non_empty_lines")?)
                }
            }
        })
    }

    pub(super) fn text<'a>(self, input: Input<'a>) -> &'a str {
        let content = input.screen;
        match self {
            Self::OscTitle => input.osc_title,
            Self::OscProgress => input.osc_progress,
            Self::WholeRecent => content,
            Self::BottomLines(n) => bottom_lines(content, n),
            Self::BottomNonEmptyLines(n) => bottom_non_empty_lines(content, n),
            Self::TopNonEmptyLines(n) => top_non_empty_lines(content, n),
            Self::AfterLastPromptMarker => after_last_prompt_marker(content),
            Self::BeforeCurrentPromptMarker => before_current_prompt_marker(content),
            Self::WholeRecentWithoutCurrentPromptMarker => {
                let lines: Vec<&str> = content.lines().collect();
                if current_prompt_index(&lines).is_some() {
                    ""
                } else {
                    content
                }
            }
            Self::CurrentPromptBlockMarker => current_prompt_block_marker(content).unwrap_or(""),
            Self::AfterCurrentPromptBlockMarker => {
                after_current_prompt_block_marker(content).unwrap_or("")
            }
            Self::PromptBoxBody => prompt_box_body(content).unwrap_or(""),
            Self::AbovePromptBox => above_prompt_box(content),
            Self::LastNonEmptyAbovePromptBox => last_non_empty_line(above_prompt_box(content)),
            Self::AfterLastHorizontalRule => after_last_horizontal_rule(content),
        }
    }
}

fn bottom_lines(content: &str, count: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(count);
    slice_from_line(content, &lines, start)
}

fn bottom_non_empty_lines(content: &str, count: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let Some(start) = lines
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, line)| !line.trim().is_empty())
        .take(count)
        .last()
        .map(|(index, _)| index)
    else {
        return "";
    };
    slice_from_line(content, &lines, start)
}

fn top_non_empty_lines(content: &str, count: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let Some(end) = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .take(count)
        .last()
        .map(|(index, _)| index)
    else {
        return "";
    };
    &content[..line_start(content, &lines, end + 1)]
}

// Codex-style prompt: a line `›` / `› …`; answer blocks start with • ■ ✗ ✓.
fn prompt_line(line: &str) -> bool {
    line == "›" || line.starts_with("› ")
}

fn block_marker_line(line: &str) -> bool {
    line.starts_with(['•', '■', '✗', '✓'])
}

/// The last prompt line, unless an answer block follows it (then the prompt is not the current one).
fn current_prompt_index(lines: &[&str]) -> Option<usize> {
    let index = lines.iter().rposition(|line| prompt_line(line))?;
    (!lines[index + 1..]
        .iter()
        .any(|line| block_marker_line(line)))
    .then_some(index)
}

fn after_last_prompt_marker(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match lines.iter().rposition(|line| prompt_line(line)) {
        Some(index) => slice_from_line(content, &lines, index + 1),
        None => content,
    }
}

fn before_current_prompt_marker(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match current_prompt_index(&lines) {
        Some(index) => &content[..line_start(content, &lines, index)],
        None => content,
    }
}

fn current_prompt_block_marker(content: &str) -> Option<&str> {
    let lines: Vec<&str> = content.lines().collect();
    let prompt = current_prompt_index(&lines)?;
    lines[..prompt]
        .iter()
        .rev()
        .find(|line| block_marker_line(line))
        .copied()
}

fn after_current_prompt_block_marker(content: &str) -> Option<&str> {
    let lines: Vec<&str> = content.lines().collect();
    let prompt = current_prompt_index(&lines)?;
    let block = lines[..prompt]
        .iter()
        .rposition(|line| block_marker_line(line))?;
    Some(slice_from_line(content, &lines, block))
}

// Claude-style prompt box: the text between the second-to-last horizontal rule and the next one.
fn prompt_box_body(content: &str) -> Option<&str> {
    let lines: Vec<&str> = content.lines().collect();
    let top = prompt_box_top(&lines)?;
    let start = line_start(content, &lines, top + 1);
    let end_index = lines[top + 1..]
        .iter()
        .position(|line| horizontal_rule(line))
        .map(|relative| top + 1 + relative)
        .unwrap_or(lines.len());
    Some(&content[start..line_start(content, &lines, end_index).max(start)])
}

fn above_prompt_box(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    match prompt_box_top(&lines) {
        Some(top) => &content[..line_start(content, &lines, top)],
        None => content,
    }
}

fn after_last_horizontal_rule(content: &str) -> &str {
    let mut last_rule_end = 0;
    let mut offset = 0;
    for line in content.lines() {
        let next = offset + line.len() + 1;
        if horizontal_rule(line) {
            last_rule_end = next.min(content.len());
        }
        offset = next;
    }
    &content[last_rule_end..]
}

fn last_non_empty_line(content: &str) -> &str {
    content
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
}

fn prompt_box_top(lines: &[&str]) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, line)| horizontal_rule(line))
        .nth(1)
        .map(|(index, _)| index)
}

/// `────` (a run of U+2500), optionally followed by a label when the run is at least 3 long.
fn horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    let run = trimmed.chars().take_while(|&c| c == '─').count();
    if run == 0 {
        return false;
    }
    let suffix = trimmed[run * '─'.len_utf8()..].trim_start();
    suffix.is_empty() || run >= 3
}

fn slice_from_line<'a>(content: &'a str, lines: &[&str], index: usize) -> &'a str {
    &content[line_start(content, lines, index)..]
}

/// Byte offset of line `index` (lines split on `\n`; the screen text has no `\r`).
fn line_start(content: &str, lines: &[&str], index: usize) -> usize {
    lines[..index.min(lines.len())]
        .iter()
        .map(|line| line.len() + 1)
        .sum::<usize>()
        .min(content.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(screen: &str) -> Input<'_> {
        Input {
            screen,
            osc_title: "",
            osc_progress: "",
        }
    }

    #[test]
    fn gates() {
        let gate = |toml_text: &str| {
            let file: GateFile = toml::from_str(toml_text).unwrap();
            Gate::compile(&file).unwrap()
        };
        assert!(gate("contains = [\"ESC to interrupt\"]").matches_region("… esc to interrupt"));
        assert!(!gate("contains = [\"a\", \"zz\"]").matches_region("abc"));
        assert!(gate("line_regex = ['^x$']").matches_region("a\nx\nb"));
        assert!(!gate("regex = ['^x$']").matches_region("a\nx\nb"));
        let any = gate("any = [{ contains = [\"q\"] }, { contains = [\"b\"] }]");
        assert!(any.matches_region("abc"));
        let not = gate("contains = [\"a\"]\nnot = [{ contains = [\"c\"] }]");
        assert!(!not.matches_region("abc"));
        assert!(not.matches_region("ab"));
        assert!(Gate::compile(&GateFile::default()).is_err());
    }

    #[test]
    fn regions() {
        let screen = "one\n\ntwo\n───\n❯ hi\n───\n  ? for shortcuts";
        assert_eq!(bottom_non_empty_lines(screen, 2), "───\n  ? for shortcuts");
        assert_eq!(bottom_lines(screen, 1), "  ? for shortcuts");
        assert_eq!(top_non_empty_lines(screen, 2), "one\n\ntwo\n");
        assert_eq!(prompt_box_body(screen), Some("❯ hi\n"));
        assert_eq!(above_prompt_box(screen), "one\n\ntwo\n");
        assert_eq!(last_non_empty_line(above_prompt_box(screen)), "two");
        assert_eq!(after_last_horizontal_rule(screen), "  ? for shortcuts");
        assert!(horizontal_rule("─── label"));
        assert!(!horizontal_rule("── label"));
        let codex = "• done\n› next\n  ctx";
        assert_eq!(after_last_prompt_marker(codex), "  ctx");
        assert_eq!(before_current_prompt_marker(codex), "• done\n");
        assert_eq!(current_prompt_block_marker(codex), Some("• done"));
        let stale = "› old\n• answer";
        assert_eq!(before_current_prompt_marker(stale), stale);
    }

    #[test]
    fn priority_and_fallback() {
        let manifest = Manifest::parse(
            r#"
id = "t"
[[rules]]
id = "low"
state = "working"
priority = 10
contains = ["busy"]
[[rules]]
id = "high"
state = "blocked"
priority = 20
visible_blocker = true
contains = ["busy", "proceed?"]
[[rules]]
id = "title"
state = "idle"
priority = 5
region = "osc_title"
visible_idle = true
regex = ['\S']
"#,
        )
        .unwrap();
        let busy = manifest.detect(input("busy"));
        assert_eq!(
            (busy.state, busy.rule.as_deref()),
            (State::Working, Some("low"))
        );
        let ask = manifest.detect(input("busy · proceed?"));
        assert_eq!(ask.state, State::Blocked);
        assert!(ask.visible_blocker && ask.on_screen);
        let none = manifest.detect(input("nothing"));
        assert_eq!((none.state, none.rule), (State::Idle, None));
        let titled = manifest.detect(Input {
            screen: "",
            osc_title: "✳ Claude Code",
            osc_progress: "",
        });
        assert!(titled.visible_idle && !titled.on_screen);
    }

    // The next three pin down the manifest format's semantics.
    #[test]
    fn region_table() {
        for (screen, spec, expected) in [
            ("old\n\nnew\n", "bottom_lines(2)", "\nnew\n"),
            (
                "before\n› input\nafter\n",
                "after_last_prompt_marker",
                "after\n",
            ),
            (
                "before\n› input\nafter\n",
                "before_current_prompt_marker",
                "before\n",
            ),
            (
                "before\n› input\nafter\n",
                "whole_recent_without_current_prompt_marker",
                "",
            ),
            (
                "no marker\n",
                "whole_recent_without_current_prompt_marker",
                "no marker\n",
            ),
            (
                "• old\n■ latest\n› input\n",
                "current_prompt_block_marker",
                "■ latest",
            ),
            (
                "• old\n■ latest\n› input\n",
                "after_current_prompt_block_marker",
                "■ latest\n› input\n",
            ),
            ("› old\n• new\n", "current_prompt_block_marker", ""),
            (
                "above\n\n───\nbody\n───\nfooter\n",
                "above_prompt_box",
                "above\n\n",
            ),
            (
                "above\n\n───\nbody\n───\nfooter\n",
                "last_non_empty_above_prompt_box",
                "above",
            ),
            (
                "above\n───\nbody\n───\nfooter\n",
                "prompt_box_body",
                "body\n",
            ),
            (
                "above\n───\nbody\n───\nfooter\n",
                "after_last_horizontal_rule",
                "footer\n",
            ),
            (
                "marker\nold\n\nmiddle\nmarker\nnew\n",
                "bottom_non_empty_lines(2)",
                "marker\nnew\n",
            ),
            (
                "\nmarker\nold\n\nmiddle\nmarker\nnew\n",
                "top_non_empty_lines(2)",
                "\nmarker\nold\n",
            ),
        ] {
            assert_eq!(
                Region::parse(spec).unwrap().text(input(screen)),
                expected,
                "region={spec}"
            );
        }
        assert!(Region::parse("top_non_empty_lines(65535)").is_some());
        for count in ["0", "01", "+1", "65536", "999999999999999999999999"] {
            assert!(
                Region::parse(&format!("top_non_empty_lines({count})")).is_none(),
                "{count}"
            );
        }
    }

    #[test]
    fn rule_semantics() {
        let manifest = Manifest::parse(
            r#"
id = "codex"
[[rules]]
id = "low_contains"
state = "idle"
priority = 1
contains = ["match"]

[[rules]]
id = "high_nested_gates"
state = "working"
priority = 10
contains = ["match"]
all = [
  { any = [{ regex = ["w[io]n"] }, { contains = ["fallback"] }] },
]
not = [
  { contains = ["blocked"] },
]

[[rules]]
id = "line_regex"
state = "blocked"
priority = 20
line_regex = ["^exact line$"]
"#,
        )
        .unwrap();
        let rule = |screen: &str| manifest.detect(input(screen)).rule;
        assert_eq!(rule("match win").as_deref(), Some("high_nested_gates"));
        assert_eq!(rule("match win blocked").as_deref(), Some("low_contains"));
        assert_eq!(
            rule("before\nexact line\nafter").as_deref(),
            Some("line_regex")
        );
    }

    #[test]
    fn paired_alternatives() {
        let manifest = Manifest::parse(
            r#"
id = "codex"
[[rules]]
id = "paired"
state = "blocked"
region = "bottom_non_empty_lines(3)"
visible_blocker = true
any = [
  { all = [
    { contains = ["alpha heading"] },
    { regex = ['alpha\s+control\s*\z'] },
  ] },
  { all = [
    { contains = ["beta heading"] },
    { regex = ['beta\s+control\s*\z'] },
  ] },
]
"#,
        )
        .unwrap();
        for text in [
            "alpha heading\nalpha control",
            "beta heading\nbeta\ncontrol",
        ] {
            let result = manifest.detect(input(text));
            assert!(
                result.state == State::Blocked && result.visible_blocker,
                "{text}"
            );
        }
        for text in [
            "alpha heading\nbeta control",
            "beta heading\nalpha control",
            "beta control",
            "beta heading",
            "beta heading\nbeta control\nnewer content",
            "beta heading\nfiller one\nfiller two\nbeta control",
        ] {
            assert!(manifest.detect(input(text)).rule.is_none(), "{text}");
        }
    }

    #[test]
    fn rejects_bad_manifests() {
        assert!(Manifest::parse("id = \"x\"\nmin_engine_version = 99").is_err());
        assert!(Manifest::parse(
            "id = \"x\"\n[[rules]]\nid = \"r\"\nregion = \"nowhere\"\ncontains = [\"a\"]"
        )
        .is_err());
        assert!(Manifest::parse("id = \"x\"\nbogus = 1").is_err());
    }
}
