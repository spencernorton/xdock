# Performance and Shell compatibility

XDock runs inside GNOME Shell. Its GJS code owns dock behavior, while St and
Clutter own the native widgets, textures and animations. This lets XDock use
the same window, monitor, focus and drag state as the Shell. A standalone
Wayland program would need a new integration for that state, and would add a
process and a communication boundary. Keep the dock in GJS and consider a
native helper only if profiling shows substantial work that can run outside
the compositor.

Keep geometry, ranking and motion calculations testable outside the Shell.
Check assumptions about private Shell behavior at the extension boundary.
Use signals for input and state changes, and tie work that changes each
frame to Clutter's frame clock. Stop animations at rest. Reuse icons and
textures during an interaction, and free the actors for a closed launcher
when the user has stopped working with it.

## What to measure

1. Run `make verify REQUIRE_GJS=1` and the headless Wayland suite from
   [CONTRIBUTING.md](../CONTRIBUTING.md). The native checks exercise launcher
   and drawer interactions, dock reorder, edge dwell, magnification, a still
   screen, and repeated disable and enable on each supported Shell major.
2. Compare the same Shell build with XDock disabled, with the current release,
   and with the candidate. Use the same app catalog, favorites, settings,
   display configuration and idle period. Record settled Shell PSS
   (`/proc/<pid>/smaps_rollup`) and CPU time (`/proc/<pid>/stat`) before and
   after repeated launcher and drawer cycles. Report the range across runs.
   These figures describe the entire Shell, including its caches; also count
   the XDock actors still attached and cached after close.
3. Capture interactive frame timing with [Sysprof](https://github.com/GNOME/sysprof)
   while sweeping the pointer across the dock, scrolling the launcher, and
   opening and closing it. Record the refresh rate, frame time percentiles and
   missed frames. Check on a hardware renderer at 60 Hz and a higher rate,
   including mixed scale monitors and optional rounded blur. A headless
   software renderer can catch incorrect behavior and unnecessary redraws;
   its timings do not establish how smooth the dock is on a physical display.

## Supporting a new GNOME release

Read the [GNOME porting guide](https://gjs.guide/extensions/) and run the
native suite on the new Shell and each supported major. Keep Shell differences
in shared adapters when possible. Verify the extension and preferences,
including reduced motion, and keep `metadata.json`, the Debian package
dependency and the runtime CI matrix in agreement. Check the optional blur
provider separately because it ships its own native library.
