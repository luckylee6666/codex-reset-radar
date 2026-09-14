use crate::detect::detect_reset;
use crate::fetch::{fetch_timeline, fetch_tweet_with_related, Tweet};
use crate::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub checking: bool,
    pub phase: String,
    pub last_check_at: Option<i64>,
    pub next_check_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_source: Option<String>,
    pub consecutive_errors: u32,
    pub interval_sec: u64,
    pub discovered_ids: usize,
    pub discovery_fetched: usize,
    pub ai_judged: usize,
    pub ai_engines: Option<Vec<String>>,
    pub ocr_applied: usize,
    pub graphql_tweets: usize,
}

impl Status {
    pub fn new(interval_sec: u64) -> Self {
        Self {
            running: false,
            checking: false,
            phase: "idle".into(),
            last_check_at: None,
            next_check_at: None,
            last_error: None,
            last_source: None,
            consecutive_errors: 0,
            interval_sec,
            discovered_ids: 0,
            discovery_fetched: 0,
            ai_judged: 0,
            ai_engines: None,
            ocr_applied: 0,
            graphql_tweets: 0,
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    pub ok: bool,
    pub skipped: bool,
    pub fetched: usize,
    pub inserted: usize,
    pub alerts: usize,
    pub notified: usize,
    pub ai_judged: usize,
    pub ocr_applied: usize,
    pub duration_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestSummary {
    pub inserted: usize,
    pub alerts: usize,
    pub notified: usize,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 统一运行状态入口：同步 AtomicBool 与 status，并通知轮询循环
pub fn set_running(app: &AppHandle, running: bool, persist: bool) {
    let state = app.state::<AppState>();
    state.running.store(running, Ordering::Relaxed);
    {
        let mut status = state.status.lock().unwrap();
        status.running = running;
        if running {
            if status.phase == "paused" {
                status.phase = "idle".into();
            }
        } else {
            status.phase = "paused".into();
            status.next_check_at = None;
        }
    }
    if persist {
        let mut config = state.config.lock().unwrap();
        config.paused = !running;
        let _ = config.save(&state.config_path);
    }
    emit_status(app);
    if running {
        state.trigger.notify_one();
    }
}

fn age_text(ms: i64) -> String {
    let minutes = (ms / 60_000).max(0);
    if minutes < 1 {
        return "刚刚".into();
    }
    if minutes < 60 {
        return format!("{minutes} 分钟前");
    }
    let hours = minutes / 60;
    if hours < 48 {
        return format!("{hours} 小时前");
    }
    format!("{} 天前", hours / 24)
}

pub fn status_value(app: &AppHandle) -> Value {
    let state = app.state::<AppState>();
    let status = state.status.lock().unwrap();
    serde_json::to_value(&*status).unwrap_or(json!({}))
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("status", status_value(app));
}
pub async fn poll_once(app: &AppHandle, trigger: &str) -> PollResult {
    let state = app.state::<AppState>();
    let _guard = match state.poll_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return PollResult {
                skipped: true,
                ..Default::default()
            }
        }
    };

    let started = std::time::Instant::now();
    {
        let mut status = state.status.lock().unwrap();
        status.checking = true;
        status.phase = "checking".into();
    }
    emit_status(app);

    let config = state.config.lock().unwrap().clone();
    let interval_ms = config.interval_sec.max(60) as i64 * 1000;
    let discovery_interval_ms = config.discovery_interval_sec.max(60) as i64 * 1000;

    let mut merged: BTreeMap<String, Tweet> = BTreeMap::new();
    let mut sources: Vec<String> = Vec::new();
    let mut timeline_ok = false;
    let mut timeline_failure: Option<String> = None;

    /* ── 时间线：独立退避，不拖累搜索发现 ── */
    let should_timeline = {
        let timeline = state.timeline.lock().unwrap();
        now_ms() >= timeline.next_at
    };
    if should_timeline {
        match fetch_timeline(&state.client, &config.handle).await {
            Ok(tweets) => {
                for tweet in tweets {
                    merged.insert(tweet.id.clone(), tweet);
                }
                sources.push("syndication".into());
                timeline_ok = true;
                let mut timeline = state.timeline.lock().unwrap();
                timeline.backoff = 1;
                timeline.last_ok_at = now_ms();
            }
            Err(err) => {
                timeline_failure = Some(err.message.clone());
                let mut timeline = state.timeline.lock().unwrap();
                timeline.backoff = (timeline.backoff * 2).min(8);
                let retry_after = err.retry_after as i64 * 1000;
                timeline.next_at =
                    now_ms() + (interval_ms * timeline.backoff as i64).max(retry_after);
            }
        }
    }

    /* ── 公开主页：免登录，拿最近推文 ID + 账号数字 ID（失败冷却 10 分钟） ── */
    let mut direct_ids: Vec<String> = Vec::new();
    let mut profile_user_id = String::new();
    {
        let due = {
            let discovery = state.discovery_state.lock().unwrap();
            now_ms() >= discovery.next_profile_at
        };
        if config.profile_scrape && due {
            match crate::fetch::fetch_profile(&state.client, &config.handle).await {
                Ok((ids, user_id)) => {
                    if !ids.is_empty() {
                        sources.push("profile".into());
                    }
                    direct_ids = ids;
                    profile_user_id = user_id;
                }
                Err(_) => {
                    let mut discovery = state.discovery_state.lock().unwrap();
                    discovery.next_profile_at = now_ms() + 10 * 60 * 1000;
                }
            }
        }
    }
    {
        let cached = state.store.lock().unwrap().get_meta("xUserId");
        if profile_user_id.is_empty() {
            profile_user_id = cached
                .as_ref()
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        } else if cached.as_ref().and_then(|v| v.as_str()) != Some(profile_user_id.as_str()) {
            let mut store = state.store.lock().unwrap();
            let _ = store.set_meta("xUserId", &json!(profile_user_id));
        }
    }

    /* ── 浏览器 Cookie + 内部 GraphQL：配置了就优先，数据最全 ── */
    let mut graphql_ok = false;
    let mut graphql_error: Option<String> = None;
    if crate::x_graphql::is_configured(&config) {
        let mut user_id = profile_user_id.clone();
        if user_id.is_empty() {
            match crate::x_graphql::resolve_user_id(&state.client, &config, &config.handle).await {
                Ok(id) => user_id = id,
                Err(err) => graphql_error = Some(err),
            }
        }
        if graphql_error.is_none() && !user_id.is_empty() {
            {
                let mut store = state.store.lock().unwrap();
                let _ = store.set_meta("xUserId", &json!(user_id));
            }
            match crate::x_graphql::fetch_user_tweets(&state.client, &config, &user_id).await {
                Ok(tweets) => {
                    let count = tweets.len();
                    for tweet in tweets {
                        merged.insert(tweet.id.clone(), tweet);
                    }
                    sources.push("graphql".into());
                    graphql_ok = true;
                    {
                        let mut status = state.status.lock().unwrap();
                        status.graphql_tweets = count;
                    }
                    let mut store = state.store.lock().unwrap();
                    let _ = store.set_meta(
                        "graphqlOk",
                        &json!({ "at": now_ms(), "count": count }),
                    );
                }
                Err(err) => graphql_error = Some(err),
            }
        }
        if let Some(err) = &graphql_error {
            let _ = app.emit("graphql-error", err);
        }
    }

    /* ── 搜索发现：按自己的节奏运行；手动/托盘触发时强制执行 ── */
    let mut discovery_ok = false;
    let mut discovery_attempted = false;
    let mut discovered_ids: Vec<String> = Vec::new();
    let force_discovery = trigger == "manual" || trigger == "tray";
    let discovery_due = force_discovery || {
        let discovery = state.discovery_state.lock().unwrap();
        now_ms() - discovery.last_at >= discovery_interval_ms
    };
    if config.search_discovery && discovery_due {
        {
            let mut discovery = state.discovery_state.lock().unwrap();
            discovery.last_at = now_ms();
        }

        let (ids, source, attempted) = state.discovery.discover(&state.client, &config.handle).await;
        discovery_attempted = attempted;
        discovered_ids = ids;
        if let Some(source) = source {
            discovery_ok = true;
            sources.push(source);
            let mut discovery = state.discovery_state.lock().unwrap();
            discovery.last_ok_at = now_ms();
        }
    } else if config.search_discovery {
        let last_ok = {
            let discovery = state.discovery_state.lock().unwrap();
            discovery.last_ok_at
        };
        discovery_ok = last_ok > 0 && now_ms() - last_ok < 3 * discovery_interval_ms;
    }

    /* ── 合并 ID（主页在前），拉取未见过的详情 ── */
    {
        let mut merged_ids: Vec<String> = direct_ids.clone();
        for id in &discovered_ids {
            if !merged_ids.contains(id) {
                merged_ids.push(id.clone());
            }
        }
        let unseen: Vec<String> = {
            let store = state.store.lock().unwrap();
            merged_ids
                .into_iter()
                .filter(|id| !store.has_tweet(id) && !merged.contains_key(id))
                .collect()
        };
        let limit = config.discovery_max_fetch.clamp(1, 30) as usize;
        let mut fetched = 0usize;
        let handle = config.handle.to_lowercase();
        for id in unseen.iter().take(limit) {
            if let Ok((tweet, related)) =
                fetch_tweet_with_related(&state.client, id, &config.handle).await
            {
                let author = tweet.author_handle.to_lowercase();
                if !author.is_empty() && author != handle {
                    continue; // 主页可能混入他人推文，按作者过滤
                }
                merged.insert(tweet.id.clone(), tweet);
                fetched += 1;
                for parent in related {
                    let parent_author = parent.author_handle.to_lowercase();
                    if !parent_author.is_empty() && parent_author != handle {
                        continue;
                    }
                    let exists = state.store.lock().unwrap().has_tweet(&parent.id);
                    if !exists && !merged.contains_key(&parent.id) {
                        merged.insert(parent.id.clone(), parent);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        }
        {
            let mut status = state.status.lock().unwrap();
            status.discovered_ids = direct_ids.len().max(discovered_ids.len());
            status.discovery_fetched = fetched;
        }
    }

    /* ── 健康判断：只有所有来源都不可用才算失败 ── */
    let timeline_fresh = {
        let timeline = state.timeline.lock().unwrap();
        now_ms() - timeline.last_ok_at < 3 * interval_ms
    };
    let discovery_fresh = {
        let discovery = state.discovery_state.lock().unwrap();
        now_ms() - discovery.last_ok_at < 3 * discovery_interval_ms
    };

    if merged.is_empty()
        && !(timeline_ok
            || timeline_fresh
            || discovery_ok
            || discovery_fresh
            || graphql_ok
            || !direct_ids.is_empty())
    {
        let message = timeline_failure
            .clone()
            .or_else(|| graphql_error.clone())
            .unwrap_or_else(|| {
                if discovery_attempted {
                    "搜索发现暂时不可用".into()
                } else {
                    "所有数据源暂时不可用".into()
                }
            });
        {
            let mut status = state.status.lock().unwrap();
            status.checking = false;
            status.consecutive_errors += 1;
            status.last_error = Some(message.clone());
            status.phase = "error".into();
        }
        emit_status(app);
        // 抓取失败不影响 OCR 与 AI 判定待处理候选
        let ocr_applied = ocr_pass(app).await;
        let ai_judged = judge_with_ai(app).await;
        return PollResult {
            ok: false,
            error: Some(message),
            ai_judged,
            ocr_applied,
            duration_ms: started.elapsed().as_millis(),
            ..Default::default()
        };
    }

    let tweets: Vec<Tweet> = merged.into_values().collect();
    let summary = ingest(app, tweets.clone(), "live").await;
    let ocr_applied = ocr_pass(app).await;
    let ai_judged = judge_with_ai(app).await;

    {
        let mut status = state.status.lock().unwrap();
        status.checking = false;
        status.consecutive_errors = 0;
        status.last_check_at = Some(now_ms());
        status.last_source = Some(sources.join("+"));
        status.ai_judged = ai_judged;
        status.ocr_applied = ocr_applied;
        if let Some(err) = &graphql_error {
            status.last_error = Some(err.clone());
        } else if timeline_ok || discovery_ok || graphql_ok {
            status.last_error = None;
        } else {
            status.last_error = timeline_failure;
        }
        status.phase = "ok".into();
    }
    emit_status(app);

    let newest = tweets.last().cloned();
    {
        let mut store = state.store.lock().unwrap();
        if let Some(newest) = newest {
            let _ = store.set_meta(
                "account",
                &json!({
                    "handle": if newest.author_handle.is_empty() { config.handle.clone() } else { newest.author_handle.clone() },
                    "name": newest.author_name,
                    "avatar": newest.avatar,
                }),
            );
        }
        let _ = store.set_meta(
            "lastPoll",
            &json!({
                "at": now_ms(),
                "fetched": tweets.len(),
                "inserted": summary.inserted,
                "trigger": trigger,
            }),
        );
    }

    let stats = state.store.lock().unwrap().get_stats();
    let _ = app.emit("stats", stats);

    PollResult {
        ok: true,
        fetched: tweets.len(),
        inserted: summary.inserted,
        alerts: summary.alerts,
        notified: summary.notified,
        ai_judged,
        ocr_applied,
        duration_ms: started.elapsed().as_millis(),
        ..Default::default()
    }
}

async fn ocr_pass(app: &AppHandle) -> usize {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    if !config.ocr_enabled || !crate::ocr::supported() {
        return 0;
    }

    let days = config.ocr_max_age_days.clamp(1, 60);
    let limit = config.ocr_max_per_poll.clamp(1, 5) as usize;
    let candidates: Vec<Value> = {
        let store = state.store.lock().unwrap();
        store
            .pending_ocr_candidates(60, days)
            .into_iter()
            .take(limit)
            .collect()
    };
    if candidates.is_empty() {
        return 0;
    }

    let data_dir = state
        .config_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let mut applied = 0usize;
    let mut changed: Vec<Value> = Vec::new();

    for tweet in &candidates {
        let id = tweet["id"].as_str().unwrap_or("").to_string();
        let text = tweet["text"].as_str().unwrap_or("").to_string();
        let before = tweet["isReset"].as_bool().unwrap_or(false);
        let media = tweet["media"].clone();

        let Some(url) = crate::ocr::pick_image_url(&media) else {
            let mut store = state.store.lock().unwrap();
            let _ = store.set_ocr_text(&id, "");
            continue;
        };

        let temp_path = std::env::temp_dir().join(format!("radar-ocr-{}.img", now_ms()));
        let result = async {
            crate::ocr::download_image(&state.client, &url, &temp_path).await?;
            crate::ocr::ocr_image(&data_dir, &temp_path).await
        }
        .await;

        match result {
            Ok(ocr_text) => {
                applied += 1;
                {
                    let mut store = state.store.lock().unwrap();
                    let _ = store.set_ocr_text(&id, &ocr_text);
                    let combined = crate::ocr::combined_text(&text, Some(&ocr_text));
                    let detection = detect_reset(
                        &combined,
                        &config.extra_keywords,
                        config.reset_threshold,
                    );
                    let _ = store.set_detection(&id, &detection, detection.is_reset);
                    let _ = store.clear_ai_verdict(&id);
                }
                if let Some(updated) = state.store.lock().unwrap().get_tweet(&id) {
                    if updated["isReset"].as_bool().unwrap_or(false) != before {
                        changed.push(updated);
                    }
                }
            }
            Err(err) => {
                let mut store = state.store.lock().unwrap();
                let _ = store.set_ocr_text(&id, "");
                drop(store);
                if err.contains("Xcode") || err.contains("OCR 仅支持") {
                    let _ = app.emit("ocr-error", err);
                    break;
                }
            }
        }
        let _ = std::fs::remove_file(&temp_path);
    }

    if !changed.is_empty() {
        let _ = app.emit("tweets", changed.clone());
        for tweet in &changed {
            if tweet["isReset"].as_bool().unwrap_or(false) {
                let _ = app.emit(
                    "alert",
                    json!({
                        "tweet": tweet,
                        "detection": {
                            "isReset": true,
                            "score": tweet["resetScore"],
                            "signals": tweet["resetSignals"],
                        }
                    }),
                );
            }
        }
        let pending = {
            let store = state.store.lock().unwrap();
            store.pending_fresh_alerts(config.fresh_hours)
        };
        notify_pending(app, &config, &pending).await;
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
    }

    {
        let mut status = state.status.lock().unwrap();
        status.ocr_applied = applied;
    }
    applied
}

fn ai_candidate_re() -> &'static regex::Regex {
    static CELL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    CELL.get_or_init(|| regex::Regex::new(r"(?i)\b(?:reset|refill|replenish|top.?up|banked)\w*").unwrap())
}

async fn judge_with_ai(app: &AppHandle) -> usize {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    if !config.ai_judge {
        return 0;
    }

    let max_per_poll = config.ai_max_per_poll.clamp(1, 10) as usize;
    let candidates: Vec<Value> = {
        let store = state.store.lock().unwrap();
        store
            .pending_ai_candidates(150)
            .into_iter()
            .filter(|tweet| {
                ai_candidate_re().is_match(tweet["text"].as_str().unwrap_or(""))
            })
            .take(max_per_poll)
            .collect()
    };
    if candidates.is_empty() {
        return 0;
    }

    let engines = crate::ai::list_available_engines(&crate::ai::AiOptions::from_config(&config)).await;
    {
        let mut status = state.status.lock().unwrap();
        status.ai_engines = Some(engines.clone());
    }
    if engines.is_empty() {
        return 0;
    }

    let options = crate::ai::AiOptions::from_config(&config);
    let mut judged = 0usize;
    let mut changed: Vec<Value> = Vec::new();
    for tweet in &candidates {
        let text = tweet["text"].as_str().unwrap_or("").to_string();
        let id = tweet["id"].as_str().unwrap_or("").to_string();
        let before = tweet["isReset"].as_bool().unwrap_or(false);
        let judge_text = crate::ocr::combined_text(&text, tweet["ocrText"].as_str());
        match crate::ai::judge_tweet(&judge_text, &options, &state.client).await {
            Ok(verdict) => {
                {
                    let mut store = state.store.lock().unwrap();
                    let _ = store.set_ai_verdict(&id, &verdict);
                }
                judged += 1;
                if let Some(updated) = state.store.lock().unwrap().get_tweet(&id) {
                    if updated["isReset"].as_bool().unwrap_or(false) != before {
                        changed.push(updated);
                    }
                }
            }
            Err(err) => {
                let _ = app.emit("ai-error", err);
                break;
            }
        }
    }

    if !changed.is_empty() {
        let _ = app.emit("tweets", changed.clone());
        for tweet in &changed {
            if tweet["isReset"].as_bool().unwrap_or(false) {
                let _ = app.emit(
                    "alert",
                    json!({
                        "tweet": tweet,
                        "detection": {
                            "isReset": true,
                            "score": tweet["resetScore"],
                            "signals": tweet["resetSignals"],
                        }
                    }),
                );
            }
        }
        let pending = {
            let store = state.store.lock().unwrap();
            store.pending_fresh_alerts(config.fresh_hours)
        };
        notify_pending(app, &config, &pending).await;
        let ids: Vec<String> = pending
            .iter()
            .filter_map(|tweet| tweet["id"].as_str().map(String::from))
            .collect();
        {
            let mut store = state.store.lock().unwrap();
            let _ = store.mark_notified(&ids);
        }
    }

    judged
}

pub async fn ingest(app: &AppHandle, tweets: Vec<Tweet>, source: &str) -> IngestSummary {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();

    let (stored, alert_values, pending) = {
        let mut store = state.store.lock().unwrap();
        let inserted = store.upsert_tweets(&tweets, source).unwrap_or_default();
        let mut alerts: Vec<Value> = Vec::new();
        for tweet in &inserted {
            let detection =
                detect_reset(&tweet.text, &config.extra_keywords, config.reset_threshold);
            let _ = store.set_detection(&tweet.id, &detection, detection.is_reset);
            if detection.is_reset {
                if let Some(value) = store.get_tweet(&tweet.id) {
                    alerts.push(json!({ "tweet": value, "detection": detection }));
                }
            }
        }
        let stored: Vec<Value> = inserted
            .iter()
            .filter_map(|tweet| store.get_tweet(&tweet.id))
            .collect();
        let pending = store.pending_fresh_alerts(config.fresh_hours);
        (stored, alerts, pending)
    };

    if !stored.is_empty() {
        let _ = app.emit("tweets", stored.clone());
    }
    for alert in &alert_values {
        let _ = app.emit("alert", alert.clone());
    }

    let notified = notify_pending(app, &config, &pending).await;
    let ids: Vec<String> = pending
        .iter()
        .filter_map(|tweet| tweet["id"].as_str().map(String::from))
        .collect();
    {
        let mut store = state.store.lock().unwrap();
        let _ = store.mark_notified(&ids);
    }

    IngestSummary {
        inserted: stored.len(),
        alerts: alert_values.len(),
        notified,
    }
}

pub async fn notify_pending(
    app: &AppHandle,
    config: &crate::config::Config,
    pending: &[Value],
) -> usize {
    if !config.notify || pending.is_empty() {
        return 0;
    }
    use tauri_plugin_notification::NotificationExt;

    for tweet in pending.iter().take(3) {
        let title = if tweet["source"].as_str() == Some("simulate") {
            "Codex 重置信号（模拟）"
        } else {
            "Codex 重置信号"
        };
        let created = tweet["createdTs"].as_i64().unwrap_or_else(now_ms);
        let handle = tweet["authorHandle"].as_str().unwrap_or("");
        let text = tweet["text"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let body = format!("{} · @{handle}\n{text}", age_text(now_ms() - created));
        let mut builder = app.notification().builder().title(title).body(body);
        if !config.notify_sound.is_empty() {
            builder = builder.sound(config.notify_sound.clone());
        }
        let _ = builder.show();
    }
    if pending.len() > 3 {
        let mut builder = app
            .notification()
            .builder()
            .title("Codex 重置信号")
            .body(format!("另有 {} 条公告，打开面板查看全部", pending.len() - 3));
        if !config.notify_sound.is_empty() {
            builder = builder.sound(config.notify_sound.clone());
        }
        let _ = builder.show();
    }
    pending.len()
}

pub fn spawn_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let running = app.state::<AppState>().running.load(Ordering::Relaxed);
            if running {
                let result = poll_once(&app, "scheduled").await;
                let interval = app.state::<AppState>().config.lock().unwrap().interval_sec.max(60);
                {
                    let state = app.state::<AppState>();
                    let mut status = state.status.lock().unwrap();
                    status.next_check_at = Some(now_ms() + interval as i64 * 1000);
                }
                emit_status(&app);
                if result.skipped {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
            let state = app.state::<AppState>();
            let interval = state.config.lock().unwrap().interval_sec.max(60);
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval)) => {}
                _ = state.trigger.notified() => {}
            }
        }
    });
}
