//! 脱敏规则（沿 v1 `sanitize.py`）：日志写入与诊断包导出共用同一套字段名单与字符串清洁。
//!
//! 覆盖 API 密钥与认证头、Bearer 令牌、`sk-` 密钥、http(s) 临时地址与长 base64 数据块（图片内容）。
//! 日志另外整体丢弃提示词类字段；画板文件等「含提示词」的可选条目导出时保留提示词。

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

pub const REDACTED: &str = "[REDACTED]";

static AUTH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)["']?(authorization|proxy-authorization|x-api-key|api[_ -]?key|x-access-token|access-token|auth-token|token|cookie|set-cookie)["']?(?:\s+header)?\s*[:=]\s*["']?(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;}"']+["']?"#,
    )
    .unwrap()
});
static BEARER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bbearer\s+[^\s,;]+").unwrap());
static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"https?://[^\s"']+"#).unwrap());
static SK_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bsk-[A-Za-z0-9_-]{8,}").unwrap());
// regex 不支持环视：前后边界用捕获组保留。
static BASE64_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{64,}={0,2}($|[^A-Za-z0-9+/=])").unwrap());

/// 清洁一段文本：认证信息、网络地址与长数据块整体替换，不保留其内容。
pub fn sanitize_text(text: &str) -> String {
    let s = sanitize_text_keep_urls(text);
    let s = URL_RE.replace_all(&s, "[REDACTED_URL]");
    BASE64_RE.replace_all(&s, "${1}[REDACTED]${2}").into_owned()
}

fn compact(key: &str) -> String {
    key.chars().filter(|c| !matches!(c, '_' | '-' | ' ')).collect::<String>().to_lowercase()
}

/// 按规范化后的字段名判断是否携带凭据。
pub fn is_sensitive_key(key: &str) -> bool {
    let k = compact(key);
    matches!(k.as_str(), "token" | "secret" | "password")
        || ["authorization", "apikey", "accesstoken", "authtoken", "cookie"].iter().any(|f| k.contains(f))
}

/// 提示词类字段：日志里整体不写。
pub fn is_prompt_key(key: &str) -> bool {
    let k = compact(key);
    k.contains("prompt") || k == "sendtext" || k == "text"
}

/// 递归清洁结构化值：凭据字段整体替换，字符串再过一次文本清洁。
pub fn redact_value(value: &Value, key: &str) -> Value {
    if is_sensitive_key(key) {
        return Value::String(REDACTED.into());
    }
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), redact_value(v, k))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|v| redact_value(v, key)).collect()),
        Value::String(s) => Value::String(sanitize_text(s)),
        other => other.clone(),
    }
}

/// 日志字段：先丢提示词类字段，其余按 `redact_value` 清洁。
pub fn redact_log_fields(fields: &Map<String, Value>) -> Map<String, Value> {
    fn strip(value: &Value, key: &str) -> Value {
        if is_prompt_key(key) {
            return Value::String(REDACTED.into());
        }
        match value {
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), strip(v, k))).collect()),
            Value::Array(items) => Value::Array(items.iter().map(|v| strip(v, key)).collect()),
            other => other.clone(),
        }
    }
    fields.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), redact_value(&strip(v, k), k))).collect()
}

/// 诊断包里的 settings.json：保留网关地址（去掉其中可能的用户名口令），其余字段照常脱敏。
pub fn redact_settings(text: &str) -> String {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) else {
        return sanitize_text(text);
    };
    let cleaned: Map<String, Value> = map
        .iter()
        .map(|(k, v)| match (k.as_str(), v) {
            ("base_url", Value::String(url)) => (k.clone(), Value::String(strip_userinfo(url))),
            _ => (k.clone(), redact_value(v, k)),
        })
        .collect();
    format!("{}\n", serde_json::to_string_pretty(&Value::Object(cleaned)).unwrap_or_default())
}

fn strip_userinfo(url: &str) -> String {
    static USERINFO_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@").unwrap());
    let s = USERINFO_RE.replace(url, "${1}");
    // 查询串可能带 token：地址只留到路径。
    let s = s.split(['?', '#']).next().unwrap_or_default();
    sanitize_text_keep_urls(s)
}

