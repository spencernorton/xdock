<h1 align="center">XDock</h1>

<p align="center">
  <strong>A dock and app launcher for GNOME Shell.</strong><br>
  The NorviOS dock: your apps and windows on a dock at the edge of the screen, and a compact launcher with search, drawers and system actions.
</p>

<p align="center">
  <a href="https://github.com/spencernorton/norvi-os"><img alt="Part of NorviOS" src="https://img.shields.io/badge/NorviOS-component-FD8024.svg"></a>
  <a href="https://github.com/spencernorton/xdock/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/spencernorton/xdock/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/spencernorton/xdock/tags"><img alt="Latest release" src="https://img.shields.io/github/v/tag/spencernorton/xdock?label=release&sort=semver"></a>
  <a href="#install"><img alt="Install for GNOME Shell" src="https://img.shields.io/badge/install-GNOME%20Shell-4a86cf.svg"></a>
  <a href="COPYING"><img alt="Licence" src="https://img.shields.io/badge/licence-GPL--2.0--or--later-blue.svg"></a>
  <a href="https://buy.stripe.com/8x26oH2U44f65TRe574wM04"><img alt="Donate" src="https://img.shields.io/badge/donate-Stripe-635bff.svg?logo=stripe&logoColor=white"></a>
</p>

<p align="center"><picture><source media="(prefers-reduced-motion: reduce)" srcset="docs/demos/launcher-still.png"><img src="docs/demos/launcher.gif" alt="Open XDock’s compact launcher, browse applications and search for a note app." width="900"></picture></p>

Recorded in a disposable NorviOS desktop with a demonstration account. [Recording sources and stills](docs/demos/README.md).


XDock moves GNOME's dash out of the overview and onto the desktop, as a dock for launching apps and switching between windows without leaving what you are doing. It is a fork of [Dash to Dock](https://github.com/micheleg/dash-to-dock) by Michele Gaio and its contributors, and keeps its complete history. It is part of the [NorviOS](https://github.com/spencernorton/norvi-os) desktop and supports GNOME Shell 50.

## What it does

**The dock you know from Dash to Dock.** Pinned and running apps with window counts, previews of an app's windows, click, scroll and middle-click actions, intelligent autohide that gets out of the way of your windows, any screen edge, one monitor or all of them, volumes, devices and the trash, and notification badges.

**A launcher that stays small.** Set the Applications button to open the launcher instead of the full-screen overview (in the preferences, *Launchers*, *When the Applications button is clicked*). It is a popup above the dock that opens on your most-used apps, searches as you type, and has an *All Apps* view and your drawers in a sidebar. It works from the keyboard as well as the mouse. The setting is for the button only: Super+A and the overview still open GNOME's own app grid.

**Drawers.** Create a drawer from the sidebar's menu, drag apps onto it, and drag drawers up and down to reorder them; an app's menu takes it out of a drawer again, and a drawer's menu deletes it, after asking. Drawers are GNOME's own app folders, so the ones you make here also appear in the overview's app grid, and folders you made there appear here. The grid leaves out apps pinned to the dock, though, so a drawer that holds only pinned apps is empty there and does not appear; it still shows in the launcher. Folders that come with the system, such as Ubuntu's *System* and *Utilities*, and folders that fill themselves by app category, are left out on purpose, so nothing here can change them.

**System actions at hand.** The launcher shows who is logged in, and has buttons for Settings, for locking the screen, and for a power menu with log out, restart and power off, each following what GNOME allows.

**Motion that reads as one dock.** Icons lift on hover and press in when clicked, hop when an app starts, and bounce every few seconds while an app needs your attention. Showing and hiding the dock reverses smoothly from wherever it is. The animations switch off with GNOME's *Reduce Animation* setting, and GNOME turns them off itself when it draws the screen in software, as in most virtual machines; icons then stay still, and an app that needs attention does not bounce.

