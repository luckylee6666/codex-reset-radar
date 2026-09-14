use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

const OCR_SWIFT: &str = include_str!("../../../src/ocr.swift");

enum OcrStatus {
    Unknown,
    Ready(PathBuf),
    Unavailable(String),
}

fn state() -> &'static Mutex<OcrStatus> {
    static CELL: OnceLock<Mutex<OcrStatus>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(OcrStatus::Unknown))
}

pub fn supported() -> bool {
    cfg!(target_os = "macos")
}

/// 按需编译 Swift OCR 助手并缓存（热编译 <1s）
pub async fn ensure_binary(data_dir: &Path) -> Result<PathBuf, String> {
    if !supported() {
        return Err("OCR 仅支持 macOS".into());
    }

    {
        let guard = state().lock().unwrap();
        match &*guard {
            OcrStatus::Ready(path) if path.is_file() => return Ok(path.clone()),
            OcrStatus::Unavailable(message) => return Err(message.clone()),
            _ => {}
        }
    }

    let bin = data_dir.join("radar-ocr");
    if bin.is_file() {
        *state().lock().unwrap() = OcrStatus::Ready(bin.clone());
        return Ok(bin);
    }

    let source_path = data_dir.join("radar-ocr.swift");
    std::fs::write(&source_path, OCR_SWIFT).map_err(|e| e.to_string())?;

    let output = tokio::process::Command::new("swiftc")
        .args(["-O", "-o"])
        .arg(&bin)
        .arg(&source_path)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await;

    match output {
        Ok(result) if result.status.success() && bin.is_file() => {
            *state().lock().unwrap() = OcrStatus::Ready(bin.clone());
            Ok(bin)
        }
        Ok(result) => {
            let message = format!(
                "OCR 助手编译失败（需要 Xcode Command Line Tools）：{}",
                String::from_utf8_lossy(&result.stderr).lines().next().unwrap_or("")
            );
            *state().lock().unwrap() = OcrStatus::Unavailable(message.clone());
            Err(message)
        }
        Err(err) => {
            let message = format!("需要 Xcode Command Line Tools 才能启用图片 OCR：{err}");
            *state().lock().unwrap() = OcrStatus::Unavailable(message.clone());
            Err(message)
        }
    }
}

pub async fn ocr_image(data_dir: &Path, image_path: &Path) -> Result<String, String> {
    let bin = ensure_binary(data_dir).await?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new(&bin)
            .arg(image_path)
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "OCR 超时".to_string())?
    .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "OCR 失败：{}",
            String::from_utf8_lossy(&output.stderr).lines().next().unwrap_or("")
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub async fn download_image(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let res = client
        .get(url)
        .header("referer", "https://x.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("图片过大".into());
    }
    std::fs::write(dest, &bytes).map_err(|e| e.to_string())
}

pub fn pick_image_url(media: &serde_json::Value) -> Option<String> {
    let items = media.as_array()?;
    for item in items {
        let url = item.get("url").and_then(|v| v.as_str())?;
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let looks_like_image = kind == "photo"
            || url.ends_with(".jpg")
            || url.ends_with(".jpeg")
            || url.ends_with(".png")
            || url.ends_with(".webp");
        if looks_like_image {
            return Some(url.to_string());
        }
    }
    None
}

pub fn combined_text(text: &str, ocr_text: Option<&str>) -> String {
    match ocr_text {
        Some(ocr) if !ocr.is_empty() => format!("{text}\n[图片文字] {ocr}"),
        _ => text.to_string(),
    }
}
