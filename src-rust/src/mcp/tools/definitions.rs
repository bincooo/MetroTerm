//! Tool definitions: names, descriptions and input schemas (`tools/list`).

use super::*;

// ---------- definitions ----------

pub(super) fn tool(
    name: &str,
    title: &str,
    description: &str,
    schema: Value,
    read_only: bool,
) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": schema,
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "openWorldHint": false,
        },
    })
}

pub(super) fn terminal_param() -> Value {
    json!({ "type": "string", "description": "Terminal id from list_terminals" })
}

pub(super) fn window_param() -> Value {
    json!({ "type": "string", "description": "Window id from list_windows (win-1 …)" })
}

pub(super) fn pane_param() -> Value {
    json!({ "type": "string", "description": "Pane id from list_windows (win-1:p-2 …)" })
}

pub(super) fn side_param(description: &str) -> Value {
    json!({ "type": "string", "enum": ["right", "down", "left", "up"], "default": "right", "description": description })
}

/// A tool that closes things (`destructiveHint`).
pub(super) fn destructive(mut tool: Value) -> Value {
    tool["annotations"]["destructiveHint"] = json!(true);
    tool
}

pub(super) fn timeout_param(default_ms: u64) -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": MAX_WAIT_MS,
            "description": format!("Give up after this many milliseconds (default {default_ms})") })
}

