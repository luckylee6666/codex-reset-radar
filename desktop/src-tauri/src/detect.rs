use regex::Regex;
use serde::Serialize;
use serde_json::json;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
pub struct Signal {
    pub id: String,
    pub label: String,
    pub weight: f64,
    #[serde(rename = "match")]
    pub match_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub is_reset: bool,
    pub score: f64,
    pub raw_score: f64,
    pub signals: Vec<Signal>,
}

struct Rule {
    id: &'static str,
    label: &'static str,
    re: Regex,
}

fn rules() -> &'static Vec<Rule> {
    static CELL: OnceLock<Vec<Rule>> = OnceLock::new();
    CELL.get_or_init(|| {
        let build = |id, label, pattern: &str| Rule {
            id,
            label,
            re: Regex::new(pattern).expect("valid rule regex"),
        };
        vec![
            build(
                "veto-tech",
                "技术语境（git / 设备 / 会话等）",
                r"(?i)\b(?:git|hard|factory|password|passcode|session|device|router|browser|computer|machine)\s*(?:-|\s)?reset(?:s|ting)?\b",
            ),
            build(
                "veto-object",
                "非限额对象（密码 / 设置 / 配置等）",
                r"(?i)\breset\s+(?:\w+\s+){0,4}(?:password|passcode|settings?|preferences|config(?:uration)?|profile|device|phone|computer|console|account|api\s*key)s?\b",
            ),
            build(
                "veto-software",
                "代码 / 会话语境",
                r"(?i)\breset(?:ting)?\s+(?:the\s+)?(?:repo(?:sitory)?|branch|code|conversation|chat|thread|context)\b",
            ),
            build(
                "veto-schedule",
                "未来 / 周期表述（非即时重置）",
                r"(?i)\b(?:will|won't|would|should)\s+(?:be\s+)?reset\b|\bresets?\s+(?:in|every|each)\s+\d|\bresets?\s+(?:every|each)\b",
            ),
            build(
                "veto-when",
                "说明性表述（何时重置 / 查看状态）",
                r"(?i)\bwhen\s+(?:\w+\s+){0,5}?reset(?:s|ting)?\b|\b(?:see|check|view|show(?:s|ing)?)\s+(?:when|if)\b[^.!?\n]{0,40}reset",
            ),
            build(
                "veto-completion",
                "重置完成 / 推送状态（非公告）",
                r"(?i)\bresets?\b(?:\s+\w+){0,3}\s+(?:propagated|rolled\s+out|deployed)\b",
            ),
        ]
    })
}

fn regexes() -> &'static (Regex, Regex, Regex, Regex, Regex, Regex) {
    static CELL: OnceLock<(Regex, Regex, Regex, Regex, Regex, Regex)> = OnceLock::new();
    CELL.get_or_init(|| {
        (
            Regex::new(r"(?i)\b(?:rate\s*limits?|usage\s*limits?|message\s*limits?|request\s*limits?|limits?|quota|credits?|allowance|capacity|usage)\b").unwrap(),
            Regex::new(r"(?i)\b(?:reset(?:s|ting|ted|ing|ed)?|refill(?:ed|ing)?|replenish(?:ed|ing)?|restore(?:d)?|topped\s+up)\b").unwrap(),
            Regex::new(r"(?i)\b(?:we|i)(?:'ve|'re|'m|\s+have|\s+are|\s+am)?\s+(?:(?:just|already|now|officially|finally)\s+)*(?:reset(?:ting|ing)?|refill(?:ed|ing)?|replenished|restored)\b").unwrap(),
            Regex::new(r"(?i)\bcodex\b").unwrap(),
            Regex::new(r"(?i)\b(?:5h|5-hour|five-hour|weekly|daily|hourly|hours?)\b").unwrap(),
            Regex::new(r"(?i)(?:^|[\n.!?]\s*)(?:a|the|all|another|full|big|quick)?\s*reset(?:s|ting|ing)?\b").unwrap(),
        )
    })
}

const PROXIMITY_CHARS: usize = 60;

fn push_signal(signals: &mut Vec<Signal>, id: &str, label: &str, weight: f64, match_text: &str) {
    signals.push(Signal {
        id: id.to_string(),
        label: label.to_string(),
        weight,
        match_text: match_text.chars().take(80).collect(),
    });
}

