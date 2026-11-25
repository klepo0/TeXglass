# Notes for Claude

- Never bump versions in a pull request (`vscode/package.json`, its lock file,
  `browser/package.json` or anything else). Versions change only in the
  Release and Browser release workflows; see
  [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).
- Test builds: `node browser/build.js` and `npm run package:dev` (in `vscode/`)
  name files `<version>-dev.<commit>`; hand those out, not release-named files.
- Any PR that adds, changes or removes a user-visible feature, keyboard
  shortcut, VS Code command or setting must update `docs/GUIDE.md` in the same
  PR (`test/guide.test.js` checks shortcuts, commands and settings). See
  [CONTRIBUTING.md](CONTRIBUTING.md#keep-the-guide-up-to-date).
- Pull requests opened from the owner's account (`klepo0`), including yours,
  don't need the CLA: delete the "Outside contributors only" CLA line from the
  pull request template instead of ticking it.
