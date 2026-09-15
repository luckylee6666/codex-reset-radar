use tauri::AppHandle;

/// macOS 用 osascript 投递通知：Tauri 通知插件底层是已废弃的 NSUserNotification，
/// 在 macOS 26 上会静默失败（show 返回 Ok 但通知中心收不到）；osascript 实测可用。
pub async fn send(
    app: &AppHandle,
    title: &str,
    subtitle: &str,
    body: &str,
    sound: &str,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        send_mac(title, subtitle, body, sound).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let body = if subtitle.is_empty() {
            body.to_string()
        } else {
            format!("{subtitle}\n{body}")
        };
        let mut builder = app.notification().builder().title(title).body(body);
        if !sound.is_empty() {
            builder = builder.sound(sound);
        }
        builder.show().map_err(|err| err.to_string())
    }
}

#[cfg(target_os = "macos")]
async fn send_mac(title: &str, subtitle: &str, body: &str, sound: &str) -> Result<(), String> {
    fn escape(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace(['\n', '\r'], " ")
    }

    let mut script = format!(
        "display notification \"{}\" with title \"{}\"",
        escape(body),
        escape(title)
    );
    if !subtitle.is_empty() {
        script.push_str(&format!(" subtitle \"{}\"", escape(subtitle)));
    }
    if !sound.is_empty() {
        script.push_str(&format!(" sound name \"{}\"", escape(sound)));
    }

    let output = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .map_err(|err| err.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
