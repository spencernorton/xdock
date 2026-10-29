#!/usr/bin/env bash
# A still screen must not be repainted. Starts a headless GNOME Shell 50 with
# XDock and a probe extension that counts the frames painted while nothing
# changes, and fails if there were any. It runs on a private session bus in a
# throwaway home, so the desktop it is started from is left alone.
#   tests/shell/idle-frames.sh <extension directory or zip>
# e.g. `make _build && tests/shell/idle-frames.sh _build`
set -euo pipefail
extension=$(realpath "$1")
probe=$(cd "$(dirname "$0")" && pwd)/idle-frames@xdock.test
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
export HOME="$home" XDG_CONFIG_HOME="$home/config" XDG_DATA_HOME="$home/data" \
    XDG_CACHE_HOME="$home/cache" XDG_STATE_HOME="$home/state" \
    XDG_RUNTIME_DIR="$home/run" XDG_CURRENT_DESKTOP=GNOME GNOME_SHELL_DEV_HARNESS=1 \
    LIBGL_ALWAYS_SOFTWARE=1
mkdir -m 0700 "$XDG_RUNTIME_DIR"
installed="$XDG_DATA_HOME/gnome-shell/extensions"
mkdir -p "$installed/xdock@spencercnorton.github.io"
if [ -d "$extension" ]; then
    cp -r "$extension/." "$installed/xdock@spencercnorton.github.io/"
else
    unzip -q "$extension" -d "$installed/xdock@spencercnorton.github.io"
fi
cp -r "$probe" "$installed/"
cp "$(dirname "$0")/popup-interactions.js" "$(dirname "$0")/magnify-interactions.js" \
    "$installed/"
# Real desktop entries let Shell's application system populate the launcher;
# no application or data from the host session is used.
mkdir -p "$XDG_DATA_HOME/applications"
for i in $(seq 0 79); do
    number=$(printf '%02d' "$i")
    cat > "$XDG_DATA_HOME/applications/xdock-popup-test-$number.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Popup Test $number
Exec=/usr/bin/true
Icon=applications-utilities-symbolic
Categories=Utility;
ENTRY
done

log="$home/shell.log"
# shellcheck disable=SC2016 # expanded by the inner shell
dbus-run-session -- bash -c '
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    gsettings set org.gnome.shell enabled-extensions \
        "[\"idle-frames@xdock.test\", \"xdock@spencercnorton.github.io\"]"
    G_DEBUG=fatal-criticals gnome-shell --headless --wayland --virtual-monitor 1280x800 > "$1" 2>&1 &
    shell=$!
    for _ in $(seq 180); do
        grep -q "IDLE-FRAMES done" "$1" && break
        kill -0 "$shell" 2>/dev/null || break
        sleep 1
    done
    kill "$shell" 2>/dev/null
    wait
' bash "$log" || true

cat "$log"
if grep -E 'JS ERROR:|-CRITICAL' "$log"; then
    exit 1
fi
if ! grep -q "IDLE-FRAMES done" "$log"; then
    tail -n 40 "$log"
    echo "GNOME Shell did not finish the run" >&2
    exit 1
fi
grep "IDLE-FRAMES" "$log" | sed 's/.*IDLE-FRAMES //'
test "$(grep -c "IDLE-FRAMES result: pass" "$log")" -eq 1
