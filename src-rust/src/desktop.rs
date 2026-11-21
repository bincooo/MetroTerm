//! Tauri desktop shell: exposes the backend as a single `rpc` command plus config commands,
//! and forwards backend events as the `backend-event` window event.

use crate::{
    backend::Backend,
    config,
    events::{Event, EventSink},
};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: Event) {
        let _ = self.0.emit("backend-event", event);
    }
}

#[tauri::command]
async fn rpc(
    backend: State<'_, Arc<Backend>>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let backend = backend.inner().clone();
    backend.dispatch(&method, params).await
}

/// Absolute path of the config directory (shown in the UI).
#[tauri::command]
fn config_dir_path() -> Result<String, String> {
    Ok(config::config_dir()?.display().to_string())
}

#[tauri::command]
fn load_config(name: String) -> Result<Option<String>, String> {
    config::load(&name)
}

#[tauri::command]
fn save_config(name: String, content: String) -> Result<(), String> {
    config::save(&name, &content)
}

/// Session → Close Window (Ctrl+Shift+Q).
#[tauri::command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// Session → Exit (Alt+F4): ends the app; terminals and connections are closed on `RunEvent::Exit`.
#[tauri::command]
fn exit_app(app: AppHandle) {
    save_window_state();
    app.exit(0);
}

// ---------- window size (sessions.json → window; the maximized state is not kept) ----------

/// Last size of the window while it was neither maximized nor minimized (logical px), so that
/// closing a maximized window still remembers the size to restore to.
static NORMAL_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

fn remember_normal_size(window: &tauri::Window) {
    if window.is_maximized().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
        let size = size.to_logical::<f64>(scale);
        if size.width >= 200.0 && size.height >= 150.0 {
            *NORMAL_SIZE.lock().unwrap() = Some((size.width, size.height));
        }
    }
}

/// Save the window size (the normal, not maximized size) into sessions.json → `window`.
fn save_window_state() {
    let Some((width, height)) = *NORMAL_SIZE.lock().unwrap() else {
        return;
    };
    if let Err(error) = config::set_sessions_key(
        "window",
        serde_json::json!({ "width": width.round(), "height": height.round() }),
    ) {
        eprintln!("MetroTerm: {error}");
    }
}

/// `(width, height)` from the last session (sessions.json → `window`).
fn saved_window_size() -> Option<(f64, f64)> {
    let doc = config::sessions_key("window")?;
    let width = doc.get("width")?.as_f64()?;
    let height = doc.get("height")?.as_f64()?;
    if !(200.0..=20000.0).contains(&width) || !(150.0..=20000.0).contains(&height) {
        return None;
    }
    Some((width, height))
}

// ---------- window frame (custom title bar buttons, Settings → Title bar) ----------

#[tauri::command]
fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

/// Maximize ⇄ restore; returns whether the window is maximized afterwards. macOS: the green-button
/// behaviour instead — the window's own full-screen Space ⇄ window (`toggleFullScreen:`), not a
/// window stretched over the desktop.
#[tauri::command]
fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
        window
            .set_fullscreen(!fullscreen)
            .map_err(|error| error.to_string())?;
        Ok(!fullscreen)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let maximized = window.is_maximized().map_err(|error| error.to_string())?;
        if maximized {
            window.unmaximize()
        } else {
            window.maximize()
        }
        .map_err(|error| error.to_string())?;
        Ok(!maximized)
    }
}

/// macOS: whether the window is in full screen (what its maximize button toggles there).
#[tauri::command]
fn window_is_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    let state = window.is_fullscreen();
    #[cfg(not(target_os = "macos"))]
    let state = window.is_maximized();
    state.map_err(|error| error.to_string())
}

/// Frameless title bar: move the window while the mouse button is held.
#[tauri::command]
fn window_start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

/// Native title bar text (the same text as the app's own title bar: active tab — user@host).
#[tauri::command]
fn window_set_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|error| error.to_string())
}

/// Settings → Title bar: native window decorations or the app's frameless title bar, never both.
#[tauri::command]
fn window_set_native_frame(window: tauri::WebviewWindow, native: bool) -> Result<(), String> {
    apply_frame(&window, native)
}

