mod ai;
mod commands;
mod config;
mod detect;
mod fetch;
mod ocr;
mod poller;
mod store;
mod x_graphql;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};

pub struct TimelineState {
    pub backoff: u32,
    pub next_at: i64,
    pub last_ok_at: i64,
}

pub struct DiscoveryState {
    pub last_at: i64,
    pub last_ok_at: i64,
    pub next_profile_at: i64,
}

pub struct AppState {
    pub config: Mutex<config::Config>,
    pub store: Mutex<store::Store>,
    pub status: Mutex<poller::Status>,
    pub running: AtomicBool,
    pub trigger: tokio::sync::Notify,
    pub poll_lock: tokio::sync::Mutex<()>,
    pub discovery: fetch::Discovery,
    pub client: reqwest::Client,
    pub timeline: Mutex<TimelineState>,
    pub discovery_state: Mutex<DiscoveryState>,
    pub config_path: std::path::PathBuf,
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
    let poll = MenuItem::with_id(app, "poll", "立即检查", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停 / 恢复监控", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &poll,
            &pause,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(
            tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
                .expect("tray icon"),
        )
        .icon_as_template(true)
        .tooltip("Codex Reset Radar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "poll" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = poller::poll_once(&app, "tray").await;
                });
            }
            "pause" => {
                let next = {
                    let state = app.state::<AppState>();
                    !state.running.load(std::sync::atomic::Ordering::Relaxed)
                };
                poller::set_running(app, next, true);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::get_tweets,
            commands::get_alerts,
            commands::control,
            commands::update_config,
            commands::rescan,
            commands::simulate,
            commands::test_notify,
            commands::test_ai,
            commands::translate_tweet,
            commands::open_external,
            commands::open_x_login,
            commands::export_data,
            commands::set_autostart,
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            std::fs::create_dir_all(&data_dir)?;
            let store = store::Store::open(&data_dir.join("codex-reset.db"))?;
            let config_path = data_dir.join("config.json");
            let config = config::Config::load(&config_path);

            app.manage(AppState {
                config: Mutex::new(config),
                store: Mutex::new(store),
                status: Mutex::new(poller::Status::new(600)),
                running: AtomicBool::new(true),
                trigger: tokio::sync::Notify::new(),
                poll_lock: tokio::sync::Mutex::new(()),
                discovery: fetch::Discovery::new(),
                client: reqwest::Client::builder()
                    .user_agent(fetch::UA)
                    .timeout(std::time::Duration::from_secs(25))
                    .build()?,
                timeline: Mutex::new(TimelineState {
                    backoff: 1,
                    next_at: 0,
                    last_ok_at: 0,
                }),
                discovery_state: Mutex::new(DiscoveryState {
                    last_at: 0,
                    last_ok_at: 0,
                    next_profile_at: 0,
                }),
                config_path,
            });

            // 初始运行状态：跟随上次的暂停开关
            {
                let state = app.state::<AppState>();
                let paused = state.config.lock().unwrap().paused;
                state
                    .running
                    .store(!paused, std::sync::atomic::Ordering::Relaxed);
                let mut status = state.status.lock().unwrap();
                status.running = !paused;
                status.phase = if paused { "paused".into() } else { "idle".into() };
            }

            setup_tray(app)?;

            {
                use tauri_plugin_autostart::ManagerExt;
                let enabled = app.state::<AppState>().config.lock().unwrap().autostart;
                let _ = if enabled {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
            }

            if std::env::args().any(|arg| arg == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            poller::spawn_poller(app.handle().clone());
            {
                let state = app.state::<AppState>();
                if state.running.load(std::sync::atomic::Ordering::Relaxed) {
                    state.trigger.notify_one();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 只对主窗口做"关闭即隐藏"；登录窗口等允许正常关闭
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
