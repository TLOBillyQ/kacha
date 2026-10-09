//! Integration test: exercises the real official updater against a local HTTP
//! endpoint. Lives in `tests/` so the binary links tauri-build's resource.lib
//! (custom Windows manifest with comctl32 v6), which lib test targets skip.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use tauri::Manager;

#[test]
fn official_updater_fetches_selected_endpoint_without_configured_endpoints() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/chosen-descriptor.json", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok((mut stream, _)) = listener.accept() {
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096];
                let n = stream.read(&mut request).unwrap();
                let body = r#"{"version":"99.0.0","notes":"endpoint evidence","platforms":{"windows-x86_64":{"url":"http://127.0.0.1/package.exe","signature":"sig"}}}"#;
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                return String::from_utf8_lossy(&request[..n]).to_string();
            }
            assert!(Instant::now() < deadline, "official updater never requested selected endpoint");
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
        "pubkey": "unused-for-check",
        "dangerousInsecureTransportProtocol": true
    }));
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "test", Default::default()).build().unwrap();
    let metadata = tauri::async_runtime::block_on(kacha_lib::update_check::check(
        window.as_ref().clone(), vec![endpoint], "windows-x86_64".into(),
    )).unwrap().unwrap();
    assert_eq!(metadata.version(), "99.0.0");
    assert_eq!(metadata.body(), Some("endpoint evidence"));
    // This is the exact resource consumed by the official plugin download command.
    assert!(window.resources_table().get::<tauri_plugin_updater::Update>(metadata.rid()).is_ok());
    window.resources_table().close(metadata.rid()).unwrap();
    assert!(server.join().unwrap().starts_with("GET /chosen-descriptor.json HTTP/1.1"));
}