/// Whether the window shows the system title bar (Settings → Title bar, Focus Mode's frame).
static NATIVE_FRAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// System title bar on or off.
///
/// Windows / Linux: window decorations on or off. macOS keeps a titled window either way: a window
/// without decorations is borderless, and AppKit neither minimizes (no miniaturizable style) nor
/// puts into a full-screen Space a borderless window. Frameless there is a transparent title bar
/// with the content underneath (`TitleBarStyle::Overlay`), no title text and no traffic lights —
/// the app's own title bar is the only one visible.
fn apply_frame(window: &tauri::WebviewWindow, native: bool) -> Result<(), String> {
    NATIVE_FRAME.store(native, std::sync::atomic::Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let err = |error: tauri::Error| error.to_string();
        window.set_decorations(true).map_err(err)?;
        window
            .set_title_bar_style(if native {
                tauri::TitleBarStyle::Visible
            } else {
                tauri::TitleBarStyle::Overlay
            })
            .map_err(err)?;
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(ns_window) = target.ns_window() {
                    set_mac_title_bar_parts(ns_window, native);
                }
            })
            .map_err(err)?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    window
        .set_decorations(native)
        .map_err(|error| error.to_string())
}

/// macOS: title text and the close / minimize / zoom buttons shown (system title bar) or hidden
/// (frameless). Main thread only.
#[cfg(target_os = "macos")]
fn set_mac_title_bar_parts(ns_window: *mut std::ffi::c_void, visible: bool) {
    use objc2::{msg_send, runtime::AnyObject};
    if ns_window.is_null() {
        return;
    }
    // SAFETY: ns_window is this app's live NSWindow; called on the main thread.
    unsafe {
        let ns_window = &*(ns_window as *const AnyObject);
        // NSWindowTitleVisible = 0, NSWindowTitleHidden = 1
        let _: () = msg_send![ns_window, setTitleVisibility: if visible { 0isize } else { 1isize }];
        // NSWindowCloseButton = 0, NSWindowMiniaturizeButton = 1, NSWindowZoomButton = 2
        for kind in 0usize..3 {
            let button: *mut AnyObject = msg_send![ns_window, standardWindowButton: kind];
            if !button.is_null() {
                let _: () = msg_send![&*button, setHidden: !visible];
            }
        }
    }
}

/// macOS: AppKit lays the title bar out again after a resize or a full-screen change and can bring
/// the traffic lights back; hide them again (frameless only).
#[cfg(target_os = "macos")]
fn keep_mac_frameless(window: &tauri::Window) {
    if NATIVE_FRAME.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if let Ok(ns_window) = window.ns_window() {
        set_mac_title_bar_parts(ns_window, false);
    }
}

// ---------- Focus Mode (window state: maximized, full screen, frame, always on top, opacity) ----------

/// Always-on-top and opacity as last set by the app (the app is the only one changing them).
static ALWAYS_ON_TOP: Mutex<bool> = Mutex::new(false);
static OPACITY: Mutex<f64> = Mutex::new(1.0);

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    maximized: Option<bool>,
    fullscreen: Option<bool>,
    decorated: Option<bool>,
    always_on_top: Option<bool>,
    /// 0.3 ..= 1.0
    opacity: Option<f64>,
}

#[tauri::command]
fn window_get_state(window: tauri::WebviewWindow) -> Result<WindowState, String> {
    Ok(WindowState {
        maximized: Some(window.is_maximized().map_err(|error| error.to_string())?),
        fullscreen: Some(window.is_fullscreen().map_err(|error| error.to_string())?),
        // macOS is always decorated (see apply_frame); report the frame actually shown.
        decorated: Some(if cfg!(target_os = "macos") {
            NATIVE_FRAME.load(std::sync::atomic::Ordering::Relaxed)
        } else {
            window.is_decorated().map_err(|error| error.to_string())?
        }),
        always_on_top: Some(*ALWAYS_ON_TOP.lock().unwrap()),
        opacity: Some(*OPACITY.lock().unwrap()),
    })
}

