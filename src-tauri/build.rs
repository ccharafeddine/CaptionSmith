fn main() {
    // Bake the target triple so the runtime can locate the dev sidecar at
    // src-tauri/binaries/<name>-<triple>. In a bundle the sidecar sits next to
    // the app executable (triple stripped), which is checked first.
    if let Ok(triple) = std::env::var("TARGET") {
        println!("cargo:rustc-env=TARGET_TRIPLE={triple}");
    }
    tauri_build::build()
}
