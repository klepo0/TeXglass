# Notes for Claude

- Never bump versions in a pull request (`vscode/package.json`, its lock file,
  or anything else). Versions change only in the Release workflow; see
  [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).
- Test builds: `node browser/build.js` and `npm run package:dev` (in `vscode/`)
  name files `<version>-dev.<commit>`; hand those out, not release-named files.
