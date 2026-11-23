use super::{definitions::*, terminals::*, ui::*, *};

#[test]
fn helpers() {
    assert_eq!(tab_number("tab-12#3"), 12);
    assert_eq!(tab_number("other"), u64::MAX);
    assert_eq!(paste_bytes("ls", false), b"ls");
    assert_eq!(paste_bytes("a\x1b[201~b", true), b"\x1b[200~ab\x1b[201~");
    let names: Vec<String> = definitions(false)
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(!names
        .iter()
        .any(|name| name == "send_text" || name == "agent_prompt"));
    assert_eq!(definitions(true).len(), names.len() + 16);
    assert!(names.iter().any(|name| name == "list_windows"));
}

#[test]
fn ui_ids() {
    let sessions = vec!["tab-1#2".to_owned(), "tab-4#1".to_owned()];
    let reply = json!({
        "windows": [{
            "window": "win-1",
            "focused_pane": "win-1:p-2",
            "layout": { "split": "left_right", "first": { "pane": "win-1:p-1" }, "second": { "pane": "win-1:p-2" } },
            "panes": [{ "pane": "win-1:p-1", "tabs": [{ "terminal": "tab-1", "name": "a" }, { "terminal": "tab-9" }] }],
        }],
    });
    let first = globalize(reply.clone(), 1, &sessions, Some("tab-4#1"));
    assert_eq!(first["windows"][0]["window"], "win-1");
    assert_eq!(
        first["windows"][0]["panes"][0]["tabs"][0]["terminal"],
        "tab-1#2"
    );
    assert_eq!(
        first["windows"][0]["panes"][0]["tabs"][1]["terminal"],
        "tab-9"
    );
    assert_eq!(
        first["windows"][0]["panes"][0]["tabs"][1]["connected"],
        false
    );
    assert!(first["windows"][0]["panes"][0]["tabs"][0]
        .get("connected")
        .is_none());
    assert!(first["windows"][0]["panes"][0]["tabs"][0]
        .get("self")
        .is_none());
    let second = globalize(reply, 2, &sessions, Some("2/tab-1#2"));
    assert_eq!(second["windows"][0]["focused_pane"], "2/win-1:p-2");
    assert_eq!(
        second["windows"][0]["layout"]["second"]["pane"],
        "2/win-1:p-2"
    );
    assert_eq!(
        second["windows"][0]["panes"][0]["tabs"][0]["terminal"],
        "2/tab-1#2"
    );
    assert_eq!(second["windows"][0]["panes"][0]["tabs"][0]["self"], true);
    assert_eq!(tab_of("tab-3#2"), "tab-3");
    let sessions = vec![
        "tab-3#1".to_owned(),
        "tab-3#10".to_owned(),
        "tab-30#4".to_owned(),
    ];
    assert_eq!(current_session(&sessions, "tab-3"), Some("tab-3#10"));
    assert_eq!(current_session(&sessions, "tab-30"), Some("tab-30#4"));
    assert_eq!(current_session(&sessions, "tab-4"), None);
    assert_eq!(tab_ref("2/tab-5#3"), (2, "tab-5".to_owned()));
    assert_eq!(tab_ref("tab-5"), (1, "tab-5".to_owned()));
    assert_eq!(ui_code("cancelled"), "cancelled");
    assert_eq!(ui_code("weird"), "ui_failed");
}
