use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub const UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Media {
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tweet {
    pub id: String,
    pub created_at: String,
    pub created_ts: i64,
    pub text: String,
    pub favorite_count: i64,
    pub reply_count: i64,
    pub retweet_count: i64,
    pub quote_count: i64,
    pub permalink: String,
    pub avatar: String,
    pub author_name: String,
    pub author_handle: String,
    pub lang: String,
    pub media: Vec<Media>,
}

#[derive(Debug)]
pub struct FetchError {
    pub message: String,
    pub retry_after: u64,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for FetchError {}

fn fetch_err(message: impl Into<String>) -> FetchError {
    FetchError {
        message: message.into(),
        retry_after: 0,
    }
}

pub fn decode_entities(text: &str) -> String {
    let mut out = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'");
    if out.contains("&#") {
        let re = regex::Regex::new(r"&#(\d+);").unwrap();
        out = re
            .replace_all(&out, |caps: &regex::Captures| {
                caps[1]
                    .parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
                    .map(String::from)
                    .unwrap_or_default()
            })
            .into_owned();
    }
    out
}

pub(crate) fn iso_and_ts(raw: &str) -> (String, i64) {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        let utc = dt.with_timezone(&chrono::Utc);
        return (
            utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            utc.timestamp_millis(),
        );
    }
    if let Ok(dt) = chrono::DateTime::parse_from_str(raw, "%a %b %d %H:%M:%S %z %Y") {
        let utc = dt.with_timezone(&chrono::Utc);
        return (
            utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            utc.timestamp_millis(),
        );
    }
    let now = chrono::Utc::now();
    (
        now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        now.timestamp_millis(),
    )
}

fn media_from(value: &Value) -> Vec<Media> {
    value
        .get("entities")
        .and_then(|e| e.get("media"))
        .and_then(|m| m.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item
                        .get("media_url_https")
                        .or_else(|| item.get("media_url"))
                        .and_then(|u| u.as_str())?;
                    Some(Media {
                        kind: item.get("type").and_then(|t| t.as_str()).unwrap_or("photo").to_string(),
                        url: url.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn num(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

pub fn normalize_timeline_tweet(tweet: &Value) -> Option<Tweet> {
    let id = tweet.get("id_str").and_then(|v| v.as_str())?;
    let user = tweet.get("user").cloned().unwrap_or(Value::Null);
    let raw_date = tweet.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
    let (created_at, created_ts) = iso_and_ts(raw_date);
    let text = tweet
        .get("full_text")
        .or_else(|| tweet.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let handle = user.get("screen_name").and_then(|v| v.as_str()).unwrap_or("i");
    let permalink = tweet
        .get("permalink")
        .and_then(|v| v.as_str())
        .map(|p| format!("https://x.com{p}"))
        .unwrap_or_else(|| format!("https://x.com/{handle}/status/{id}"));

    Some(Tweet {
        id: id.to_string(),
        created_at,
        created_ts,
        text: decode_entities(text),
        favorite_count: num(tweet, "favorite_count"),
        reply_count: num(tweet, "reply_count"),
        retweet_count: num(tweet, "retweet_count"),
        quote_count: num(tweet, "quote_count"),
        permalink,
        avatar: user
            .get("profile_image_url_https")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        author_name: user.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        author_handle: user.get("screen_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        lang: tweet.get("lang").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        media: media_from(tweet),
    })
}

pub fn normalize_detail_tweet(tweet: &Value) -> Option<Tweet> {
    let id = tweet.get("id_str").and_then(|v| v.as_str())?;
    let user = tweet.get("user").cloned().unwrap_or(Value::Null);
    let raw_date = tweet.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
    let (created_at, created_ts) = iso_and_ts(raw_date);
    let text = tweet
        .get("text")
        .or_else(|| tweet.get("full_text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let handle = user.get("screen_name").and_then(|v| v.as_str()).unwrap_or("i");

    Some(Tweet {
        id: id.to_string(),
        created_at,
        created_ts,
        text: decode_entities(text),
        favorite_count: num(tweet, "favorite_count"),
        reply_count: tweet
            .get("reply_count")
            .and_then(|v| v.as_i64())
            .or_else(|| tweet.get("conversation_count").and_then(|v| v.as_i64()))
            .unwrap_or(0),
        retweet_count: num(tweet, "retweet_count"),
        quote_count: num(tweet, "quote_count"),
        permalink: format!("https://x.com/{handle}/status/{id}"),
        avatar: user
            .get("profile_image_url_https")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        author_name: user.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        author_handle: user.get("screen_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        lang: tweet.get("lang").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        media: media_from(tweet),
    })
}

pub fn parse_timeline_html(html: &str) -> Result<Vec<Tweet>, FetchError> {
    let re = regex::Regex::new(
        r#"(?s)<script id="__NEXT_DATA__" type="application/json">(.*?)</script>"#,
    )
    .unwrap();
    let captured = re
        .captures(html)
        .and_then(|c| c.get(1))
        .ok_or_else(|| fetch_err("页面结构变化：未找到 __NEXT_DATA__（X 可能调整了接口）"))?;

    let data: Value = serde_json::from_str(captured.as_str())
        .map_err(|_| fetch_err("页面结构变化：__NEXT_DATA__ 不是合法 JSON"))?;

    let entries = data
        .pointer("/props/pageProps/timeline/entries")
        .and_then(|v| v.as_array())
        .ok_or_else(|| fetch_err("页面结构变化：timeline.entries 缺失"))?;

    let mut seen = std::collections::HashSet::new();
    let mut tweets = Vec::new();
    for entry in entries {
        let raw = entry.pointer("/content/tweet");
        let Some(raw) = raw else { continue };
        if let Some(tweet) = normalize_timeline_tweet(raw) {
            if seen.insert(tweet.id.clone()) {
                tweets.push(tweet);
            }
        }
    }
    tweets.sort_by_key(|t| t.created_ts);
    Ok(tweets)
}

pub async fn fetch_timeline(client: &reqwest::Client, handle: &str) -> Result<Vec<Tweet>, FetchError> {
    let ts = chrono::Utc::now().timestamp_millis();
    let url = format!(
        "https://syndication.twitter.com/srv/timeline-profile/screen-name/{handle}?ts={ts}"
    );
    let res = client
        .get(&url)
        .header("user-agent", UA)
        .header("accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| fetch_err(e.to_string()))?;

    if res.status().as_u16() == 429 {
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let mut message = String::from("HTTP 429（触发限流");
        if retry_after > 0 {
            message.push_str(&format!("，{retry_after}s 后重试"));
        }
        message.push('）');
        return Err(FetchError {
            message,
            retry_after,
        });
    }
    if !res.status().is_success() {
        return Err(fetch_err(format!("HTTP {}", res.status().as_u16())));
    }

    let html = res.text().await.map_err(|e| fetch_err(e.to_string()))?;
    parse_timeline_html(&html)
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::new();
    while n > 0 {
        let digit = (n % 36) as u32;
        buf.push(std::char::from_digit(digit, 36).unwrap());
        n /= 36;
    }
    buf.iter().rev().collect()
}

pub fn syndication_token(id: &str) -> String {
    let value = id.parse::<f64>().unwrap_or(0.0) / 1e15 * std::f64::consts::PI;
    let mut out = to_base36(value.trunc() as u64);
    out.push('.');
    let mut frac = value.fract();
    for _ in 0..20 {
        frac *= 36.0;
        let digit = frac.trunc().clamp(0.0, 35.0) as u32;
        frac -= digit as f64;
        out.push(std::char::from_digit(digit, 36).unwrap());
    }
    out.replace(['0', '.'], "")
}

pub async fn fetch_tweet_with_related(
    client: &reqwest::Client,
    id: &str,
    handle: &str,
) -> Result<(Tweet, Vec<Tweet>), FetchError> {
    let token = syndication_token(id);
    let url = format!("https://cdn.syndication.twimg.com/tweet-result?id={id}&token={token}");
    let res = client
        .get(&url)
        .header("user-agent", UA)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| fetch_err(e.to_string()))?;
    if !res.status().is_success() {
        return Err(fetch_err(format!("单推 HTTP {}", res.status().as_u16())));
    }
    let data: Value = res.json().await.map_err(|e| fetch_err(e.to_string()))?;
    let tweet = normalize_detail_tweet(&data).ok_or_else(|| fetch_err("单推空响应"))?;

    let mut related = Vec::new();
    let target = handle.to_lowercase();
    let in_reply_to = data
        .get("in_reply_to_screen_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    if in_reply_to == target {
        if let Some(parent) = data.get("parent") {
            let mut parent = parent.clone();
            if let Some(obj) = parent.as_object_mut() {
                if !obj.contains_key("user") {
                    if let Some(user) = data.get("user") {
                        obj.insert("user".to_string(), user.clone());
                    }
                }
            }
            if let Some(tweet) = normalize_detail_tweet(&parent) {
                related.push(tweet);
            }
        }
    }
    Ok((tweet, related))
}

/* ── 公开主页抓 ID（免登录，本环境可拿实时数据） ────────── */

pub fn extract_profile_ids(html: &str, max_age_days: i64) -> Vec<String> {
    let mut set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for caps in regex::Regex::new(r#"rest_id:"(\d{15,20})""#)
        .unwrap()
        .captures_iter(html)
    {
        set.insert(caps[1].to_string());
    }
    for caps in regex::Regex::new(r"status/(\d{15,20})")
        .unwrap()
        .captures_iter(html)
    {
        set.insert(caps[1].to_string());
    }

    let now = now_ms();
    let cutoff = now - max_age_days * 24 * 3600 * 1000;
    let mut items: Vec<(i64, String)> = set
        .into_iter()
        .filter_map(|id| {
            id.parse::<u64>()
                .ok()
                .map(|n| (((n >> 22) as i64) + 1_288_834_974_657, id))
        })
        .filter(|(ts, _)| *ts > cutoff && *ts < now + 3600 * 1000)
        .collect();
    items.sort_by(|a, b| b.0.cmp(&a.0));
    items.into_iter().map(|(_, id)| id).collect()
}

pub fn extract_profile_user_id(html: &str) -> String {
    regex::Regex::new(r#"__typename:"User",rest_id:"(\d{15,20})""#)
        .unwrap()
        .captures(html)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

pub async fn fetch_profile(
    client: &reqwest::Client,
    handle: &str,
) -> Result<(Vec<String>, String), String> {
    let url = format!("https://x.com/{handle}?t={}", now_ms());
    let res = client
        .get(&url)
        .header("user-agent", UA)
        .header("accept", "text/html")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("主页 HTTP {}", res.status().as_u16()));
    }
    let html = res.text().await.map_err(|e| e.to_string())?;
    Ok((extract_profile_ids(&html, 30), extract_profile_user_id(&html)))
}

/* ── 搜索发现 ───────────────────────────────────────────── */

pub fn extract_status_ids(text: &str, handle: &str) -> Vec<String> {
    let decoded = regex::Regex::new(r#"uddg=([^&"'\\]+)"#)
        .unwrap()
        .replace_all(text, |caps: &regex::Captures| {
            percent_encoding::percent_decode_str(&caps[1])
                .decode_utf8_lossy()
                .to_string()
        })
        .into_owned();

    let pattern = format!(r"(?i)(?:x|twitter)\.com/{}/status/(\d{{15,20}})", regex::escape(handle));
    let re = regex::Regex::new(&pattern).unwrap();
    let mut ids: Vec<String> = Vec::new();
    for caps in re.captures_iter(&decoded) {
        let id = caps[1].to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.sort();
    ids.reverse();
    ids
}

const PROVIDERS: [&str; 4] = [
    "search.brave.com",
    "html.duckduckgo.com",
    "lite.duckduckgo.com",
    "unrollnow.com",
];

const PROVIDER_COOLDOWN_MS: i64 = 10 * 60 * 1000;

struct ProviderState {
    cooldown_until: i64,
    last_used: i64,
}

pub struct Discovery {
    states: Mutex<HashMap<&'static str, ProviderState>>,
    cursor: AtomicUsize,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn build_query(index: usize, handle: &str) -> (String, Option<&'static str>) {
    match index % 4 {
        0 => (format!("site:x.com/{handle}/status"), Some("fresh")),
        1 => (format!("site:x.com/{handle}/status"), None),
        2 => (format!("site:x.com/{handle}/status reset"), Some("fresh")),
        _ => (format!("site:x.com/{handle}/status reset"), None),
    }
}

fn provider_url(name: &str, handle: &str, query: &str, variant: Option<&str>) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let encoded = utf8_percent_encode(query, NON_ALPHANUMERIC).to_string();
    match name {
        "search.brave.com" => {
            let suffix = if variant == Some("fresh") { "&tf=pd" } else { "" };
            format!("https://search.brave.com/search?q={encoded}{suffix}")
        }
        "html.duckduckgo.com" => {
            let suffix = if variant == Some("fresh") { "&df=d" } else { "" };
            format!("https://html.duckduckgo.com/html/?q={encoded}{suffix}")
        }
        "lite.duckduckgo.com" => {
            let suffix = if variant == Some("fresh") { "&df=d" } else { "" };
            format!("https://lite.duckduckgo.com/lite/?q={encoded}{suffix}")
        }
        _ => format!("https://www.unrollnow.com/{handle}"),
    }
}

impl Discovery {
    pub fn new() -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
            cursor: AtomicUsize::new(0),
        }
    }

    /// 返回 (ids, 成功来源, 是否真正发起过请求)
    pub async fn discover(
        &self,
        client: &reqwest::Client,
        handle: &str,
    ) -> (Vec<String>, Option<String>, bool) {
        let index = self.cursor.fetch_add(1, Ordering::SeqCst);
        let (query, variant) = build_query(index, handle);

        let mut order: Vec<(&'static str, i64)> = {
            let mut states = self.states.lock().unwrap();
            PROVIDERS
                .iter()
                .filter_map(|name| {
                    let entry = states
                        .entry(name)
                        .or_insert(ProviderState {
                            cooldown_until: 0,
                            last_used: 0,
                        });
                    if entry.cooldown_until <= now_ms() {
                        Some((*name, entry.last_used))
                    } else {
                        None
                    }
                })
                .collect()
        };
        order.sort_by_key(|(_, last_used)| *last_used);

        let mut attempted = false;
        for (name, _) in order {
            attempted = true;
            let url = provider_url(name, handle, &query, variant);
            let result = client
                .get(&url)
                .header("user-agent", UA)
                .header("accept", "text/html")
                .header("accept-language", "en-US,en;q=0.9")
                .send()
                .await;

            let found = match result {
                Ok(res) if res.status().is_success() => match res.text().await {
                    Ok(body) => extract_status_ids(&body, handle),
                    Err(_) => Vec::new(),
                },
                _ => Vec::new(),
            };

            let mut states = self.states.lock().unwrap();
            let entry = states.entry(name).or_insert(ProviderState {
                cooldown_until: 0,
                last_used: 0,
            });
            if !found.is_empty() {
                entry.cooldown_until = 0;
                entry.last_used = now_ms();
                return (found, Some(name.to_string()), attempted);
            }
            entry.cooldown_until = now_ms() + PROVIDER_COOLDOWN_MS;
        }

        (Vec::new(), None, attempted)
    }
}