pub fn detect_reset(text: &str, extra_keywords: &[String], threshold: f64) -> Detection {
    let (limit_re, reset_re, announce_re, codex_re, window_re, standalone_re) = regexes();
    let mut signals: Vec<Signal> = Vec::new();

    let limit_matches: Vec<(usize, String)> = limit_re
        .find_iter(text)
        .map(|m| (m.start(), m.as_str().to_string()))
        .collect();
    let reset_matches: Vec<(usize, String)> = reset_re
        .find_iter(text)
        .map(|m| (m.start(), m.as_str().to_string()))
        .collect();

    'proximity: for a in &limit_matches {
        for b in &reset_matches {
            let (left, right) = if a.0 <= b.0 { (a, b) } else { (b, a) };
            let left_end = left.0 + left.1.len();
            if right.0 >= left_end && right.0 - left_end <= PROXIMITY_CHARS {
                push_signal(
                    &mut signals,
                    "limit-reset-proximity",
                    "限额与重置相邻出现",
                    3.0,
                    &format!("{} … {}", left.1, right.1),
                );
                break 'proximity;
            }
        }
    }

    if let Some(m) = announce_re.find(text) {
        push_signal(&mut signals, "announce", "第一人称公告语气", 2.0, m.as_str());
    }

    if let Some(m) = Regex::new(r"(?i)\bbanked\s+resets?\b|\bcredit\s+(?:\w+\s+){0,10}?resets?\b")
        .unwrap()
        .find(text)
    {
        push_signal(&mut signals, "banked-reset", "存入/发放重置额度", 3.0, m.as_str());
    }

    if let Some(m) = standalone_re.find(text) {
        push_signal(&mut signals, "standalone-reset", "句首独立重置公告口吻", 3.0, m.as_str().trim());
    }

    if codex_re.is_match(text) {
        push_signal(&mut signals, "codex-context", "提及 Codex", 1.0, "codex");
    }

    if !signals.is_empty() {
        if let Some(m) = window_re.find(text) {
            push_signal(&mut signals, "window-context", "提及限额窗口", 1.0, m.as_str());
        }
    }

    for keyword in extra_keywords {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            continue;
        }
        if text.to_lowercase().contains(&keyword.to_lowercase()) {
            push_signal(&mut signals, "custom-keyword", &format!("自定义关键词：{keyword}"), 3.0, keyword);
        }
    }

    for rule in rules() {
        if let Some(m) = rule.re.find(text) {
            push_signal(&mut signals, rule.id, rule.label, -6.0, m.as_str());
        }
    }

    let raw_score: f64 = signals.iter().map(|s| s.weight).sum();
    let score = raw_score.max(0.0);
    Detection {
        is_reset: score >= threshold,
        score,
        raw_score,
        signals,
    }
}

pub fn rule_info() -> serde_json::Value {
    json!({
        "thresholdDefault": 3,
        "positive": [
            { "id": "limit-reset-proximity", "label": "限额词与重置词在 60 字符内相邻出现", "weight": 3 },
            { "id": "announce", "label": "第一人称公告语气（we/I + reset）", "weight": 2 },
            { "id": "banked-reset", "label": "存入 / 发放重置额度（banked reset）", "weight": 3 },
            { "id": "standalone-reset", "label": "句首独立重置口吻（Reset all… / A reset…）", "weight": 3 },
            { "id": "codex-context", "label": "提及 Codex", "weight": 1 },
            { "id": "window-context", "label": "提及限额窗口（5h / weekly…）", "weight": 1 },
            { "id": "custom-keyword", "label": "自定义关键词命中", "weight": 3 }
        ],
        "negative": [
            { "id": "veto-tech", "label": "技术语境（git / 设备 / 会话等）", "weight": -6 },
            { "id": "veto-object", "label": "非限额对象（密码 / 设置 / 配置等）", "weight": -6 },
            { "id": "veto-software", "label": "代码 / 会话语境", "weight": -6 },
            { "id": "veto-schedule", "label": "未来 / 周期表述（非即时重置）", "weight": -6 },
            { "id": "veto-when", "label": "说明性表述（何时重置 / 查看状态）", "weight": -6 },
            { "id": "veto-completion", "label": "重置完成 / 推送状态（非公告）", "weight": -6 }
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_reset(text: &str) -> bool {
        detect_reset(text, &[], 3.0).is_reset
    }

    #[test]
    fn positives() {
        let cases = [
            "We've reset the Codex rate limits for all users. Enjoy!",
            "Codex limits reset! Go wild.",
            "Rate limits have been reset.",
            "We just reset usage limits — thanks for your patience.",
            "Refilled everyone's Codex usage for the weekend.",
            "Resetting the 5h limits shortly, hang tight.",
            "During the day we will credit every Codex and ChatGPT Work user with a BANKED reset.",
            "Hi Astra users. A reset and a quick update on quality issues.",
            "We are reseting usage for all paid users of Codex and ChatGPT Work.",
        ];
        for text in cases {
            assert!(is_reset(text), "应触发：{text}");
        }
    }

    #[test]
    fn negatives() {
        let cases = [
            "git reset --hard HEAD",
            "Don't forget to reset your password",
            "We reset the staging environment and redeployed.",
            "Codex CLI v0.52 is out. Lots of polish.",
            "Your limits will reset at 3pm.",
            "Limits reset every 5 hours automatically.",
            "We raised the Codex usage limits this week.",
            "Click the reset button in settings.",
            "I just reset my local Codex config.",
            "The 5h window resets in 2 hours.",
            "Upgrade to the latest Codex CLI version to see when limits reset by typing /status.",
            "Update. I have decided to take a break from x to recharge a bit.",
            "I feel Theo is in need of a reset 👀",
            "Codex ✅ Almost 100% reliable ✅ Occasional resets ✅ Open-source",
            "Here you are! Thinking I am about to announce a reset. But no.",
            "Reset all propagated. Sweet dreams.",
            "The reset is fully propagated now, all systems green.",
        ];
        for text in cases {
            assert!(!is_reset(text), "不应触发：{text}");
        }
    }

    #[test]
    fn custom_keyword() {
        let detection = detect_reset("Big news: the refill wave is here", &["refill wave".into()], 3.0);
        assert!(detection.is_reset);
    }
}
