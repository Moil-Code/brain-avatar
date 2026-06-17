use std::process::Command;

fn main() {
    // Compile the neural TTS helper (speak-helper.swift) into the Tauri sidecar
    // location: binaries/speak-helper-<target-triple>. If swiftc isn't available
    // the app falls back to `say` at runtime, so a failure here is non-fatal.
    println!("cargo:rerun-if-changed=speak-helper.swift");
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "aarch64-apple-darwin".into());
    let _ = std::fs::create_dir_all("binaries");
    let out = format!("binaries/speak-helper-{triple}");
    match Command::new("swiftc")
        .args(["-O", "speak-helper.swift", "-o", &out])
        .status()
    {
        Ok(s) if s.success() => {}
        other => println!(
            "cargo:warning=speak-helper compile failed ({other:?}); TTS will fall back to `say`"
        ),
    }

    tauri_build::build()
}
