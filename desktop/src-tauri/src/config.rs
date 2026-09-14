use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub handle: String,
    pub interval_sec: u64,
    pub notify: bool,
    pub notify_sound: String,
    pub fresh_hours: f64,
    pub reset_threshold: f64,
    pub extra_keywords: Vec<String>,
    pub rss_url: String,
    pub search_discovery: bool,
    pub profile_scrape: bool,
    pub x_auth_token: String,
    pub x_ct0: String,
    pub x_user_tweets_query_id: String,
    pub discovery_max_fetch: u32,
    pub discovery_interval_sec: u64,
    pub ai_judge: bool,
    pub ai_engine: String,
    pub ai_max_per_poll: u32,
    pub ai_timeout_sec: u64,
    pub ai_ollama_model: String,
    pub ai_http_url: String,
    pub ai_http_key: String,
    pub ai_http_model: String,
    pub ai_http_format: String,
    pub ocr_enabled: bool,
    pub ocr_max_per_poll: u32,
    pub ocr_max_age_days: u32,
    pub paused: bool,
    pub autostart: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            handle: "thsottiaux".into(),
            interval_sec: 600,
            notify: true,
            notify_sound: "Glass".into(),
            fresh_hours: 6.0,
            reset_threshold: 3.0,
            extra_keywords: Vec::new(),
            rss_url: String::new(),
            search_discovery: true,
            profile_scrape: true,
            x_auth_token: String::new(),
            x_ct0: String::new(),
            x_user_tweets_query_id: String::new(),
            discovery_max_fetch: 10,
            discovery_interval_sec: 600,
            ai_judge: true,
            ai_engine: "auto".into(),
            ai_max_per_poll: 3,
            ai_timeout_sec: 90,
            ai_ollama_model: String::new(),
            ai_http_url: String::new(),
            ai_http_key: String::new(),
            ai_http_model: String::new(),
            ai_http_format: "openai".into(),
            ocr_enabled: true,
            ocr_max_per_poll: 2,
            ocr_max_age_days: 7,
            paused: false,
            autostart: false,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, format!("{json}\n")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn apply_patch(&mut self, patch: &serde_json::Value) {
        if let Some(v) = patch.get("intervalSec").and_then(|v| v.as_f64()) {
            self.interval_sec = (v as u64).clamp(600, 7200);
        }
        if let Some(v) = patch.get("notify").and_then(|v| v.as_bool()) {
            self.notify = v;
        }
        if let Some(v) = patch.get("notifySound").and_then(|v| v.as_str()) {
            self.notify_sound = v.chars().take(40).collect();
        }
        if let Some(v) = patch.get("freshHours").and_then(|v| v.as_f64()) {
            self.fresh_hours = v.clamp(0.0, 168.0);
        }
        if let Some(v) = patch.get("resetThreshold").and_then(|v| v.as_f64()) {
            self.reset_threshold = v.clamp(1.0, 10.0);
        }
        if let Some(v) = patch.get("extraKeywords").and_then(|v| v.as_array()) {
            self.extra_keywords = v
                .iter()
                .filter_map(|k| k.as_str())
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
                .take(20)
                .collect();
        }
        if let Some(v) = patch.get("rssUrl").and_then(|v| v.as_str()) {
            let trimmed = v.trim();
            self.rss_url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                trimmed.chars().take(500).collect()
            } else {
                String::new()
            };
        }
        if let Some(v) = patch.get("searchDiscovery").and_then(|v| v.as_bool()) {
            self.search_discovery = v;
        }
        if let Some(v) = patch.get("profileScrape").and_then(|v| v.as_bool()) {
            self.profile_scrape = v;
        }
        if let Some(value) = patch.get("xAuthToken") {
            if value.is_null() {
                self.x_auth_token.clear();
            } else if let Some(token) = value.as_str() {
                let token = token.trim();
                if !token.is_empty() {
                    self.x_auth_token = token.chars().take(200).collect();
                }
            }
        }
        if let Some(value) = patch.get("xCt0") {
            if value.is_null() {
                self.x_ct0.clear();
            } else if let Some(token) = value.as_str() {
                let token = token.trim();
                if !token.is_empty() {
                    self.x_ct0 = token.chars().take(200).collect();
                }
            }
        }
        if let Some(v) = patch.get("xUserTweetsQueryId").and_then(|v| v.as_str()) {
            self.x_user_tweets_query_id = v.trim().chars().take(60).collect();
        }
        if let Some(v) = patch.get("discoveryMaxFetch").and_then(|v| v.as_f64()) {
            self.discovery_max_fetch = (v as u32).clamp(1, 30);
        }
        if let Some(v) = patch.get("discoveryIntervalSec").and_then(|v| v.as_f64()) {
            self.discovery_interval_sec = (v as u64).clamp(60, 3600);
        }
        if let Some(v) = patch.get("aiJudge").and_then(|v| v.as_bool()) {
            self.ai_judge = v;
        }
        if let Some(v) = patch.get("aiEngine").and_then(|v| v.as_str()) {
            self.ai_engine = if ["auto", "http", "claude", "codex", "ollama"].contains(&v) {
                v.to_string()
            } else {
                "auto".into()
            };
        }
        if let Some(v) = patch.get("aiMaxPerPoll").and_then(|v| v.as_f64()) {
            self.ai_max_per_poll = (v as u32).clamp(1, 10);
        }
        if let Some(v) = patch.get("aiTimeoutSec").and_then(|v| v.as_f64()) {
            self.ai_timeout_sec = (v as u64).clamp(20, 300);
        }
        if let Some(v) = patch.get("aiOllamaModel").and_then(|v| v.as_str()) {
            self.ai_ollama_model = v.chars().take(60).collect();
        }
        if let Some(v) = patch.get("aiHttpUrl").and_then(|v| v.as_str()) {
            let trimmed = v.trim();
            self.ai_http_url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                trimmed.chars().take(500).collect()
            } else {
                String::new()
            };
        }
        if let Some(value) = patch.get("aiHttpKey") {
            if value.is_null() {
                self.ai_http_key.clear();
            } else if let Some(key) = value.as_str() {
                let key = key.trim();
                if !key.is_empty() {
                    self.ai_http_key = key.chars().take(500).collect();
                }
            }
        }
        if let Some(v) = patch.get("aiHttpModel").and_then(|v| v.as_str()) {
            self.ai_http_model = v.trim().chars().take(80).collect();
        }
        if let Some(v) = patch.get("aiHttpFormat").and_then(|v| v.as_str()) {
            self.ai_http_format = if v == "anthropic" { "anthropic" } else { "openai" }.into();
        }
        if let Some(v) = patch.get("paused").and_then(|v| v.as_bool()) {
            self.paused = v;
        }
        if let Some(v) = patch.get("ocrEnabled").and_then(|v| v.as_bool()) {
            self.ocr_enabled = v;
        }
        if let Some(v) = patch.get("ocrMaxPerPoll").and_then(|v| v.as_f64()) {
            self.ocr_max_per_poll = (v as u32).clamp(1, 5);
        }
        if let Some(v) = patch.get("ocrMaxAgeDays").and_then(|v| v.as_f64()) {
            self.ocr_max_age_days = (v as u32).clamp(1, 60);
        }
        if let Some(v) = patch.get("handle").and_then(|v| v.as_str()) {
            let cleaned: String = v
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .take(30)
                .collect();
            self.handle = if cleaned.is_empty() {
                "thsottiaux".into()
            } else {
                cleaned
            };
        }
    }
}
