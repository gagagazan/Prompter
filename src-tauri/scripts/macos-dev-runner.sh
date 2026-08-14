#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "macos-dev-runner: missing executable path" >&2
  exit 64
fi

source_binary=$1
shift

case "$source_binary" in
  /*) ;;
  *) source_binary="$(pwd)/$source_binary" ;;
esac

if [ ! -x "$source_binary" ]; then
  echo "macos-dev-runner: executable not found: $source_binary" >&2
  exit 66
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
binary_dir=$(dirname -- "$source_binary")
app_bundle="$binary_dir/Prompter Dev.app"
contents="$app_bundle/Contents"
app_executable="$contents/MacOS/Prompter"

mkdir -p "$contents/MacOS" "$contents/Resources"
cp -f "$source_binary" "$app_executable"
chmod u+x "$app_executable"
cp -f "$script_dir/../dev/Info.plist" "$contents/Info.plist"
cp -f "$script_dir/../icons/icon.icns" "$contents/Resources/Prompter.icns"
# Refresh LaunchServices after replacing the executable in an already-known
# development bundle; otherwise it can keep a stale executable record.
touch "$app_bundle"
sleep 0.5
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsregister" -f "$app_bundle"

stop_development_app() {
  app_pids=$(/usr/bin/pgrep -f "$app_executable" || true)
  if [ -n "$app_pids" ]; then
    # A Tauri dev restart already terminates the bare executable. Keep that
    # behavior when LaunchServices owns the real app process instead.
    kill -TERM $app_pids 2>/dev/null || true
  fi
}

trap 'stop_development_app; exit 130' HUP INT TERM

# LaunchServices is required here: executing the binary inside the directory
# directly does not register the surrounding bundle as the process identity.
if [ "$#" -gt 0 ]; then
  /usr/bin/open -n -W "$app_bundle" --args "$@"
else
  /usr/bin/open -n -W "$app_bundle"
fi
