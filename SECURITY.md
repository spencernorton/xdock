# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/spencernorton/xdock/security/advisories/new)**.
Do not open a public issue, and do not include real credentials or personal
paths in the report — a description and a minimal reproduction are enough.

There is no e-mail address for security reports; the advisory form is the
only channel, and it is the one that is monitored. You will get an
acknowledgement within a week. Fixes ship as a tagged release; the advisory
is published once the release is out, and credits you unless you ask
otherwise.

## Supported versions

Only the latest tagged release is supported.

## What the extension does

- It runs inside GNOME Shell and draws the dock and the launcher. It starts
  the apps you click, and runs the session actions you choose through GNOME
  Shell: locking at once, and logging out, restarting and powering off after
  GNOME's own confirmation. To find the app that opens a volume or the trash
  shown on the dock, it runs a short-lived helper of its own,
  `locationsWorker.js`.
- It stores its settings in dconf, and edits two GNOME settings on your
  behalf: the pinned apps (`org.gnome.shell favorite-apps`) and the app
  folders it shows as drawers (`org.gnome.desktop.app-folders`).
- It reads GNOME's app usage statistics and your account's name and picture
  to show in the launcher; they stay on the machine.
- It opens no network connections and handles no credentials.
