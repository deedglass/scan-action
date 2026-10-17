# Changelog

## v1.0.0 (unreleased)

The first tagged release. Runs deedglass 0.1.0 by default.

- The footer says what leaves the runner: scan data is never sent to Deedglass; on a private repo
  with a licence, the licence is checked with Dodo Payments and deedglass.com.
- The comment reads "Reported by this PR's run" and is information only: the comment job turns
  every error into a warning, so it never fails and can't block a merge.
- Every field in the comment is escaped or typed: no HTML, links, mentions or issue references
  from the scan result.
- No comment when the scan matches the base. An earlier comment is edited instead of left stale.
- The sticky comment and the changed files are read past the first page of the API.
- `checksums/0.1.0.txt` holds the sha256 of the four Linux and macOS archives.
- Fixed: the scan wrote its report into a directory that didn't exist yet, so it never produced one.
- The README example pins this action to a full commit sha with a `# v1` comment.
- CI: `npm test`, and the action run on its own pull request.
