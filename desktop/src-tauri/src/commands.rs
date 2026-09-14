use crate::detect::detect_reset;
use crate::fetch::Tweet;
use crate::poller::{ingest, now_ms, notify_pending, poll_once, status_value};
use crate::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub async fn get_state(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    {
        let mut store = state.store.lock().unwrap();
        if store.get_meta("uiSeenAt").is_none() {
            let _ = store.set_meta("uiSeenAt", &json!(now_ms()));
        }
    }
    let config = state.config.lock().unwrap().clone();
    let status = state.status.lock().unwrap().clone();
    let stats = state.store.lock().unwrap().get_stats();
    let account = state.store.lock().unwrap().get_meta("account");
    let engines =
        crate::ai::list_available_engines(&crate::ai::AiOptions::from_config(&config)).await;

    let mut config_value = serde_json::to_value(&config).unwrap_or_else(|_| json!({}));
    if let Some(object) = config_value.as_object_mut() {
        object.insert("aiHttpKey".into(), json!(""));
    }
    json!({
        "config": config_value,
        "aiHttpKeySet": !config.ai_http_key.is_empty(),
        "status": status,
        "stats": stats,
        "account": account,
        "rules": crate::detect::rule_info(),
        "ai": { "engines": engines },
        "ocr": { "available": crate::ocr::supported() },
        "serverTime": now_ms(),
    })
}

