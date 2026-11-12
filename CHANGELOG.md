# Changelog

All notable changes to XDock are documented here.

## Unreleased

- Keep the dock magnified while an icon's menu is open, as the macOS Dock does, even when the pointer leaves the dock; the menu opens above the magnified icon, and the dock eases back to rest when the menu closes instead of snapping.
- Leave a removed dock item alone when its pending hover label fires, instead of reaching the destroyed item and logging a critical error.
- Keep the hover label steady over a magnifying icon: it no longer bounces up and down or wobbles sideways, stays centred on the icon and sits on whole pixels.
- Resize the application launcher by dragging its edges. Width snaps to whole columns, the size is kept for the next time it opens and always fits the monitor, Escape abandons a drag, and a double-click on the edge restores the default size.
- Make the application launcher about half its former footprint while keeping readable text and normal-sized app icons.
- Refine native popup easing and continue interrupted open/close animations from their current position.
- Exercise launcher motion, reduced motion and scrolling in the native tests on both supported GNOME Shell versions.

## 2.3.0 — 2026-11-11

- Keep magnified icons moving through fractional positions instead of stepping sideways as their slots resize.
- Keep running-app lights centered beneath their icons during magnification and fit the enlarged row within the dock.
- Capture magnification anchors from the same completed layout when the dock recenters.
- Move floating icons with paint transforms so they can follow the dock within the current frame.
- Add GNOME Shell 51 support and test native interactions on Shell 50 and 51.
- Pace dock magnification with the display and react to pointer movement without polling.
- Ease the dock through running-app changes and restore magnification under a stationary pointer.
- Cut repeated layout work during magnification and keep its motion consistent across refresh rates and dock sizes.
- Reuse drawer rows when the launcher reopens, and release app buttons after the launcher has been closed for three seconds.
- Suspend window overlap tracking in the overview and whenever intelligent hide is off.
- Respect GNOME Shell 51's separate reduced motion preference.
- Fail native acceptance on unexpected compositor exit, including shutdown crashes.
- Test that a pinned app's dock icon redraws when its launcher's icon changes, while the app is running, without a logout.

## 2.2.0 — 2026-10-30

- Keep icons sharp as they magnify by preparing textures for their largest size.
- Scroll the application launcher smoothly with the mouse wheel. Quick turns keep their full distance, and reversing responds immediately.
- Keep touchpad movement direct and respect GNOME's Reduce Animation setting.
- Stop pending scrolling when filtering results, using the scrollbar or keyboard, closing the launcher, or rebuilding its popup.

## 2.1.1 — 2026-10-29

- Stop cancelled trash queries from falling through after dock teardown, ignore
  late results, and close fallback enumerators on cancellation.
- Exercise rapid disable/re-enable with real GIO work in native GNOME CI.

## 2.1.0 — 2026-10-29

- Publish the launcher redraw, drag handoff and optional icon magnification
  improvements from the preview builds below.
- Keep detached dock actors, floating labels and scroll adjustments safe while
  settings rebuild the dock, and ignore D-Bus completions after teardown.
- Require native dock reorder, launcher drops and magnification in the existing
  private GNOME Shell acceptance job, retaining logs on failure.

## 2.1.0~mag1 — 2026-10-14

- Magnify the icons under the pointer, macOS-style: the icon under the pointer grows to twice its size, its neighbours less, and the row widens around the pointer. Off by default; switch it on in the preferences, where the size, reach and response time can also be set.
- Magnified icons, the launch bounce and the attention bounce are painted above the dock, so they rise past its edge instead of being cut off by it.
- The launch bounce is now two hops sized to the icon, and the attention bounce is higher. The running dots stay in the dock.
- An application name rides above its magnified icon and hides when the app is launched.

## 2.0.1~popup1 — 2026-10-10

- Keep launcher blur redraws covering the whole popup when hovering or scrolling, with no continuous redraw while idle.
- Keep invisible redraw helpers out of pointer picking so they cannot intercept dock drops.
- Make launcher-to-dock drag handoff cancel safely and pin applications even when released before the next hover frame.
- Hide floating application names when scrolling or closing the popup, and position each name using its current text size.

## 2.0.0 — 2026-09-30

The first public release, on Dash to Dock at `248d42b`.

- A launcher popup for the Applications button: most-used apps, search as you type, an *All Apps* view, and system actions for Settings, locking, logging out, restarting and powering off. Super+A keeps opening GNOME's app grid.
- Drawers in the launcher's sidebar, stored as GNOME app folders: create, delete (after asking), reorder by dragging, and file apps by dragging them onto a drawer.
- Dock motion: hover lift, press feedback, a hop when an app starts, a bounce for apps that need attention, and a dock slide that reverses from wherever it is. Nothing runs between bounces, so a still screen is not repainted.
- A blur behind the dock where its background is translucent, drawn by XDock itself and rounded to the dock's corners with GNOME Rounded Blur. Without that library the dock is drawn as Dash to Dock draws it, with no blur. The blur is on by default, with a switch in the preferences.
- GNOME Shell 50 only. Dash to Dock also lists 45 to 49; XDock is not tested there, so it does not claim them.
- Preferences rebuilt on libadwaita.
- The UUID is `xdock@spencercnorton.github.io`. The settings schema, `org.gnome.shell.extensions.xdock`, and the gettext domain, `xdock`, are unchanged, so existing settings carry over.
- The About page shows the Dash to Dock logo with the XDock name and Michele Gaio's credit on it.
- Releases carry a zip for `gnome-extensions install` and a Debian package for Ubuntu 26.04, and `make install` installs from a checkout.