/// Apply the given parts of the window state. Entering Focus Mode: frame off → maximize → full
/// screen; leaving it restores the saved state in the reverse order.
#[tauri::command]
fn window_set_state(window: tauri::WebviewWindow, state: WindowState) -> Result<(), String> {
    let err = |error: tauri::Error| error.to_string();
    let leaving_fullscreen = state.fullscreen == Some(false);
    if leaving_fullscreen && window.is_fullscreen().map_err(err)? {
        window.set_fullscreen(false).map_err(err)?;
    }
    if let Some(decorated) = state.decorated {
        apply_frame(&window, decorated)?;
    }
    match state.maximized {
        Some(true) => window.maximize().map_err(err)?,
        Some(false) => {
            if window.is_maximized().map_err(err)? {
                window.unmaximize().map_err(err)?
            }
        }
        None => {}
    }
    if state.fullscreen == Some(true) {
        window.set_fullscreen(true).map_err(err)?;
    }
    if let Some(on_top) = state.always_on_top {
        window.set_always_on_top(on_top).map_err(err)?;
        *ALWAYS_ON_TOP.lock().unwrap() = on_top;
    }
    if let Some(opacity) = state.opacity {
        let opacity = opacity.clamp(0.3, 1.0);
        *OPACITY.lock().unwrap() = opacity;
        #[cfg(target_os = "linux")]
        {
            let target = window.clone();
            window
                .run_on_main_thread(move || {
                    use gtk::prelude::WidgetExt;
                    if let Ok(gtk_window) = target.gtk_window() {
                        gtk_window.set_opacity(opacity);
                    }
                })
                .map_err(err)?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            let target = window.clone();
            window
                .run_on_main_thread(move || set_native_opacity(&target, opacity))
                .map_err(err)?;
        }
    }
    Ok(())
}

/// Windows: layered window with a constant alpha (the WebView2 child is composited with it).
#[cfg(windows)]
fn set_native_opacity(window: &tauri::WebviewWindow, opacity: f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetLayeredWindowAttributes, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    // SAFETY: hwnd is this app's live top-level window; called on the UI thread.
    unsafe {
        #[cfg(target_pointer_width = "64")]
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW as get_style, SetWindowLongPtrW as set_style,
        };
        #[cfg(target_pointer_width = "32")]
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongW as get_style, SetWindowLongW as set_style,
        };
        let style = get_style(hwnd, GWL_EXSTYLE);
        #[cfg(target_pointer_width = "64")]
        type Style = isize;
        #[cfg(target_pointer_width = "32")]
        type Style = i32;
        let layered = WS_EX_LAYERED as Style;
        if opacity >= 1.0 {
            // Fully opaque: drop the layered style again (no composition cost).
            if style & layered != 0 {
                set_style(hwnd, GWL_EXSTYLE, style & !layered);
            }
            return;
        }
        if style & layered == 0 {
            set_style(hwnd, GWL_EXSTYLE, style | layered);
        }
        SetLayeredWindowAttributes(hwnd, 0, (opacity * 255.0).round() as u8, LWA_ALPHA);
    }
}

/// macOS: NSWindow alphaValue.
#[cfg(target_os = "macos")]
fn set_native_opacity(window: &tauri::WebviewWindow, opacity: f64) {
    use objc2::{msg_send, runtime::AnyObject};
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    if ns_window.is_null() {
        return;
    }
    // SAFETY: ns_window is this app's live NSWindow; called on the main thread.
    unsafe {
        let ns_window = &*(ns_window as *const AnyObject);
        let _: () = msg_send![ns_window, setAlphaValue: opacity];
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn set_native_opacity(_window: &tauri::WebviewWindow, _opacity: f64) {}

/// The webview's own right-click menu is disabled; the app's text-field menu does Cut / Copy / Paste
/// itself, so let page scripts use the clipboard (WebKitGTK otherwise pops up its own "Paste" prompt).
fn allow_clipboard(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = WebViewExt::settings(&webview.inner()) {
            settings.set_javascript_can_access_clipboard(true);
        }
    });
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// Title bar style saved in settings.json (`"titleBar": "native" | "frameless"`); frameless by default.
fn native_frame_from_settings() -> bool {
    config::load("settings")
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|doc| {
            doc.get("titleBar")
                .and_then(Value::as_str)
                .map(|value| value == "native")
        })
        .unwrap_or(false)
}

/// Window background behind the webview, matching the app theme, so the area uncovered while the
/// window is being resized is not white in the dark theme.
#[tauri::command]
fn set_window_background(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    let color = if dark {
        tauri::window::Color(0x17, 0x17, 0x17, 0xff)
    } else {
        tauri::window::Color(0xec, 0xec, 0xea, 0xff)
    };
    window
        .set_background_color(Some(color))
        .map_err(|error| error.to_string())
}

