# Contributing

Contributions are welcome: bug reports, papers that render badly, fixes and new
features.

## How to contribute

1. **Report a problem.** [Open an issue](https://github.com/klepo0/TeXglass/issues/new/choose).
   For a paper that renders badly, give its arXiv id. Please don't post
   unpublished work.
2. **Send a change.** Fork the repository, make your change on a branch, run
   `npm test`, and open a pull request against `main`. Keep each pull request
   to one change; for anything large, open an issue first so we can agree on
   the approach.
3. **Sign the CLA.** On your first pull request a bot asks you to sign the
   [Contributor License Agreement](CLA.md) by posting a comment. You keep the
   copyright in your work. The agreement lets TeXglass offer your contribution
   under both its [noncommercial license](LICENSE) and separate commercial
   licenses, which is how the project is funded. You sign once, and it covers
   all your later contributions. The maintainer's own pull requests skip the
   CLA, so they leave out that line of the pull request template.

The maintainer reviews every pull request before merging. Workflows on pull
requests from first-time contributors run only after approval.

## Where the code is

The converter is `src/texglass.js`, dependency-free and shared by the web
viewer, the CLI and the VS Code extension. Diagrams live in `src/tikz.js` and
`src/diagrams.js`, editing aids in `src/editor.js`, HTML export in
`src/export.js`. `npm start` serves the web viewer (a static page, no build
step) and `npm test` runs the tests. The render dashboard is described in
[dashboard/README.md](dashboard/README.md).

The VS Code extension in `vscode/` uses the same converter and stylesheet;
`npm run copy-shared` copies them into `vscode/shared/` (packaging and
`npm test` do it too). Press F5 with `vscode/` open in VS Code to try changes.
`npm run build-web` bundles the github.dev/vscode.dev version into
`vscode/dist/web.js`, and `npm run test-web` opens it in VS Code for the Web
with `test/fixtures/web` as the workspace.

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

TeXglass has **two version numbers**, each with its own release workflow:

- the `"version"` in `vscode/package.json`, for the VS Code extension; the
  **Release** workflow gives the npm package (the root `package.json`) the
  same one;
- the `"version"` in `browser/package.json`, for the browser extension
  (`browser/build.js` reads it from there); only the **Browser release**
  workflow moves it.

**Pull requests don't change either version.** Not in `vscode/package.json`,
not in `vscode/package-lock.json`, not in `browser/package.json`, not anywhere
else. That way parallel pull requests never conflict over version numbers.
Describe the change in the pull request title; the release notes are generated
from those titles.

### Releasing the VS Code extension

From GitHub, no local clone needed:

1. Open **Actions → Release → Run workflow** on `main`.
2. Pick **minor** (new features, the usual choice), **patch** (fixes only) or
   **major**.

The workflow raises the version, runs the tests, builds the `.vsix`, then
pushes a `Release vX.Y.Z` commit to `main` with the `vX.Y.Z` tag, creates the
GitHub release and publishes to the VS Code Marketplace (and Open VSX when its
token is set). If anything fails before the push, nothing changes on `main`;
fix it and run the workflow again.

Fallback from a clone: change the version in `vscode/package.json` in its own
commit on `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The same
workflow runs on the tag.

### Releasing the browser extension

1. Open **Actions → Browser release → Run workflow** on `main`.
2. Pick **minor**, **patch** or **major**, as above.

The workflow raises the version in `browser/package.json`, runs the tests,
builds the Chrome and Firefox zips, then pushes a `Browser extension: release
X.Y.Z` commit to `main` with the `browser-vX.Y.Z` tag, creates the GitHub
release *TeXglass for arXiv X.Y.Z* with both zips (not marked as the latest
release, which stays the VS Code extension's) and sends the Firefox build to
Firefox Add-ons (when its key is set).

Firefox Add-ons (addons.mozilla.org) gets each release as a new listed
version of the add-on `texglass-arxiv@klepo0.github.io` (the ID in
`browser/build.js`; never change it), together with a zip of the repository
source and build notes for Mozilla's reviewers. The workflow doesn't wait for
the review; the version goes live once Mozilla approves it. It needs two
secrets, and skips this step without them:

1. Sign in at <https://addons.mozilla.org/developers/addon/api/key/> with the
   account that owns the add-on and press **Generate new credentials**.
2. In the repository, open **Settings → Secrets and variables → Actions → New
   repository secret** and add `AMO_JWT_ISSUER` (the "JWT issuer", like
   `user:12345:67`) and `AMO_JWT_SECRET` (the "JWT secret").

Fallback from a clone: change the version in `browser/package.json` in its own
commit on `main`, then `git tag browser-vX.Y.Z && git push origin
browser-vX.Y.Z`.

### Pushing to protected `main`

`main` is protected, and the workflows' built-in token can't bypass that, so
both release workflows push their release commit with the deploy key in the
`RELEASE_DEPLOY_KEY` secret. That key must have write access and be on the
bypass list of the `main` ruleset.

### Test builds

Test builds keep the current version and add the commit to the file name, so
they can't be confused with a release:

- Browser extension: `node browser/build.js` writes
  `browser/dist/texglass-arxiv-{chrome,firefox}-<version>-dev.<commit>.zip`.
  Chrome shows the same label on `chrome://extensions`.
- VS Code extension: `npm run package:dev` inside `vscode/` writes
  `vscode/texglass-<version>-dev.<commit>.vsix`.

The release workflows build with `node browser/build.js --release` (Browser
release) and `vsce package` (Release) for the clean names.
