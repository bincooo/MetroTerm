use super::{catalog::*, watch::*, *};

#[test]
fn bundled_manifests_and_signatures_load() {
    for agent in AGENTS {
        let manifest = Manifest::parse(agent.manifest)
            .unwrap_or_else(|error| panic!("{}: {error}", agent.file));
        assert_eq!(manifest.id, agent.id, "{}", agent.file);
    }
    assert!(parse_signatures(IDENTIFY).unwrap().len() >= 4);
}

fn catalog_for_tests() -> Catalog {
    Catalog {
        manifests: AGENTS
            .iter()
            .map(|agent| Manifest::parse(agent.manifest).ok())
            .collect(),
        signatures: parse_signatures(IDENTIFY).unwrap(),
    }
}

fn index(id: &str) -> usize {
    AGENTS.iter().position(|agent| agent.id == id).unwrap()
}

/// Writes a whole screen (clear + rows) like a TUI redraw.
fn draw(watch: &mut Watch, rows: &[&str]) {
    let mut out = String::from("\x1b[H\x1b[2J");
    out.push_str(&rows.join("\r\n"));
    watch.feed(out.as_bytes());
}

const CLAUDE_IDLE: &[&str] = &[
    "⏺ Done. The tests pass.",
    "",
    "────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────",
    "  ? for shortcuts",
];
const CLAUDE_WORKING: &[&str] = &[
    "⏺ Reading files",
    "",
    "✻ Thinking… (12s · esc to interrupt)",
    "",
    "────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt",
];
const CLAUDE_ASK: &[&str] = &[
    "⏺ Bash(rm -rf build)",
    "────────────────────────────────────────",
    " Bash command",
    "   rm -rf build",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for rm commands",
    "   3. No, and tell Claude what to do differently (esc)",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain",
];

#[test]
fn claude_on_screen() {
    let catalog = catalog_for_tests();
    let claude = index("claude");
    let mut watch = Watch::new(80, 24);
    let t0 = Instant::now();
    let at = |ms: u64| t0 + Duration::from_millis(ms);

    draw(&mut watch, &["$ ls", "a b c", "$ "]);
    assert_eq!(watch.tick(at(0), false, &catalog), None);

    draw(&mut watch, CLAUDE_WORKING);
    assert_eq!(
        watch.tick(at(100), false, &catalog),
        Some((Some(claude), Shown::Working))
    );

    draw(&mut watch, CLAUDE_ASK);
    assert_eq!(
        watch.tick(at(200), false, &catalog),
        Some((Some(claude), Shown::Blocked))
    );

    draw(&mut watch, CLAUDE_WORKING);
    assert_eq!(
        watch.tick(at(300), false, &catalog),
        Some((Some(claude), Shown::Working))
    );

    // The prompt box is a visible idle: no confirmation wait. Not viewed → done.
    draw(&mut watch, CLAUDE_IDLE);
    assert_eq!(
        watch.tick(at(400), false, &catalog),
        Some((Some(claude), Shown::Done))
    );
    // Viewing it makes it idle.
    assert_eq!(
        watch.tick(at(500), true, &catalog),
        Some((Some(claude), Shown::Idle))
    );

    // Claude quits: the shell prompt alone. Gone after the grace period.
    draw(
        &mut watch,
        &["Resume this session with: claude --resume 1234", "$ "],
    );
    assert_eq!(watch.tick(at(600), true, &catalog), None);
    assert_eq!(watch.tick(at(2000), true, &catalog), None);
    assert_eq!(
        watch.tick(at(3700), true, &catalog),
        Some((None, Shown::Idle))
    );
}

#[test]
fn plain_idle_waits_for_confirmations() {
    let catalog = catalog_for_tests();
    let claude = index("claude");
    let mut watch = Watch::new(80, 24);
    watch.foreground = Some(Foreground::Agent(claude));
    let t0 = Instant::now();
    let at = |ms: u64| t0 + Duration::from_millis(ms);
    draw(&mut watch, CLAUDE_WORKING);
    assert_eq!(
        watch.tick(at(0), true, &catalog),
        Some((Some(claude), Shown::Working))
    );
    // No spinner and no prompt box for a moment (between two steps): still working …
    draw(&mut watch, &["⏺ Reading files", ""]);
    assert_eq!(watch.tick(at(100), true, &catalog), None);
    draw(&mut watch, CLAUDE_WORKING);
    assert_eq!(watch.tick(at(200), true, &catalog), None);
    // … and idle after three looks in a row.
    draw(&mut watch, &["⏺ Reading files", ""]);
    assert_eq!(watch.tick(at(300), true, &catalog), None);
    assert_eq!(watch.tick(at(400), true, &catalog), None);
    assert_eq!(
        watch.tick(at(500), true, &catalog),
        Some((Some(claude), Shown::Idle))
    );
}

