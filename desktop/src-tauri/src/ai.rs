use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub is_reset: bool,
    pub confidence: Option<f64>,
    pub reason: String,
    pub engine: String,
}

#[derive(Debug, Clone)]
pub struct AiOptions {
    pub engine: String,
    pub timeout_sec: u64,
    pub ollama_model: String,
    pub http_url: String,
    pub http_key: String,
    pub http_model: String,
    pub http_format: String,
}

impl AiOptions {
    pub fn from_config(config: &crate::config::Config) -> Self {
        Self {
            engine: config.ai_engine.clone(),
            timeout_sec: config.ai_timeout_sec,
            ollama_model: config.ai_ollama_model.clone(),
            http_url: config.ai_http_url.clone(),
            http_key: config.ai_http_key.clone(),
            http_model: config.ai_http_model.clone(),
            http_format: config.ai_http_format.clone(),
        }
    }

    pub fn http_configured(&self) -> bool {
        !self.http_url.is_empty() && !self.http_model.is_empty()
    }
}

const ENGINE_DEFS: [(&str, &str, &[&str]); 3] = [
    (
        "claude",
        "claude",
        &[
            "~/.local/bin/claude",
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            "~\\.local\\bin\\claude.exe",
            "~\\.local\\bin\\claude.cmd",
        ],
    ),
    (
        "codex",
        "codex",
        &[
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "~/.cargo/bin/codex",
            "~\\.cargo\\bin\\codex.exe",
            "~\\AppData\\Roaming\\npm\\codex.cmd",
        ],
    ),
    (
        "ollama",
        "ollama",
        &[
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "~\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
        ],
    ),
];

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~\\") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return PathBuf::from(home).join(rest);
        }
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn resolve_bin(id: &str) -> String {
    if let Some((_, bin, paths)) = ENGINE_DEFS.iter().find(|(eid, _, _)| *eid == id) {
        for candidate in *paths {
            let full = expand_home(candidate);
            if full.is_file() {
                return full.to_string_lossy().to_string();
            }
        }
        return (*bin).to_string();
    }
    id.to_string()
}

/// 从 Finder 启动的 App 继承的工作目录是 `/`，CLI 会把它当成项目根去扫描，
/// 途中读到用户的媒体目录会触发 macOS 媒体库（Apple Music）权限弹窗，
/// 且弹窗归属到本 App（子进程的权限请求算在 responsible process 头上）。
/// 让 CLI 在自己的临时目录里跑，既不弹窗也不必扫整个文件系统。
fn work_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("codex-reset-radar");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// ollama 的 CLI 是客户端，执行任何命令都会拉起本地服务；
/// 这里只用 TCP 探活（无副作用），避免"探测即启动"
pub async fn ollama_running() -> bool {
    tokio::time::timeout(
        Duration::from_millis(400),
        tokio::net::TcpStream::connect(("127.0.0.1", 11434)),
    )
    .await
    .map(|result| result.is_ok())
    .unwrap_or(false)
}

pub async fn list_available_engines(options: &AiOptions) -> Vec<String> {
    let mut found = Vec::new();
    if options.http_configured() {
        found.push("http".to_string());
    }
    for (id, _, _) in ENGINE_DEFS {
        if id == "ollama" {
            if options.engine == "ollama" || ollama_running().await {
                found.push("ollama".to_string());
            }
            continue;
        }
        let bin = resolve_bin(id);
        let run = Command::new(&bin)
            .current_dir(work_dir())
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(8), run).await {
            if output.status.success() {
                found.push(id.to_string());
            }
        }
    }
    found
}

pub fn build_prompt(text: &str) -> String {
    format!(
        r#"你是 Codex 用量监控的判定器。判断下面这条来自受监控账号的推文是否在主动宣布或明确预告一次用量限额重置。重置预告也需要提醒，不要求额度已经到账。

判定 true：
- 明确表示刚刚 / 正在 / 即将重置用量限额（含 "reseting" 等拼写错误）
- 主动承诺或预告某个时间会发放重置（如 "I promised a reset for Tuesday"、"We will reset everyone's limits tomorrow"），即使尚未执行也判 true
- 额度被补充、发放、存入（banked reset / refill）
- 以公告口吻宣布 reset（如 "All reset for everyone"）
- 受监控账号在公告中只写 reset、未重复写 Codex / limits，不因此判 false；仍需排除下列无关语境

判定 false：
- 重置完成后的状态确认（如 "Reset all propagated"、"reset rolled out"）
- 仅解释用户已有额度的自动恢复时间或常规周期（"Your limits will reset at 3pm"、"limits reset every 5 hours"），没有主动安排一次重置
- 只回顾过去的承诺、猜测或询问是否重置，或明确取消 / 否定重置，不构成当前预告
- 玩笑、调侃、非限额语境（"I feel Theo is in need of a reset"）
- 技术重置（git reset、重置密码 / 配置 / 设备）
- 仅提到 reset 一词但没有重置公告含义

示例：
- "Reset all propagated. Sweet dreams." → false（完成确认）
- "Hi Astra users. A reset and a quick update on quality issues." → true
- "We have reset everyone's limits for gpt-5-codex." → true
- "Ladies and gentlemen... start... your... ENGINES. We are almost Tuesday and I promised a reset for Tuesday. Among some other things. See you soon." → true（明确重置预告，尚未发放）
- "We will reset everyone's limits tomorrow." → true（主动安排重置）
- "Your limits will reset at 3pm." → false
- "I promised a reset for Tuesday, but it has been cancelled." → false
- "git reset --hard" → false

如果是尚未执行的明确预告，reason 必须说明「重置预告，尚未发放」，不要声称额度已经到账。

推文：
"""
{text}
"""

只输出 JSON，不要任何其他文字：
{{"is_reset": true 或 false, "confidence": 0 到 1, "reason": "不超过 20 字的中文理由"}}"#
    )
}

