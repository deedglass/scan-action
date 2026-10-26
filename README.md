# Deedglass scan

[![agent blast radius A](https://img.shields.io/badge/agent%20blast%20radius-A-0F766E)](https://deedglass.com/score)

Grades the agent setup in your repository on every pull request: the **agent blast radius**, A to
F, with its deductions. It runs `deedglass scan` on the runner, read-only. Free on public and private
repositories, with no key and no account.

**What leaves the runner.** Scan data is never sent to Deedglass. Results go only to GitHub: the
job summary, code scanning (SARIF), one workflow artifact kept for 3 days, and one comment on the
pull request. The action comments only on pull requests in the repository that installed it.

A means a small blast radius, not a safe agent. What the grade measures: https://deedglass.com/score

## Quick start

```sh
mkdir -p .github/workflows && cd .github/workflows
curl -fsSLO https://raw.githubusercontent.com/deedglass/scan-action/v1/examples/deedglass-scan.yml
curl -fsSLO https://raw.githubusercontent.com/deedglass/scan-action/v1/examples/deedglass-comment.yml
```

Commit the two files and open a pull request. The job summary has the grade and a badge line for
your README.

## Use it

Add two workflows to `.github/workflows/` (full copies in [`examples/`](examples/)). Pin this
action to the full commit sha of a release, with the tag in a comment (`@<sha> # v1`), and let
Dependabot move it. Each release's notes give the line to copy, and the README on `main` shows it.

```yaml
# .github/workflows/deedglass-scan.yml
name: Deedglass scan
on: [pull_request]
permissions:
  contents: read
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: deedglass/scan-action@0047a3d4402ac9f7f5d7ee2060a0f4a5bdbb115b # v1
```

```yaml
# .github/workflows/deedglass-comment.yml
name: Deedglass comment
on:
  workflow_run:
    workflows: ["Deedglass scan"]
    types: [completed]
permissions: {}
jobs:
  comment:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      actions: read
    steps:
      - uses: deedglass/scan-action/comment@0047a3d4402ac9f7f5d7ee2060a0f4a5bdbb115b # v1
```

- `deedglass-scan.yml` runs on `pull_request` with `contents: read`. It scans the head and the base,
  writes the job summary, uploads SARIF where the token allows, and uploads `result.json` (3 days).
- `deedglass-comment.yml` runs on `workflow_run` after it. It downloads `result.json`, validates it
  strictly, works out the pull request from the event itself, checks the changed files through the
  API, and posts **one** comment, which each later run edits. It never checks out pull request
  code.

## The badge

Every run's job summary ends with a line like this one, for the grade it found:

```markdown
[![agent blast radius A](https://img.shields.io/badge/agent%20blast%20radius-A-0F766E)](https://deedglass.com/score)
```

Paste it in your README. It is a shields.io static badge: the grade is in the URL, so no server
of ours is involved, and you edit the letter when the grade changes. The same line is the `badge`
output. Colours match `deedglass scan --badge`: teal for A and B, neutral for C, amber for D and F.

For a badge that follows the grade, set `badge: true` on a run for your default branch. The action
then writes `.deedglass/score.json` (a shields.io endpoint file holding the grade and nothing else)
into the workspace; it never commits. Commit it in a later step of your own workflow, or run
`deedglass scan --badge` on your machine and commit the file, then use:

```markdown
[![agent blast radius](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F<owner>%2F<repo>%2F<branch>%2F.deedglass%2Fscore.json)](https://deedglass.com/score)
```

shields.io reads your own file from GitHub.

## The comment

Short, and laid out like the CLI: the grade first (`A → D` when it changed), then points, write
paths with no check, and high and medium findings, each as `before → after`. Then what is new (✕
high, ○ medium or lower), what was resolved (✓), and the one thing to fix first.

A new comment appears only when the pull request changes agent config and the scan differs from
the base. Agent config is `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`**/claude_desktop_config.json`, `**/mcp_config.json`, `package.json`, `pyproject.toml`,
`requirements*.txt`, `deedglass.yaml` or `policies/**`. A pull request that changes none of these, or
whose grade, counts and findings all match the base, gets no new comment.

Once a comment exists, each later run for the pull request's current head edits it: to that run's
numbers, or, when the run has no result to show (the scan job stopped before uploading one, or
its result failed validation), to say so. A run for
an older push never edits it. A run whose comment job doesn't run at all, for example one that was
skipped, leaves the comment as it was.

The comment reads "Reported by this PR's run": a fork's pull request runs its own scan job, so the
numbers are what that run reported. The comment is information only. Its job turns every error into
a warning and never fails, so it can't block a merge. The scan job is a separate check, and it can
fail: when you set `fail-under` and the grade is below it (the comment then says so), when an input
is invalid, on a Windows runner, when the download or its sha256 check fails, or when the scan
produces no report.

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `version` | `0.11.0` | the deedglass release to run. The default is the release this action was tested with. You can pin any version listed in `checksums/` (0.1.0 and 0.11.0 today); the archive's sha256 is checked against the line committed there, copied from that release's `checksums.txt`. Any other version is refused before a download |
| `fail-under` | `''` | fail when the grade is below this (A to D); empty never fails on the grade |
| `sarif` | `auto` | `auto`, `always` or `never` |
| `dir` | `.` | the directory to scan, relative to the repository root; a leading `/` or `~`, or `..`, fails the job |
| `badge` | `false` | `true` writes `.deedglass/score.json` into the workspace (never committed) |

Outputs: `grade`, `points`, `base-grade`, `touched`, `badge` (the static badge line).

## Permissions

| Workflow | Trigger | Permissions | Secrets | Checks out PR code |
|---|---|---|---|---|
| scan | `pull_request` | `contents: read` (fork PRs get a read-only token) | none | yes, with `persist-credentials: false` |
| comment | `workflow_run` | `pull-requests: write`, `actions: read` | none | never |

## Forks

A fork's pull request runs the scan with a read-only token and no secrets. Its result reaches the
comment job only as data: at most 256 KiB, closed keys, typed fields, ids by pattern, strings
escaped (no HTML, links, mentions or issue references), paths outside `[A-Za-z0-9._/@ -]` shown as
`…`, links only to deedglass.com/score and the run. The pull request number and the changed files
come from GitHub, not from the artifact.

## Private repositories

The same as public ones: the scan, the job summary and the comment are free, with no secret, key or
account. The action makes no request to Deedglass on any repository.

## What it never does

- `pull_request_target`, or any write from the scan job.
- A comment, issue, pull request or badge in any repository other than this one.
- Telemetry, or sending scan data to Deedglass or anywhere but this repository on GitHub.
- Failing a check or blocking a merge from the comment job.
- Running a deedglass binary whose sha256 isn't committed in this repository.

Windows runners are refused: "Deedglass scan runs on Linux and macOS runners."

## Releasing (maintainers)

1. Copy the release's `checksums.txt` lines for the four Linux and macOS `.tar.gz` archives into
   `checksums/<version>.txt`, match them against the release's asset digests
   (`gh api repos/deedglass/deedglass/releases/tags/v<version> --jq '.assets[].digest'`), test the
   action with it, and set the `version` default in `action.yml`. Keep older files so pins work.
2. `npm test`, `actionlint`, `zizmor .` (one documented suppression, in `examples/`). CI runs
   `npm test` and this action on its own pull request.
3. Tag `v1.x.y` on the release commit and move `v1` to it. Then, in a follow-up commit on `main`,
   pin this README and `examples/` to that commit's sha (a commit can't name its own sha, so the
   tagged README pins the previous release, or uses `@v1` for v1.0.0). Publishing to the
   Marketplace is the founder's.

See [CHANGELOG.md](CHANGELOG.md). Apache-2.0.