fn sanitize_text_keep_urls(text: &str) -> String {
    let s = AUTH_RE.replace_all(text, REDACTED);
    let s = SK_KEY_RE.replace_all(&s, REDACTED);
    BEARER_RE.replace_all(&s, "Bearer [REDACTED]").into_owned()
}

/// JSON 文件整体二次脱敏；不是 JSON 时按整段文本清洁。
pub fn redact_json_text(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => format!("{}\n", serde_json::to_string_pretty(&redact_value(&value, "")).unwrap_or_default()),
        Err(_) => sanitize_text(text),
    }
}

/// 日志整份二次脱敏：逐行按 JSON 记录做字段级清洁，非 JSON 残行整行清洁。
pub fn redact_log_text(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let cleaned = match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(map)) => serde_json::to_string(&Value::Object(redact_log_fields(&map))).unwrap_or_default(),
            _ => sanitize_text(line),
        };
        out.push_str(&cleaned);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_redacts_credentials_urls_and_base64() {
        let b64 = "A".repeat(80);
        let text = format!(
            "Authorization: Bearer abc123 x-api-key=sk-abcdefghijkl url https://oss.example.com/a.png?sig=1 data {b64} end"
        );
        let out = sanitize_text(&text);
        assert!(!out.contains("abc123"), "{out}");
        assert!(!out.contains("sk-abcdefghijkl"), "{out}");
        assert!(!out.contains("oss.example.com"), "{out}");
        assert!(!out.contains(&b64), "{out}");
        assert!(out.contains("[REDACTED_URL]") && out.ends_with(" end"), "{out}");
    }

    #[test]
    fn short_words_survive() {
        assert_eq!(sanitize_text("连接超时 status 429"), "连接超时 status 429");
    }

    #[test]
    fn sensitive_keys_are_normalized() {
        for key in ["api_key", "API-Key", "Authorization", "x_access_token", "password", "Set-Cookie"] {
            assert!(is_sensitive_key(key), "{key}");
        }
        for key in ["task_id", "model", "status_code", "board_file"] {
            assert!(!is_sensitive_key(key), "{key}");
        }
    }

    #[test]
    fn value_redaction_is_recursive() {
        let v = json!({"headers": {"Authorization": "Bearer x"}, "items": [{"api_key": "k"}, "https://a/b"], "n": 3});
        assert_eq!(
            redact_value(&v, ""),
            json!({"headers": {"Authorization": REDACTED}, "items": [{"api_key": REDACTED}, "[REDACTED_URL]"], "n": 3})
        );
    }

    #[test]
    fn log_fields_drop_prompts_and_nulls() {
        let fields = json!({"task_id": "t1", "prompt": "一只猫", "negative_prompt": "狗", "extra": {"send_text": "s"}, "category": null});
        let out = redact_log_fields(fields.as_object().unwrap());
        assert_eq!(Value::Object(out), json!({"task_id": "t1", "prompt": REDACTED, "negative_prompt": REDACTED, "extra": {"send_text": REDACTED}}));
    }

    #[test]
    fn settings_keep_gateway_but_not_userinfo_or_secrets() {
        let text = r#"{"format_version":1,"base_url":"http://user:pw@lzxsvn:3001/v1?token=abc","api_key":"sk-abcdefghijkl","concurrency":3}"#;
        let out: Value = serde_json::from_str(&redact_settings(text)).unwrap();
        assert_eq!(out, json!({"format_version": 1, "base_url": "http://lzxsvn:3001/v1", "api_key": REDACTED, "concurrency": 3}));
    }

    #[test]
    fn log_text_redacts_each_line() {
        let text = "{\"event\":\"task\",\"prompt\":\"猫\",\"message\":\"https://x/y\"}\nnot json Bearer abc\n\n";
        assert_eq!(redact_log_text(text), "{\"event\":\"task\",\"message\":\"[REDACTED_URL]\",\"prompt\":\"[REDACTED]\"}\nnot json Bearer [REDACTED]\n");
    }
}
