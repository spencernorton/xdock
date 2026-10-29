#!/usr/bin/env bash
# Sourced by the private compositor's parent; wait must run in that parent.
finish_shell() {
    local result=$1 compositor=$2 status_file=$3 status=0
    trap - EXIT
    kill "$compositor" 2>/dev/null || true
    wait "$compositor" || status=$?
    printf '%s\n' "$status" > "$status_file"
    case "$status" in
        0|143) exit "$result" ;;
        *) echo "Compositor exited unexpectedly: $status" >&2; exit "$status" ;;
    esac
}
