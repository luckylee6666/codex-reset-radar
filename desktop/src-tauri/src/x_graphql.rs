use crate::config::Config;
use crate::fetch::{decode_entities, iso_and_ts, Media, Tweet};
use serde_json::{json, Value};
use std::time::Duration;

/// X 公开的 web bearer（固定常量，不是密钥）
const BEARER: &str =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/// UserTweets 的 operation id 会周期性轮换，按顺序尝试
const DEFAULT_QUERY_IDS: [&str; 5] = [
    "E3opETHurmVJflFsUBVuUQ",
    "HuTx74BxAnezK1gWvYY7zg",
    "V7H0Ap3_Hh2FyS75OCDO3Q",
    "QqZBEqganhHwmU9QscwObA",
    "6b1Z9nYPuD9WcRIDtEwSFw",
];

const USER_BY_NAME_QUERY_IDS: [&str; 4] = [
    "G3KGOASz96M-Qu0nwmGXNg",
    "sLVLhk0bGj3MVFEKTdax1w",
    "qW5u-DAuXpMEG0nnrzv_KQ",
    "1VOOyvKkiI3FMmkeDNxM9A",
];

fn features() -> Value {
    json!({
        "rweb_video_screen_enabled": false,
        "rweb_cashtags_enabled": true,
        "profile_label_improvements_pcf_label_in_post_enabled": true,
        "responsive_web_graphql_timeline_navigation_enabled": true,
        "verified_phone_label_enabled": false,
        "creator_subscriptions_tweet_preview_api_enabled": true,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
        "premium_content_api_read_enabled": false,
        "communities_web_enable_tweet_community_results_fetch": true,
        "c9s_tweet_anatomy_moderator_badge_enabled": true,
        "responsive_web_grok_analyze_button_fetch_trends_enabled": false,
        "responsive_web_grok_analyze_post_followups_enabled": false,
        "responsive_web_jetfuel_frame": false,
        "responsive_web_grok_share_attachment_enabled": true,
        "articles_preview_enabled": true,
        "responsive_web_edit_tweet_api_enabled": true,
        "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
        "view_counts_everywhere_api_enabled": true,
        "longform_notetweets_consumption_enabled": true,
        "responsive_web_twitter_article_tweet_consumption_enabled": true,
        "tweet_awards_web_tipping_enabled": false,
        "creator_subscriptions_quote_tweet_preview_enabled": false,
        "freedom_of_speech_not_reach_fetch_enabled": true,
        "standardized_nudges_misinfo": true,
        "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
        "rweb_video_timestamps_enabled": true,
        "longform_notetweets_rich_text_read_enabled": true,
        "longform_notetweets_inline_media_enabled": true,
        "responsive_web_enhance_cards_enabled": false
    })
}

pub fn is_configured(config: &Config) -> bool {
    !config.x_auth_token.is_empty() && !config.x_ct0.is_empty()
}

