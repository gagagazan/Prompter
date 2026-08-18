// Prompter is a desktop GUI in both development and release builds. Without
// this attribute debug builds open an unrelated console window on Windows.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    prompter_lib::run()
}
