use serde::Serialize;
use tauri::{Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
    raw_json: serde_json::Value,
}

impl Metadata {
    pub fn rid(&self) -> ResourceId {
        self.rid
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn body(&self) -> Option<&str> {
        self.body.as_deref()
    }
}

// The official JS check API cannot override endpoints. Keep its resource protocol,
// but select the release descriptor through the official Rust builder.
pub async fn check<R: Runtime>(
    webview: Webview<R>,
    endpoints: Vec<String>,
    target: String,
) -> Result<Option<Metadata>, String> {
    let endpoints = endpoints
        .iter()
        .map(|endpoint| endpoint.parse().map_err(|e| format!("{e}")))
        .collect::<Result<Vec<_>, String>>()?;
    let updater = webview
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .target(target)
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|update| Metadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}