/// State from the window title / progress alone (agents without useful screen rules).
#[test]
fn state_from_osc() {
    let catalog = catalog_for_tests();
    let cases: &[(&str, &str, Shown)] = &[
        (
            "amp",
            "\x1b]0;⠋ Fix the build - amp - ~/app\x07",
            Shown::Working,
        ),
        (
            "amp",
            "\x1b]0;Plugin confirmation needed - amp - ~/app\x07",
            Shown::Blocked,
        ),
        ("amp", "\x1b]0;Fix the build - amp - ~/app\x07", Shown::Idle),
        ("grok", "\x1b]0;⠙ Review PR - grok\x07", Shown::Working),
        ("grok", "\x1b]0;Action Required - grok\x07", Shown::Blocked),
        ("grok", "\x1b]9;4;1;-1\x07", Shown::Working),
        ("grok", "\x1b]0;Review PR - grok\x07", Shown::Idle),
        ("hermes", "\x1b]0;⏳ refactor\x07", Shown::Working),
        ("hermes", "\x1b]0;⚠ refactor\x07", Shown::Blocked),
        ("hermes", "\x1b]0;✓ refactor\x07", Shown::Idle),
        ("kiro", "\x1b]0;◐ kiro: refactor\x07", Shown::Working),
        ("kiro", "\x1b]9;4;3;\x07", Shown::Working),
    ];
    for (agent, osc, expected) in cases {
        let id = index(agent);
        let mut watch = Watch::new(100, 24);
        watch.foreground = Some(Foreground::Agent(id));
        watch.feed(osc.as_bytes());
        draw(&mut watch, &["", "> "]);
        let t0 = Instant::now();
        let mut shown = None;
        for step in 0..6 {
            if let Some((_, state)) =
                watch.tick(t0 + Duration::from_millis(step * 100), true, &catalog)
            {
                shown = Some(state);
            }
        }
        assert_eq!(shown, Some(*expected), "{agent} {osc:?}");
    }
}

#[test]
fn osc_title_and_progress() {
    let mut watch = Watch::new(80, 24);
    watch.feed(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07\x1b]9;4;0;\x07");
    assert_eq!(watch.parser.callbacks().title, "✳ Claude Code");
    assert_eq!(watch.parser.callbacks().progress, "4;0;");
    watch.set_agent(Some(index("claude")), false);
    watch.set_agent(None, false);
    assert_eq!(watch.parser.callbacks().title, "");
    // Titles with `;` in them are kept whole (OSC 0 and 2, BEL and ST).
    watch.feed(b"\x1b]0;\xe2\xa0\x8b kiro: build; test\x07");
    assert_eq!(watch.parser.callbacks().title, "⠋ kiro: build; test");
    watch.feed(b"\x1b]2;a;b;c\x1b\\");
    assert_eq!(watch.parser.callbacks().title, "a;b;c");
    // An empty title clears it; OSC 1 (icon name only) does not touch it.
    watch.feed(b"\x1b]1;icon\x07");
    assert_eq!(watch.parser.callbacks().title, "a;b;c");
    watch.feed(b"\x1b]0;\x07");
    assert_eq!(watch.parser.callbacks().title, "");
    watch.feed(b"\x1b]9;4;1;-1\x07");
    assert_eq!(watch.parser.callbacks().progress, "4;1;-1");
}

/// First agent the screen names (a fresh terminal each time).
fn named_by(rows: &[&str], osc: &[u8]) -> Option<&'static str> {
    let catalog = catalog_for_tests();
    let mut watch = Watch::new(100, 24);
    watch.feed(osc);
    draw(&mut watch, rows);
    watch.tick(Instant::now(), true, &catalog);
    watch.agent.map(|agent| AGENTS[agent].id)
}