**Glass behind the dock.** Where the dock's background is translucent, what is behind it shows through blurred, rounded to the dock's corners. The blur needs [GNOME Rounded Blur](https://github.com/spencernorton/gnome-rounded-blur); without it the dock stays translucent, with no blur. With GNOME's and Ubuntu's own themes the background is opaque until you choose otherwise: in the preferences, under *Appearance*, set *Customize opacity* to *Fixed* and lower *Opacity*. The blur is on by default, with its own switch on the same page, and its strength and brightness are the `dock-blur-sigma` and `dock-blur-brightness` settings.

**Preferences on libadwaita.** The preferences window uses GNOME's current design, in pages for position and size, launchers, behaviour and appearance.

<p align="center"><picture><source media="(prefers-reduced-motion: reduce)" srcset="docs/demos/drawers-still.png"><img src="docs/demos/drawers.gif" alt="Create an application drawer, add an app and open the drawer from the launcher." width="900"></picture></p>

## Install

### GNOME Shell — the release zip

Download `xdock.shell-extension.zip` and `SHA256SUMS.txt` from the [latest release](https://github.com/spencernorton/xdock/releases/latest), then:

```bash
sha256sum --check --ignore-missing SHA256SUMS.txt
gnome-extensions install --force xdock.shell-extension.zip
```

Log out and back in once so GNOME Shell sees the new extension, then enable it:

```bash
gnome-extensions enable xdock@spencercnorton.github.io
```

Turn off Dash to Dock or Ubuntu Dock first if you use one: two docks on the same screen get in each other's way.

### Ubuntu 26.04 — the release package

The same release carries `gnome-shell-extension-xdock_*_all.deb`, which installs the extension for every user and its settings schema and translations system-wide: `sudo apt install ./gnome-shell-extension-xdock_*_all.deb`. Then log out and in, and enable it as above. The package recommends `gnome-rounded-blur`, from the [GNOME Rounded Blur releases](https://github.com/spencernorton/gnome-rounded-blur/releases/latest), which the dock blur needs.

The extension is not on extensions.gnome.org.

## Where your data lives

| Setting | Purpose |
|---|---|
| dconf `/org/gnome/shell/extensions/xdock/` | XDock's own settings |
| dconf `/org/gnome/desktop/app-folders/` | The drawers. These are GNOME's app folders, shared with the overview's app grid |
| dconf `/org/gnome/shell/favorite-apps` | The apps pinned to the dock. This is GNOME's own list, shared with the overview's dash |

XDock opens no network connections. The launcher ranks apps by GNOME's own usage statistics and reads your name and picture from GNOME's accounts service; neither leaves the machine.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): one entry per release
- [NOTICE](NOTICE): provenance, artwork and licences

## Contributing and support

- Bugs and feature requests: [open an issue](https://github.com/spencernorton/xdock/issues/new/choose). Questions: [Discussions](https://github.com/spencernorton/xdock/discussions).
- Security reports: [private vulnerability reporting](https://github.com/spencernorton/xdock/security/advisories/new). See [SECURITY.md](SECURITY.md). There is no e-mail address; that is deliberate.
- Pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first. Changes are reviewed and merged on GitHub, then shipped in tagged releases.
- If this saves you time, you can [support its development](https://buy.stripe.com/8x26oH2U44f65TRe574wM04).

## Development

```bash
make verify REQUIRE_GJS=1           # ESLint, the Node and GJS tests, schemas and translations
make _build && tests/shell/idle-frames.sh _build
                                    # a headless GNOME Shell 50: a still screen paints nothing
make install                        # build and install into ~/.local/share/gnome-shell/extensions
scripts/build.sh                    # the release zip and .deb, into dist/
```

Building needs `sassc`, `gettext` and `glib-compile-schemas`; the checks also need Node.js, GJS and ESLint 9. The dock builds on GNOME Shell's dash, overview and popup-menu modules, which are not a stable API, so each new GNOME Shell major version needs a check before it is added to `metadata.json`.

## Licence

[GPL-2.0-or-later](COPYING), as Dash to Dock is.

XDock is based on [Dash to Dock](https://github.com/micheleg/dash-to-dock) at `248d42b`, whose history this repository keeps unchanged. The changes since then are © 2026 Spencer Norton; see [NOTICE](NOTICE).