pub fn definitions(allow_input: bool) -> Vec<Value> {
    let mut list = vec![
        tool(
            "list_terminals",
            "List terminals",
            "MetroTerm's terminal tabs (as in its Session panel): id, `tab_name` (the name on its tab), session name, \
             transport (local / ssh / telnet / tcp / serial), host, window title, `window` / `pane` (see list_windows), \
             the agent CLI running in it with its state (working, blocked, done, idle, unknown — read from the screen), \
             whether the user is looking at it, and `self` for the terminal you run in. Tabs whose session has ended \
             (disconnected) are listed with `connected: false`; reconnect_terminal starts them again.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            true,
        ),
        tool(
            "read_terminal",
            "Read terminal",
            "Text of a terminal: `visible` = the screen as shown; `recent` (default) = the last `lines` lines including output \
             that scrolled off (full-screen programs: their screen).",
            json!({
                "type": "object",
                "properties": {
                    "terminal": terminal_param(),
                    "source": { "type": "string", "enum": ["recent", "visible"], "default": "recent" },
                    "lines": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 120 },
                },
                "required": ["terminal"],
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "wait_for_output",
            "Wait for output",
            "Wait until a terminal's text contains `match` (literal) or matches `regex` (Rust syntax); text already there \
             matches at once. Returns the matching line.",
            json!({
                "type": "object",
                "properties": {
                    "terminal": terminal_param(),
                    "match": { "type": "string" },
                    "regex": { "type": "string" },
                    "source": { "type": "string", "enum": ["recent", "visible"], "default": "recent" },
                    "lines": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 200 },
                    "timeout_ms": timeout_param(60_000),
                },
                "required": ["terminal"],
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "agent_wait",
            "Wait for an agent",
            "Wait until the agent CLI in a terminal reaches one of the `until` states (default: settled = idle, done or blocked). \
             Fails with agent_not_running when the agent quits.",
            json!({
                "type": "object",
                "properties": {
                    "terminal": terminal_param(),
                    "until": { "type": "array", "items": { "type": "string", "enum": STATES } },
                    "timeout_ms": timeout_param(600_000),
                },
                "required": ["terminal"],
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "focus_terminal",
            "Show terminal",
            "Bring a terminal's tab to the front in MetroTerm: its window is shown, its pane focused \
             (only when the user asked to see it).",
            json!({
                "type": "object",
                "properties": { "terminal": terminal_param() },
                "required": ["terminal"],
                "additionalProperties": false,
            }),
            false,
        ),
        tool(
            "list_windows",
            "List windows and panes",
            "MetroTerm's windows (workspaces switched like tabs; `shown` = the one on screen) and how each splits its \
             terminal area into panes: `layout` is the split tree (left_right / top_bottom with the first side's \
             `ratio`), `panes` lists every pane (id, letter A, B … as shown in its tab bar, `focused`) with its tabs \
             (terminal id — null while it is still connecting — name, `shown`). `zoomed`: only the focused pane is \
             shown.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            true,
        ),
        tool(
            "focus_window",
            "Show window",
            "Show a MetroTerm window (only when the user asked to see it).",
            json!({
                "type": "object",
                "properties": { "window": window_param() },
                "required": ["window"],
                "additionalProperties": false,
            }),
            false,
        ),
    ];
    if allow_input {
        list.extend([
            tool(
                "agent_prompt",
                "Prompt an agent",
                "Submit a prompt to the agent CLI in another terminal (text, then Enter) and by default wait until it settles \
                 (idle, done or blocked). Refused when no agent is recognised there, when it is blocked on a question \
                 (read it and ask the user), or for your own terminal. Then use read_terminal for the answer.",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "text": { "type": "string", "minLength": 1 },
                        "wait": { "type": "boolean", "default": true },
                        "timeout_ms": timeout_param(600_000),
                    },
                    "required": ["terminal", "text"],
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "send_text",
                "Type text",
                "Type text into a terminal as if pasted (bracketed paste when the program enabled it); enter=true presses \
                 Enter after it, e.g. to run a shell command. Not into your own terminal.",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "text": { "type": "string" },
                        "enter": { "type": "boolean", "default": false },
                    },
                    "required": ["terminal", "text"],
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "send_keys",
                "Press keys",
                "Press keys in a terminal, in order: enter, esc, tab, shift+tab, backspace, delete, up, down, left, right, \
                 home, end, pageup, pagedown, space, f1…f12, a single character, with ctrl+ / alt+ / shift+ \
                 (ctrl+c, alt+b). All are checked before any is sent. Not into your own terminal.",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "keys": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 64 },
                    },
                    "required": ["terminal", "keys"],
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "open_terminal",
                "Open terminal",
                "Open a saved MetroTerm session (by name or id; default: the first local shell) in a new tab, in the \
                 background unless focus=true, wait until its shell has started, and optionally type `command` + Enter. \
                 With `terminal` it clones that tab: same saved session (unless `session` is given), in its pane. \
                 Returns the new terminal id.",
                json!({
                    "type": "object",
                    "properties": {
                        "session": { "type": "string", "description": "Saved session name or id" },
                        "terminal": { "type": "string", "description": "Clone this terminal's tab (terminal id)" },
                        "window": window_param(),
                        "pane": pane_param(),
                        "command": { "type": "string" },
                        "focus": { "type": "boolean", "default": false },
                        "timeout_ms": timeout_param(60_000),
                    },
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "split_pane",
                "Split pane",
                "Split a pane (the one holding `terminal`, or `pane`; default: the focused pane of the shown window) in two, \
                 like tmux split-window: the new pane goes on the `direction` side and gets a new terminal of `session` \
                 (default: the same session as the split pane's terminal). Waits until its shell has started, optionally \
                 types `command` + Enter, and returns the new terminal and pane. Not focused unless focus=true.",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "pane": pane_param(),
                        "direction": side_param("Side of the new pane"),
                        "session": { "type": "string", "description": "Saved session name or id" },
                        "command": { "type": "string" },
                        "focus": { "type": "boolean", "default": false },
                        "timeout_ms": timeout_param(60_000),
                    },
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "resize_pane",
                "Resize pane",
                "Move the border of a pane (or of the pane holding `terminal`) toward `direction`, by `amount` of the split's \
                 size (default 0.1), like tmux resize-pane -L / -R / -U / -D.",
                json!({
                    "type": "object",
                    "properties": {
                        "pane": pane_param(),
                        "terminal": terminal_param(),
                        "direction": { "type": "string", "enum": ["left", "right", "up", "down"] },
                        "amount": { "type": "number", "minimum": 0.01, "maximum": 0.8, "default": 0.1 },
                    },
                    "required": ["direction"],
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "zoom_pane",
                "Zoom pane",
                "zoom=true: the window shows only this pane (it is focused), like tmux zoom; zoom=false: all panes again.",
                json!({
                    "type": "object",
                    "properties": {
                        "pane": pane_param(),
                        "terminal": terminal_param(),
                        "zoom": { "type": "boolean", "default": true },
                    },
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "move_terminal",
                "Move terminal",
                "Move a terminal's tab, with its running session, into another pane (`pane`) or window (`window`: its focused \
                 pane), or reorder it: with `before` it goes right before that tab (in that tab's pane; the order of the \
                 Session panel and the tab bar), with `last` to the end of its target pane. With `split` it goes into a new \
                 pane on that side of the target pane (the pane it is in when only `split` is given). Moved to another pane, \
                 it becomes the shown tab there; reordered within its pane, what the pane shows stays.",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "before": { "type": "string", "description": "Put it right before this terminal's tab" },
                        "last": { "type": "boolean", "description": "Put it at the end of the target pane's tabs" },
                        "pane": pane_param(),
                        "window": window_param(),
                        "split": side_param("Into a new pane on this side of the target pane"),
                    },
                    "required": ["terminal"],
                    "additionalProperties": false,
                }),
                false,
            ),
            destructive(tool(
                "close_terminal",
                "Close terminal",
                "Close terminal tabs (`terminal`, or several in `terminals` — asked about once): their shells or connections \
                 end. Tabs an agent opened close at once; for the user's own ones MetroTerm asks the user, and the call \
                 fails with `cancelled` when they say no. Not your own terminal.",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "terminals": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Terminal ids" },
                    },
                    "additionalProperties": false,
                }),
                false,
            )),
            tool(
                "rename_terminal",
                "Rename terminal",
                "Give a terminal's tab another name (shown on its tab and in the Session panel; at most 80 characters); \
                 no / empty `name` gives it back its default name (the session's).",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "name": { "type": "string", "maxLength": 80 },
                    },
                    "required": ["terminal"],
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "reconnect_terminal",
                "Reconnect terminal",
                "Start a tab's session again (Reconnect in its menu): a new shell / connection in the same tab — a running \
                 one ends first. Waits until it has started, optionally types `command` + Enter, and returns its terminal id \
                 (it changes with each start). Not your own terminal.",
                json!({
                    "type": "object",
                    "properties": {
                        "terminal": terminal_param(),
                        "command": { "type": "string" },
                        "timeout_ms": timeout_param(60_000),
                    },
                    "required": ["terminal"],
                    "additionalProperties": false,
                }),
                false,
            ),
            destructive(tool(
                "disconnect_terminal",
                "Disconnect terminal",
                "End a tab's shell or connection but keep the tab (Disconnect in its menu; reconnect_terminal starts it again). \
                 Asks the user unless an agent opened it; not your own terminal.",
                json!({
                    "type": "object",
                    "properties": { "terminal": terminal_param() },
                    "required": ["terminal"],
                    "additionalProperties": false,
                }),
                false,
            )),
            destructive(tool(
                "close_pane",
                "Close pane",
                "Close a pane (or the pane holding `terminal`) with all its tabs, like tmux kill-pane. Asks the user unless an \
                 agent opened all of its terminals; not the pane you run in.",
                json!({
                    "type": "object",
                    "properties": { "pane": pane_param(), "terminal": terminal_param() },
                    "additionalProperties": false,
                }),
                false,
            )),
            tool(
                "new_window",
                "New window",
                "Open a new MetroTerm window with one terminal of `session` (default: the first local shell); shown only \
                 when focus=true. Waits until its shell has started, optionally types `command` + Enter.",
                json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "maxLength": 40 },
                        "session": { "type": "string", "description": "Saved session name or id" },
                        "command": { "type": "string" },
                        "focus": { "type": "boolean", "default": false },
                        "timeout_ms": timeout_param(60_000),
                    },
                    "additionalProperties": false,
                }),
                false,
            ),
            tool(
                "rename_window",
                "Rename window",
                "Give a window another name (at most 40 characters).",
                json!({
                    "type": "object",
                    "properties": { "window": window_param(), "name": { "type": "string", "minLength": 1, "maxLength": 40 } },
                    "required": ["window", "name"],
                    "additionalProperties": false,
                }),
                false,
            ),
            destructive(tool(
                "close_window",
                "Close window",
                "Close a window with all its tabs (not the last window). Asks the user unless an agent opened all of its \
                 terminals; not the window you run in.",
                json!({
                    "type": "object",
                    "properties": { "window": window_param() },
                    "required": ["window"],
                    "additionalProperties": false,
                }),
                false,
            )),
        ]);
    }
    list
}