pub fn parse_verdict(stdout: &str) -> Option<Verdict> {
    let re = regex::Regex::new(r"(?s)\{.*?\}").ok()?;
    let matched = re.find(stdout)?;
    let data: Value = serde_json::from_str(matched.as_str()).ok()?;
    let is_reset = data.get("is_reset")?.as_bool()?;
    let confidence = data
        .get("confidence")
        .and_then(|v| v.as_f64())
        .map(|v| v.clamp(0.0, 1.0));
    let reason = data
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(80)
        .collect();
    Some(Verdict {
        is_reset,
        confidence,
        reason,
        engine: String::new(),
    })
}

pub fn extract_http_content(data: &Value, format: &str) -> String {
    if format == "anthropic" {
        if let Some(parts) = data.get("content").and_then(|c| c.as_array()) {
            return parts
                .iter()
                .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("");
        }
        return String::new();
    }
    match data.pointer("/choices/0/message/content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| {
                part.as_str()
                    .map(String::from)
                    .or_else(|| part.get("text").and_then(|t| t.as_str()).map(String::from))
                    .unwrap_or_default()
            })
            .collect(),
        _ => String::new(),
    }
}

async fn http_text(
    prompt: &str,
    options: &AiOptions,
    client: &reqwest::Client,
) -> Result<String, String> {
    if !options.http_configured() {
        return Err("http: 未配置地址或模型".into());
    }

    let body = if options.http_format == "anthropic" {
        json!({
            "model": options.http_model,
            "max_tokens": 300,
            "messages": [{ "role": "user", "content": prompt }],
        })
    } else {
        json!({
            "model": options.http_model,
            "temperature": 0,
            "messages": [{ "role": "user", "content": prompt }],
        })
    };

    let mut request = client.post(&options.http_url).json(&body);
    if options.http_format == "anthropic" {
        request = request
            .header("x-api-key", &options.http_key)
            .header("anthropic-version", "2023-06-01");
    } else if !options.http_key.is_empty() {
        request = request.bearer_auth(&options.http_key);
    }

    let response = tokio::time::timeout(Duration::from_secs(options.timeout_sec.max(5)), request.send())
        .await
        .map_err(|_| "http: 超时".to_string())?
        .map_err(|err| format!("http: {err}"))?;

    if !response.status().is_success() {
        return Err(format!("http: HTTP {}", response.status().as_u16()));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|err| format!("http: {err}"))?;
    Ok(extract_http_content(&data, &options.http_format))
}

async fn judge_http(
    prompt: &str,
    options: &AiOptions,
    client: &reqwest::Client,
) -> Result<Verdict, String> {
    let content = http_text(prompt, options, client).await?;
    parse_verdict(&content).ok_or_else(|| "http: 响应无法解析为判定 JSON".to_string())
}

async fn cli_text(id: &str, prompt: &str, options: &AiOptions) -> Result<String, String> {
    let bin = resolve_bin(id);
    let args: Vec<String> = match id {
        "claude" => vec!["-p".into(), prompt.to_string()],
        "codex" => vec!["exec".into(), "--skip-git-repo-check".into(), prompt.to_string()],
        "ollama" => vec![
            "run".into(),
            if options.ollama_model.is_empty() {
                "llama3.2".into()
            } else {
                options.ollama_model.clone()
            },
            prompt.to_string(),
        ],
        _ => return Err(format!("{id}: 未知引擎")),
    };
    let run = Command::new(&bin)
        .current_dir(work_dir())
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match tokio::time::timeout(Duration::from_secs(options.timeout_sec.max(20)), run).await {
        Ok(Ok(output)) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Ok(Ok(output)) => Err(format!("{id}: 退出码 {:?}", output.status.code())),
        Ok(Err(err)) => Err(format!("{id}: {err}")),
        Err(_) => Err(format!("{id}: 超时")),
    }
}

pub fn build_translate_prompt(text: &str) -> String {
    format!(
        r#"把下面的推文翻译成简体中文。要求：
- 只输出译文，不要任何解释、标题或前后缀
- 保留 @用户名、#话题、URL、命令与代码原样
- 专有名词保留英文（Codex、ChatGPT、OpenAI 等）
- 口语、俚语、梗按中文习惯意译

推文：
"""
{text}
"""#
    )
}