#[tauri::command]
pub async fn test_ai(app: AppHandle, text: Option<String>) -> Value {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let options = crate::ai::AiOptions::from_config(&config);
    let text = text.unwrap_or_else(|| "Reset all propagated. Sweet dreams.".to_string());
    match crate::ai::judge_tweet(&text, &options, &state.client).await {
        Ok(verdict) => json!({ "ok": true, "text": text, "verdict": verdict }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

#[tauri::command]
pub fn get_tweets(
    app: AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
    reset_only: Option<bool>,
    q: Option<String>,
    hours: Option<u32>,
) -> Value {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    match store.get_tweets(
        limit.unwrap_or(60).min(500),
        offset.unwrap_or(0),
        reset_only.unwrap_or(false),
        q.as_deref().unwrap_or(""),
        hours.unwrap_or(0),
    ) {
        Ok((total, items)) => json!({ "total": total, "items": items, "serverTime": now_ms() }),
        Err(err) => json!({ "total": 0, "items": [], "error": err }),
    }
}

#[tauri::command]
pub fn get_alerts(app: AppHandle, limit: Option<u32>) -> Value {
    let state = app.state::<AppState>();
    let items = state.store.lock().unwrap().get_alerts(limit.unwrap_or(50).min(200));
    json!({ "items": items })
}

#[tauri::command]
pub async fn control(app: AppHandle, action: String) -> Value {
    let state = app.state::<AppState>();
    match action.as_str() {
        "start" => {
            crate::poller::set_running(&app, true, true);
            json!({ "ok": true, "status": status_value(&app) })
        }
        "stop" => {
            crate::poller::set_running(&app, false, true);
            json!({ "ok": true, "status": status_value(&app) })
        }
        "poll" => {
            drop(state);
            let result = poll_once(&app, "manual").await;
            json!({ "ok": result.ok, "result": result, "status": status_value(&app) })
        }
        _ => json!({ "ok": false, "error": "未知 action" }),
    }
}

#[tauri::command]
pub fn update_config(app: AppHandle, patch: Value) -> Value {
    let state = app.state::<AppState>();
    let updated = {
        let mut config = state.config.lock().unwrap();
        config.apply_patch(&patch);
        let _ = config.save(&state.config_path);
        config.clone()
    };
    let _ = app.emit("config", &updated);
    json!({ "ok": true, "config": updated })
}

#[tauri::command]
pub async fn rescan(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let tweets = state.store.lock().unwrap().all_tweets();

    let mut alerts = 0usize;
    {
        let mut store = state.store.lock().unwrap();
        for tweet in &tweets {
            let text = tweet["text"].as_str().unwrap_or("");
            let id = tweet["id"].as_str().unwrap_or("");
            let detection = detect_reset(text, &config.extra_keywords, config.reset_threshold);
            let final_is_reset = tweet["aiVerdict"].as_bool().unwrap_or(detection.is_reset);
            let _ = store.set_detection(id, &detection, final_is_reset);
            if final_is_reset {
                alerts += 1;
            }
        }
    }

    let pending = {
        let store = state.store.lock().unwrap();
        store.pending_fresh_alerts(config.fresh_hours)
    };
    let notified = notify_pending(&app, &config, &pending).await;
    let ids: Vec<String> = pending
        .iter()
        .filter_map(|tweet| tweet["id"].as_str().map(String::from))
        .collect();
    {
        let mut store = state.store.lock().unwrap();
        let _ = store.mark_notified(&ids);
    }

    let stats = state.store.lock().unwrap().get_stats();
    let _ = app.emit("stats", stats);
    json!({ "ok": true, "scanned": tweets.len(), "alerts": alerts, "notified": notified })
}

#[tauri::command]
pub async fn simulate(app: AppHandle, text: String) -> Value {
    let text = text.trim().to_string();
    if text.is_empty() {
        return json!({ "ok": false, "error": "缺少 text" });
    }
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let account = state.store.lock().unwrap().get_meta("account");
    let now = now_ms();
    let tweet = Tweet {
        id: format!("sim-{now}"),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        created_ts: now,
        text,
        favorite_count: 0,
        reply_count: 0,
        retweet_count: 0,
        quote_count: 0,
        permalink: String::new(),
        avatar: account
            .as_ref()
            .and_then(|a| a["avatar"].as_str())
            .unwrap_or("")
            .to_string(),
        author_name: account
            .as_ref()
            .and_then(|a| a["name"].as_str())
            .unwrap_or("Tibo Sottiaux")
            .to_string(),
        author_handle: account
            .as_ref()
            .and_then(|a| a["handle"].as_str())
            .unwrap_or(&config.handle)
            .to_string(),
        lang: "en".into(),
        media: Vec::new(),
    };

    let summary = ingest(&app, vec![tweet.clone()], "simulate").await;
    let stored = state.store.lock().unwrap().get_tweet(&tweet.id);
    let stats = state.store.lock().unwrap().get_stats();
    let _ = app.emit("stats", stats);

    json!({
        "ok": true,
        "inserted": summary.inserted,
        "notified": summary.notified,
        "detection": stored
            .as_ref()
            .map(|t| json!({
                "isReset": t["isReset"],
                "score": t["resetScore"],
                "signals": t["resetSignals"],
            }))
            .unwrap_or(Value::Null),
    })
}

#[tauri::command]
pub fn open_external(url: String) -> Value {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return json!({ "ok": false, "error": "仅支持 http(s) 链接" });
    }

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();

    match result {
        Ok(_) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

#[tauri::command]
pub fn test_notify(app: AppHandle) -> Value {
    use tauri_plugin_notification::NotificationExt;
    let sound = app.state::<AppState>().config.lock().unwrap().notify_sound.clone();
    let mut builder = app
        .notification()
        .builder()
        .title("Codex Reset Radar")
        .body("通知通道正常，检测到重置公告时你会收到这样的提醒。");
    if !sound.is_empty() {
        builder = builder.sound(sound);
    }
    let _ = builder.show();
    json!({ "ok": true })
}

#[tauri::command]
pub async fn export_data(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let rows = state.store.lock().unwrap().all_tweets();
    let mut body = String::new();
    for row in &rows {
        if let Ok(line) = serde_json::to_string(row) {
            body.push_str(&line);
            body.push('\n');
        }
    }

    let file = rfd::AsyncFileDialog::new()
        .set_file_name("codex-reset-tweets.jsonl")
        .save_file()
        .await;
    match file {
        Some(handle) => match std::fs::write(handle.path(), body) {
            Ok(()) => json!({ "ok": true, "path": handle.path().to_string_lossy() }),
            Err(err) => json!({ "ok": false, "error": err.to_string() }),
        },
        None => json!({ "ok": false, "canceled": true }),
    }
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Value {
    use tauri_plugin_autostart::ManagerExt;
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    let ok = result.is_ok();
    {
        let state = app.state::<AppState>();
        let mut config = state.config.lock().unwrap();
        config.autostart = enabled;
        let _ = config.save(&state.config_path);
    }
    json!({ "ok": ok })
}
