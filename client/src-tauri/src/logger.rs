//! 脱敏轮转日志（规格第 12 节，容量沿 v1）：最新段 `diagnostics.log`，较早段依次 `.1.log`、`.2.log`…
//!
//! 前端只经 `log_event(kind, fields)` 写入；事件类别白名单、字段脱敏、轮转与容量集中在这里。
//! 写入失败静默降级，不影响应用功能。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::redact;

pub const LOG_FILENAME: &str = "diagnostics.log";
/// 轮转日志总容量上限：512 KB。
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = 512 * 1024;
/// 单段容量上限：256 KB。
pub const DEFAULT_SEGMENT_BYTES: u64 = 256 * 1024;

/// 事件集：v1 四类（task 任务迁移、connection、download、system）+ v2 新增。
/// 任务取消 / 已中断以 task 迁移记（to_status = cancelled / interrupted）。
pub const EVENT_KINDS: &[&str] = &[
    "task",
    "connection",
    "download",
    "system",
    "board_save_failed",
    "relocate",
    "rate_limit",
    "queue_dispatch",
];

fn segment_path(dir: &Path, index: usize) -> PathBuf {
    if index == 0 {
        dir.join(LOG_FILENAME)
    } else {
        dir.join(format!("diagnostics.{index}.log"))
    }
}

/// 最新到最旧的日志段；段号必须连续，出现空洞即停止。记录器与导出共用。
pub fn segment_paths(dir: &Path) -> Vec<PathBuf> {
    (0..).map(|i| segment_path(dir, i)).take_while(|p| p.is_file()).collect()
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// UTC 毫秒时间戳，形如 `2026-09-17T08:00:00.123Z`。
pub fn utc_timestamp(now: SystemTime) -> String {
    let d = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant 的 civil_from_days。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

pub struct Logger {
    dir: PathBuf,
    app_version: String,
    max_total_bytes: u64,
    segment_bytes: u64,
    lock: Mutex<()>,
}

impl Logger {
    pub fn new(dir: PathBuf, app_version: impl Into<String>) -> Self {
        Self::with_capacity(dir, app_version, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_SEGMENT_BYTES)
    }

    pub fn with_capacity(dir: PathBuf, app_version: impl Into<String>, max_total_bytes: u64, segment_bytes: u64) -> Self {
        assert!(segment_bytes > 0 && max_total_bytes >= segment_bytes, "日志容量设置无效");
        Self { dir, app_version: app_version.into(), max_total_bytes, segment_bytes, lock: Mutex::new(()) }
    }

    /// 写一条脱敏日志；未知事件类别拒绝（返回错误，调用方可忽略）。
    pub fn log(&self, kind: &str, fields: &Map<String, Value>) -> Result<(), String> {
        if !EVENT_KINDS.contains(&kind) {
            return Err(format!("未知日志事件：{kind}"));
        }
        let mut record = Map::new();
        record.insert("ts".into(), utc_timestamp(SystemTime::now()).into());
        record.insert("app_version".into(), self.app_version.clone().into());
        record.insert("event".into(), kind.into());
        for (k, v) in redact::redact_log_fields(fields) {
            if !record.contains_key(&k) {
                record.insert(k, v);
            }
        }
        let line = format!("{}\n", Value::Object(record));
        self.write(&line);
        Ok(())
    }

    fn write(&self, line: &str) {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        let current = segment_path(&self.dir, 0);
        if file_size(&current) > 0 && file_size(&current) + line.len() as u64 > self.segment_bytes {
            self.rotate();
        }
        let written = OpenOptions::new().create(true).append(true).open(&current).and_then(|mut f| f.write_all(line.as_bytes()));
        if written.is_ok() {
            self.enforce_capacity();
        }
    }

    /// 现有段整体顺移一段：diagnostics.log → .1 → .2 …
    fn rotate(&self) {
        let count = segment_paths(&self.dir).len();
        for index in (0..count).rev() {
            let _ = fs::rename(segment_path(&self.dir, index), segment_path(&self.dir, index + 1));
        }
    }

    /// 总量超上限时从最旧段删起，最新段永远保留。
    fn enforce_capacity(&self) {
        let segments = segment_paths(&self.dir);
        let mut total: u64 = segments.iter().map(|p| file_size(p)).sum();
        for path in segments.iter().skip(1).rev() {
            if total <= self.max_total_bytes {
                break;
            }
            let size = file_size(path);
            if fs::remove_file(path).is_ok() {
                total -= size;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn lines(dir: &Path) -> Vec<Value> {
        fs::read_to_string(dir.join(LOG_FILENAME)).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn writes_redacted_json_lines() {
        let dir = tempfile::tempdir().unwrap();
        let logger = Logger::new(dir.path().to_path_buf(), "0.2.0");
        logger
            .log("task", &fields(json!({"task_id": "t1", "board_file": "a.ugcboard.json", "prompt": "猫", "message": "Bearer abc", "event": "spoof"})))
            .unwrap();
        let rec = &lines(dir.path())[0];
        assert_eq!(rec["event"], "task");
        assert_eq!(rec["app_version"], "0.2.0");
        assert_eq!(rec["task_id"], "t1");
        assert_eq!(rec["board_file"], "a.ugcboard.json");
        assert_eq!(rec["prompt"], redact::REDACTED);
        assert_eq!(rec["message"], "Bearer [REDACTED]");
        assert!(rec["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn unknown_kind_is_rejected_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let logger = Logger::new(dir.path().to_path_buf(), "0.2.0");
        assert!(logger.log("prompt_dump", &Map::new()).is_err());
        assert!(segment_paths(dir.path()).is_empty());
    }

    #[test]
    fn rotates_and_caps_total_size() {
        let dir = tempfile::tempdir().unwrap();
        let logger = Logger::with_capacity(dir.path().to_path_buf(), "0.2.0", 1000, 400);
        for i in 0..100 {
            logger.log("system", &fields(json!({"message": format!("启动 {i}")}))).unwrap();
        }
        let segments = segment_paths(dir.path());
        assert!(segments.len() >= 2, "{segments:?}");
        assert!(segments.iter().all(|p| file_size(p) <= 400));
        assert!(segments.iter().map(|p| file_size(p)).sum::<u64>() <= 1000);
        // 最新段里是最后写的那条。
        assert!(fs::read_to_string(&segments[0]).unwrap().contains("启动 99"));
    }

    #[test]
    fn timestamp_formats_utc() {
        let t = UNIX_EPOCH + std::time::Duration::from_millis(1_789_632_000_123);
        assert_eq!(utc_timestamp(t), "2026-09-17T08:00:00.123Z");
        assert_eq!(utc_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }
}