fn clean_text(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    if let Some(stripped) = text.strip_prefix("```") {
        let after_lang = stripped.trim_start_matches(|c: char| c.is_ascii_alphabetic());
        text = after_lang.trim_start().to_string();
    }
    if let Some(stripped) = text.strip_suffix("```") {
        text = stripped.trim_end().to_string();
    }
    text
}

/// 翻译推文为简体中文，返回 (译文, 引擎)
pub async fn translate_text(
    text: &str,
    options: &AiOptions,
    client: &reqwest::Client,
) -> Result<(String, String), String> {
    let prompt = build_translate_prompt(text);
    let order: Vec<String> = if options.engine == "auto" {
        let mut list: Vec<String> = Vec::new();
        if options.http_configured() {
            list.push("http".into());
        }
        list.push("claude".into());
        list.push("codex".into());
        if ollama_running().await {
            list.push("ollama".into());
        }
        list
    } else {
        vec![options.engine.clone()]
    };

    let mut errors: Vec<String> = Vec::new();
    for id in order {
        let result: Result<String, String> = if id == "http" {
            http_text(&prompt, options, client).await
        } else {
            cli_text(&id, &prompt, options).await
        };
        match result {
            Ok(raw) => {
                let cleaned = clean_text(&raw);
                if !cleaned.is_empty() {
                    return Ok((cleaned, id));
                }
                errors.push(format!("{id}: 输出为空"));
            }
            Err(err) => errors.push(err),
        }
    }
    Err(errors.join("；"))
}

/// 依次尝试引擎（auto 模式：http → claude → codex → ollama），全部失败返回 Err
pub async fn judge_tweet(
    text: &str,
    options: &AiOptions,
    client: &reqwest::Client,
) -> Result<Verdict, String> {
    let order: Vec<String> = if options.engine == "auto" {
        let mut list: Vec<String> = Vec::new();
        if options.http_configured() {
            list.push("http".into());
        }
        list.push("claude".into());
        list.push("codex".into());
        if ollama_running().await {
            list.push("ollama".into());
        }
        list
    } else {
        vec![options.engine.clone()]
    };
    let prompt = build_prompt(text);
    let mut errors: Vec<String> = Vec::new();

    for id in order {
        if id == "http" {
            match judge_http(&prompt, options, client).await {
                Ok(mut verdict) => {
                    verdict.engine = "http".into();
                    return Ok(verdict);
                }
                Err(err) => {
                    errors.push(err);
                    continue;
                }
            }
        }

        let bin = resolve_bin(&id);
        let args: Vec<String> = match id.as_str() {
            "claude" => vec!["-p".into(), prompt.clone()],
            "codex" => vec!["exec".into(), "--skip-git-repo-check".into(), prompt.clone()],
            "ollama" => vec![
                "run".into(),
                if options.ollama_model.is_empty() {
                    "llama3.2".into()
                } else {
                    options.ollama_model.clone()
                },
                prompt.clone(),
            ],
            _ => continue,
        };

        let run = Command::new(&bin)
            .current_dir(work_dir())
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();

        match tokio::time::timeout(Duration::from_secs(options.timeout_sec.max(20)), run).await {
            Ok(Ok(output)) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                match parse_verdict(&stdout) {
                    Some(mut verdict) => {
                        verdict.engine = id.clone();
                        return Ok(verdict);
                    }
                    None => errors.push(format!("{id}: 输出无法解析")),
                }
            }
            Ok(Ok(output)) => errors.push(format!("{id}: 退出码 {:?}", output.status.code())),
            Ok(Err(err)) => errors.push(format!("{id}: {err}")),
            Err(_) => errors.push(format!("{id}: 超时")),
        }
    }

    Err(if errors.is_empty() {
        "没有可用的 AI 引擎".to_string()
    } else {
        errors.join("；")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_verdict_json() {
        let verdict = parse_verdict(r#"blah {"is_reset": true, "confidence": 0.9, "reason": "公告"} tail"#)
            .expect("parse");
        assert!(verdict.is_reset);
        assert_eq!(verdict.confidence, Some(0.9));
        assert_eq!(verdict.reason, "公告");
        assert!(parse_verdict("no json here").is_none());
    }

    #[test]
    fn extracts_openai_content() {
        let data = json!({ "choices": [{ "message": { "content": "{\"is_reset\": false}" } }] });
        assert_eq!(extract_http_content(&data, "openai"), "{\"is_reset\": false}");

        let parts = json!({ "choices": [{ "message": { "content": [{ "text": "a" }, { "text": "b" }] } }] });
        assert_eq!(extract_http_content(&parts, "openai"), "ab");
    }

    #[test]
    fn extracts_anthropic_content() {
        let data = json!({ "content": [{ "type": "text", "text": "hello " }, { "type": "text", "text": "world" }] });
        assert_eq!(extract_http_content(&data, "anthropic"), "hello world");
    }

    #[test]
    fn prompt_mentions_examples() {
        let prompt = build_prompt("Reset all propagated. Sweet dreams.");
        assert!(prompt.contains("Reset all propagated"));
        assert!(prompt.contains("is_reset"));
    }
}