/// Text anti-aliasing in the WebKitGTK webview.
///
/// WebKitGTK takes the desktop's subpixel (RGB/LCD) setting, but it can only draw subpixel text on
/// opaque pixels: with GPU compositing, text in a scrolling list or over a transparent background
/// is drawn in grayscale and switches to coloured subpixel rendering as soon as a hover/selection
/// background appears under it — the text jumps between thin and bold with colour fringes.
/// Grayscale anti-aliasing everywhere (and slight hinting) keeps text smooth and identical in
/// every state. Application-level GtkSettings override the desktop's XSETTINGS.
#[cfg(target_os = "linux")]
fn apply_font_rendering() {
    use gtk::prelude::GtkSettingsExt;
    if let Some(settings) = gtk::Settings::default() {
        settings.set_gtk_xft_antialias(1);
        settings.set_gtk_xft_hinting(1);
        settings.set_gtk_xft_hintstyle(Some("hintslight"));
        settings.set_gtk_xft_rgba(Some("none"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let options = match crate::cli::parse() {
        crate::cli::Parsed::Run(options) => options,
        crate::cli::Parsed::Exit(code) => std::process::exit(code),
    };
    if options.stop {
        std::process::exit(crate::cli::stop_daemon());
    }
    if options.daemon && !options.daemon_child {
        std::process::exit(crate::cli::start_daemon(&options));
    }
    if let Some(dir) = options.log.clone() {
        if let Err(error) = crate::applog::set_dir(dir) {
            eprintln!("metroterm: {error}");
            std::process::exit(1);
        }
    }
    let context = tauri::generate_context!();
    if let Some(addr) = options.web {
        let files = crate::cli::bundle_files(context.assets);
        std::process::exit(crate::cli::run_web(addr, files, options.daemon_child));
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let backend = Backend::new(Arc::new(TauriSink(app.handle().clone())));
            app.manage(backend);
            // The main window is created here (tauri.conf.json: "create": false) so that it opens
            // directly with the title bar style chosen in Settings, without a flash of the other one.
            if let Some(window_config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
            {
                let native = native_frame_from_settings();
                NATIVE_FRAME.store(native, std::sync::atomic::Ordering::Relaxed);
                let builder =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
                // macOS: a titled window either way (see apply_frame).
                #[cfg(target_os = "macos")]
                let builder = builder
                    .decorations(true)
                    .title_bar_style(if native {
                        tauri::TitleBarStyle::Visible
                    } else {
                        tauri::TitleBarStyle::Overlay
                    })
                    .hidden_title(!native);
                #[cfg(not(target_os = "macos"))]
                let builder = builder.decorations(native);
                let mut builder = builder;
                // Same size as when the app was last closed (never below the configured minimum).
                if let Some((width, height)) = saved_window_size() {
                    let width = width.max(window_config.min_width.unwrap_or(0.0));
                    let height = height.max(window_config.min_height.unwrap_or(0.0));
                    *NORMAL_SIZE.lock().unwrap() = Some((width, height));
                    builder = builder.inner_size(width, height);
                } else {
                    *NORMAL_SIZE.lock().unwrap() =
                        Some((window_config.width, window_config.height));
                }
                let window = builder.build()?;
                allow_clipboard(&window);
                #[cfg(target_os = "macos")]
                if !native {
                    if let Ok(ns_window) = window.ns_window() {
                        set_mac_title_bar_parts(ns_window, false);
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Resized(_) => {
                remember_normal_size(window);
                #[cfg(target_os = "macos")]
                keep_mac_frameless(window);
            }
            tauri::WindowEvent::CloseRequested { .. } => save_window_state(),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            config_dir_path,
            load_config,
            save_config,
            close_window,
            exit_app,
            set_window_background,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_start_dragging,
            window_set_title,
            window_set_native_frame,
            window_get_state,
            window_set_state
        ])
        .build(context)
        .expect("error while building MetroTerm");
    // GTK is initialised by build(); the main window is created inside run(), after this.
    #[cfg(target_os = "linux")]
    apply_font_rendering();
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            let backend = app.state::<Arc<Backend>>().inner().clone();
            tauri::async_runtime::block_on(backend.shutdown());
        }
    });
}
