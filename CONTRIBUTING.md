# Contributing

## Keep the guide up to date

[docs/GUIDE.md](docs/GUIDE.md) describes every user-visible feature, keyboard
shortcut, VS Code command and setting. **A pull request that adds, changes or
removes any of these updates the guide in the same pull request**, and the
README's feature list where it applies. Write keys as `<kbd>Ctrl+G</kbd>`.

`test/guide.test.js` fails when a VS Code keybinding, command or setting, the
browser extension's shortcut, a shortcut named in the toolbar, or a letter key
the code listens for is missing from the guide. It can't see features without a
shortcut, so check those by hand.

## Versions and releases

TeXglass has **one version number**, the `"version"` in `vscode/package.json`.
The VS Code extension and the browser extension both use it
(`browser/build.js` reads it from there).

**Pull requests don't change the version.** Not in `vscode/package.json`, not
in `vscode/package-lock.json`, not anywhere else. That way parallel pull
requests never conflict over version numbers. Describe the change in the pull
request title; the release notes are generated from those titles.

### Releasing

From GitHub, no local clone needed:

1. Open **Actions → Release → Run workflow** on `main`.
2. Pick **minor** (new features, the usual choice), **patch** (fixes only) or
   **major**.

The workflow raises the version, runs the tests, builds the `.vsix` and the
browser extension zips, then pushes a `Release vX.Y.Z` commit to `main` with
the `vX.Y.Z` tag, creates the GitHub release and publishes to the VS Code
Marketplace (and Open VSX when its token is set). If anything fails before the
push, nothing changes on `main`; fix it and run the workflow again.

Fallback from a clone: change the version in `vscode/package.json` in its own
commit on `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The same
workflow runs on the tag.

### Test builds

Test builds keep the current version and add the commit to the file name, so
they can't be confused with a release:

- Browser extension: `node browser/build.js` writes
  `browser/dist/texglass-arxiv-{chrome,firefox}-<version>-dev.<commit>.zip`.
  Chrome shows the same label on `chrome://extensions`.
- VS Code extension: `npm run package:dev` inside `vscode/` writes
  `vscode/texglass-<version>-dev.<commit>.vsix`.

The Release workflow builds with `node browser/build.js --release` and
`vsce package` for the clean names.