fn apply_auth(request: reqwest::RequestBuilder, config: &Config) -> reqwest::RequestBuilder {
    request
        .header("authorization", format!("Bearer {BEARER}"))
        .header("x-csrf-token", config.x_ct0.clone())
        .header(
            "cookie",
            format!("auth_token={}; ct0={}", config.x_auth_token, config.x_ct0),
        )
        .header("x-twitter-auth-type", "OAuth2Session")
        .header("x-twitter-active-user", "yes")
        .header("x-twitter-client-language", "en")
        .header("referer", "https://x.com/")
        .header(
            "user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
}

fn normalize_graphql_tweet(legacy: &Value, user: Option<&Value>) -> Option<Tweet> {
    let id = legacy.get("id_str").and_then(|v| v.as_str())?;
    let raw_date = legacy
        .get("created_at")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let (created_at, created_ts) = iso_and_ts(raw_date);
    let handle = user
        .and_then(|u| u.get("screen_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("i");

    let media: Vec<Media> = legacy
        .get("extended_entities")
        .and_then(|e| e.get("media"))
        .or_else(|| legacy.get("entities").and_then(|e| e.get("media")))
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
                        kind: item
                            .get("type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("photo")
                            .to_string(),
                        url: url.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(Tweet {
        id: id.to_string(),
        created_at,
        created_ts,
        text: decode_entities(
            legacy
                .get("full_text")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ),
        favorite_count: legacy.get("favorite_count").and_then(|v| v.as_i64()).unwrap_or(0),
        reply_count: legacy.get("reply_count").and_then(|v| v.as_i64()).unwrap_or(0),
        retweet_count: legacy.get("retweet_count").and_then(|v| v.as_i64()).unwrap_or(0),
        quote_count: legacy.get("quote_count").and_then(|v| v.as_i64()).unwrap_or(0),
        permalink: format!("https://x.com/{handle}/status/{id}"),
        avatar: user
            .and_then(|u| u.get("profile_image_url_https"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        author_name: user
            .and_then(|u| u.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        author_handle: user
            .and_then(|u| u.get("screen_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        lang: legacy.get("lang").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        media,
    })
}

pub fn parse_user_tweets_response(data: &Value) -> Vec<Tweet> {
    let instructions = data
        .pointer("/data/user/result/timeline_v2/timeline/instructions")
        .or_else(|| data.pointer("/data/user/result/timeline/instructions"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut tweets = Vec::new();
    for instruction in instructions {
        let Some(entries) = instruction.get("entries").and_then(|v| v.as_array()) else {
            continue;
        };
        for entry in entries {
            let Some(result) = entry.pointer("/content/itemContent/tweet_results/result") else {
                continue;
            };
            let result = result.get("tweet").unwrap_or(result);
            let Some(legacy) = result.get("legacy") else { continue };
            let user = result
                .pointer("/core/user_results/result/legacy")
                .or_else(|| result.pointer("/core/user_results/result"));
            if let Some(tweet) = normalize_graphql_tweet(legacy, user) {
                tweets.push(tweet);
            }
        }
    }
    tweets
}

pub async fn fetch_user_tweets(
    client: &reqwest::Client,
    config: &Config,
    user_id: &str,
) -> Result<Vec<Tweet>, String> {
    if !is_configured(config) {
        return Err("未配置 X Cookie".into());
    }

    let variables = json!({
        "userId": user_id,
        "count": 20,
        "includePromotedContent": false,
        "withQuickPromoteEligibilityTweetFields": true,
        "withVoice": true,
        "withV2Timeline": true,
    });
    let params = format!(
        "variables={}&features={}",
        percent_encoding::utf8_percent_encode(
            &serde_json::to_string(&variables).unwrap_or_default(),
            percent_encoding::NON_ALPHANUMERIC
        ),
        percent_encoding::utf8_percent_encode(
            &serde_json::to_string(&features()).unwrap_or_default(),
            percent_encoding::NON_ALPHANUMERIC
        ),
    );

    let mut query_ids: Vec<String> = Vec::new();
    if !config.x_user_tweets_query_id.is_empty() {
        query_ids.push(config.x_user_tweets_query_id.clone());
    }
    query_ids.extend(DEFAULT_QUERY_IDS.iter().map(|s| s.to_string()));

    let mut last_error = "GraphQL 全部 queryId 失败".to_string();
    for query_id in query_ids {
        let url = format!("https://x.com/i/api/graphql/{query_id}/UserTweets?{params}");
        let request = apply_auth(client.get(&url), config);
        let response = tokio::time::timeout(Duration::from_secs(15), request.send())
            .await
            .map_err(|_| "GraphQL 超时".to_string())?
            .map_err(|e| e.to_string())?;

        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("Cookie 无效或已过期（HTTP {}）", status.as_u16()));
        }
        if !status.is_success() {
            last_error = format!("HTTP {}", status.as_u16());
            continue;
        }

        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        if data.get("data").is_none() {
            last_error = data
                .pointer("/errors/0/message")
                .and_then(|v| v.as_str())
                .unwrap_or("GraphQL 错误")
                .to_string();
            continue;
        }
        let tweets = parse_user_tweets_response(&data);
        if !tweets.is_empty() {
            return Ok(tweets);
        }
        last_error = "响应为空".into();
    }
    Err(last_error)
}

pub async fn resolve_user_id(
    client: &reqwest::Client,
    config: &Config,
    handle: &str,
) -> Result<String, String> {
    if !is_configured(config) {
        return Err("未配置 X Cookie".into());
    }
    let params = format!(
        "variables={}",
        percent_encoding::utf8_percent_encode(
            &serde_json::to_string(&json!({ "screen_name": handle, "withSafetyModeUserFields": true }))
                .unwrap_or_default(),
            percent_encoding::NON_ALPHANUMERIC
        ),
    );

    let mut last_error = "UserByScreenName 全部 queryId 失败".to_string();
    for query_id in USER_BY_NAME_QUERY_IDS {
        let url = format!("https://x.com/i/api/graphql/{query_id}/UserByScreenName?{params}");
        let response = tokio::time::timeout(
            Duration::from_secs(15),
            apply_auth(client.get(&url), config).send(),
        )
        .await
        .map_err(|_| "GraphQL 超时".to_string())?
        .map_err(|e| e.to_string())?;

        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("Cookie 无效或已过期（HTTP {}）", status.as_u16()));
        }
        if !status.is_success() {
            last_error = format!("HTTP {}", status.as_u16());
            continue;
        }
        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        if let Some(id) = data.pointer("/data/user/result/rest_id").and_then(|v| v.as_str()) {
            return Ok(id.to_string());
        }
        last_error = data
            .pointer("/errors/0/message")
            .and_then(|v| v.as_str())
            .unwrap_or("响应为空")
            .to_string();
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_graphql_timeline() {
        let data = json!({
            "data": { "user": { "result": { "timeline_v2": { "timeline": { "instructions": [
                { "entries": [
                    {
                        "content": { "itemContent": { "tweet_results": { "result": {
                            "legacy": {
                                "id_str": "2099393115241300166",
                                "created_at": "2026-09-14T07:01:38.000Z",
                                "full_text": "Hello &amp; welcome",
                                "favorite_count": 5
                            },
                            "core": { "user_results": { "result": { "legacy": {
                                "screen_name": "thsottiaux", "name": "Tibo",
                                "profile_image_url_https": "https://pbs.twimg.com/a.jpg"
                            } } } }
                        } } } }
                    }
                ] }
            ] } } } } }
        });
        let tweets = parse_user_tweets_response(&data);
        assert_eq!(tweets.len(), 1);
        assert_eq!(tweets[0].text, "Hello & welcome");
        assert_eq!(tweets[0].author_handle, "thsottiaux");
        assert_eq!(tweets[0].favorite_count, 5);
    }

    #[test]
    fn requires_both_tokens() {
        let mut config = Config::default();
        assert!(!is_configured(&config));
        config.x_auth_token = "a".into();
        assert!(!is_configured(&config));
        config.x_ct0 = "c".into();
        assert!(is_configured(&config));
    }
}
