# XDock

XDock is a GNOME Shell dock with an application launcher and optional icon magnification.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code.
- Run `make verify REQUIRE_GJS=1`; native interaction coverage is in `tests/shell/idle-frames.sh` and runs on every supported Shell version in CI.
- Use a topic branch and a pull request into `main`. Public commits must be signed off and contain no private operational details.
- Run native Shell tests only in disposable sessions. Never inject the test harness into an active desktop.
- For motion changes, inspect painted positions across frames, input picking, running indicators, and settled redraws. Clone-to-source alignment alone does not establish smooth motion.
- Read [CHANGELOG.md](CHANGELOG.md) for recent changes.
