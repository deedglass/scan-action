# Changelog

## v1.0.0 (2026-10-17)

The first tagged release. Runs deedglass 0.1.0 by default: 0.1.1 has no GitHub release yet, and
the action can only run a version whose checksums are committed here. v1.0.1 moves the default to
0.1.1 once that release and `checksums/0.1.1.txt` exist.

- The footer says what leaves the runner: scan data is never sent to Deedglass; on a private repo
  with a licence, each run activates the licence with Dodo Payments and deedglass.com, then
  deactivates it.
- Private repositories: the run frees the licence activation it takes (`deedglass licence
  deactivate`, every time, even when the check failed), so runs don't use up the key's 3
  activations. The job summary says why there's no comment: no licence, no `action_private`, or an
  activation that failed (with the CLI's error code).
- The comment reads "Reported by this PR's run. This comment is information only and never blocks a
  merge." When the scan job's own check failed (for example on `fail-under`), the comment says that
  check can block a merge. The comment job turns every error into a warning and never fails.
- Every field in the comment is escaped or typed: no HTML, links, mentions or issue references
  from the scan result. Control, bidi, zero-width, filler, variation-selector and tag characters are
  dropped.
- No new comment when the scan matches the base. Once a comment exists, each later run for the
  pull request's current head edits it, to that run's numbers or to say the run had no result; a run
  for an older push never edits it.
- The sticky comment and the changed files are read past the first page of the API.
- Inputs are checked before the download: `dir` must be relative to the repository root (no leading
  `/` or `~`, no `..`), `fail-under` takes A to D, `sarif` takes auto, always or never.
- `checksums/0.1.0.txt` holds the sha256 of the four Linux and macOS archives.
- Fixed: the scan wrote its report into a directory that didn't exist yet, so it never produced one.
- From v1.0.0, the README on `main` pins this action to a release's full commit sha with a `# v1`
  comment. The README inside the v1.0.0 tag uses `@v1`, because a commit can't name its own sha.
- CI: `npm test`, and the action run on its own pull request.