#[test]
fn self_naming_signatures() {
    let shell = &["$ make", "ok", "$ "][..];
    assert_eq!(
        named_by(
            &[
                "  Editing src/main.rs",
                "",
                "❭ ",
                "  guide devin while it works · esc to interrupt"
            ],
            b""
        ),
        Some("devin")
    );
    assert_eq!(
        named_by(
            &[
                "",
                "❭ Ask Devin to build features, fix bugs, or explain your code"
            ],
            b""
        ),
        Some("devin")
    );
    assert_eq!(
        named_by(
            &[
                "> refactor",
                "",
                "kiro is working · type to steer · ctrl+s to queue"
            ],
            b""
        ),
        Some("kiro")
    );
    assert_eq!(
        named_by(shell, "\x1b]0;◐ kiro: refactor; test\x07".as_bytes()),
        Some("kiro")
    );
    assert_eq!(
        named_by(shell, b"\x1b]0;Fix the build - amp - ~/src/app\x07"),
        Some("amp")
    );
    assert_eq!(named_by(shell, b"\x1b]2;grok\x07"), Some("grok"));
    assert_eq!(
        named_by(shell, b"\x1b]2;Review PR - grok\x07"),
        Some("grok")
    );
    // Shell / editor titles that merely mention the names.
    assert_eq!(named_by(shell, b"\x1b]0;user@host: ~/src/grok\x07"), None);
    assert_eq!(named_by(shell, b"\x1b]0;vim - amp.txt\x07"), None);
    assert_eq!(
        named_by(shell, b"\x1b]0;user@host: ~/kiro: notes\x07"),
        None
    );
    assert_eq!(named_by(&["$ grep -r 'guide devin' docs", "$ "], b""), None);

    // Amp quits; the shell's prompt sets its own title: gone after the grace period.
    let catalog = catalog_for_tests();
    let amp = index("amp");
    let mut watch = Watch::new(100, 24);
    let t0 = Instant::now();
    let at = |ms: u64| t0 + Duration::from_millis(ms);
    watch.feed(b"\x1b]0;Fix the build - amp - ~/src/app\x07");
    draw(&mut watch, &["  ┃ fix the build", "", "  ? for help"]);
    assert_eq!(
        watch.tick(at(0), true, &catalog).map(|shown| shown.0),
        Some(Some(amp))
    );
    watch.feed(b"\x1b]0;user@host: ~/src/app\x07");
    draw(&mut watch, shell);
    assert_eq!(watch.tick(at(100), true, &catalog), None);
    assert_eq!(
        watch.tick(at(3200), true, &catalog),
        Some((None, Shown::Idle))
    );
}

#[test]
fn codex_and_opencode_signatures() {
    let catalog = catalog_for_tests();
    let mut watch = Watch::new(80, 24);
    draw(
        &mut watch,
        &[
            "• Ran cargo test",
            "",
            "› Explain this codebase",
            "",
            "  100% context left · ? for shortcuts",
        ],
    );
    assert_eq!(
        watch
            .tick(Instant::now(), true, &catalog)
            .map(|shown| shown.0),
        Some(Some(index("codex")))
    );

    let mut watch = Watch::new(80, 24);
    watch.feed(b"\x1b[?1049h");
    draw(
        &mut watch,
        &["  opencode", "", "> ", "", "  ctrl+p commands   tab agents"],
    );
    let shown = watch.tick(Instant::now(), true, &catalog);
    assert_eq!(shown.map(|shown| shown.0), Some(Some(index("opencode"))));
    // Leaving the full-screen app ends it at once.
    watch.feed(b"\x1b[?1049l");
    assert_eq!(
        watch.tick(Instant::now(), true, &catalog),
        Some((None, Shown::Idle))
    );
}

#[test]
fn no_agent_at_a_local_shell_prompt() {
    let catalog = catalog_for_tests();
    let mut watch = Watch::new(80, 24);
    watch.foreground = Some(Foreground::Shell);
    draw(&mut watch, CLAUDE_IDLE);
    assert_eq!(watch.tick(Instant::now(), true, &catalog), None);
    watch.foreground = Some(Foreground::Agent(index("codex")));
    watch.dirty = true;
    assert_eq!(
        watch.tick(Instant::now(), true, &catalog),
        Some((Some(index("codex")), Shown::Idle))
    );
}
