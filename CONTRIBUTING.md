# Contributing to XDock

Thanks for your interest. This is a small project with one maintainer, so the
process is deliberately light.

## How changes land

GitHub is the development home. Branch from `main` and open a pull request
into `main`. The checks must pass before merge. Changes ship in tagged
releases.

Use a GitHub noreply address for commit authorship if you prefer to keep your
personal address private. Public history is public data.

## Working on the code

```bash
make verify REQUIRE_GJS=1           # what CI runs: ESLint, Node and GJS tests, schemas, translations
make _build && tests/shell/idle-frames.sh _build
                                    # also in CI: native popup/dock interaction and still-screen checks in GNOME Shell 50
make install                        # install the checkout into your own extensions directory
scripts/build.sh                    # build the release zip and .deb
```

- Test a change in a real GNOME Shell session, and say which version in the
  pull request. The tests check the dock's bookkeeping, and the headless run
  exercises native dock reordering, launcher drops, hover labels, magnification
  and a still screen. The private session uses 80 synthetic desktop entries;
  normal and immediate drops must work with horizontal and vertical docks.
  Hardware rendering and optional blur-provider integration still need their
  own qualification. Every GNOME
  Shell major version is checked before it is added to `metadata.json`.
- Keep a change to one concern.
- A fix that belongs in Dash to Dock is best sent there first, at
  [micheleg/dash-to-dock](https://github.com/micheleg/dash-to-dock); XDock
  takes it in with upstream's next update.
- Commits carry a `Signed-off-by:` line (`git commit -s`, the Developer
  Certificate of Origin). There is no CLA.
- No secrets, hostnames, personal data or personal paths in the diff; the
  privacy check rejects them.

## Out of scope

- Support for GNOME Shell versions other than the ones in `metadata.json`.
- Features that need a background service or network access.

## Pull request checklist

- [ ] `make verify REQUIRE_GJS=1` passes
- [ ] Tested in GNOME Shell (say which version)
- [ ] Commits are signed off
- [ ] `CHANGELOG.md` updated under `## Unreleased` if behaviour changed
