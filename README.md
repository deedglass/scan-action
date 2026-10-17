# Deedglass scan

Grades the agent setup in your repository on every pull request: the **agent blast radius**, A to
F, with its deductions. It runs `deedglass scan` on the runner, read-only.

**What leaves the runner.** Scan data is never sent to Deedglass. Results go only to GitHub: the
job summary, code scanning (SARIF), one workflow artifact kept for 3 days, and one comment on the
pull request. On a private repository with a licence set, each run activates the licence with Dodo
Payments and deedglass.com (the key and a short hash of the runner's hostname; nothing from the
scan), reads its features, then deactivates it with Dodo Payments. On a public repository the
licence is never used. The action comments only on pull requests in the repository that installed
it.

A means a small blast radius, not a safe agent. What the grade measures: https://deedglass.com/score

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
      - uses: deedglass/scan-action@v1
        with:
          licence: ${{ secrets.DEEDGLASS_LICENCE }} # only needed for comments on private repos
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
      - uses: deedglass/scan-action/comment@v1
```

- `deedglass-scan.yml` runs on `pull_request` with `contents: read`. It scans the head and the base,
  writes the job summary, uploads SARIF where the token allows, and uploads `result.json` (3 days).
- `deedglass-comment.yml` runs on `workflow_run` after it. It downloads `result.json`, validates it
  strictly, works out the pull request from the event itself, checks the changed files through the
  API, and posts **one** comment, which each later run edits. It never checks out pull request
  code.

## The comment

A new comment appears only when the pull request changes agent config and the scan differs from
the base. Agent config is `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`**/claude_desktop_config.json`, `**/mcp_config.json`, `package.json`, `pyproject.toml`,
`requirements*.txt`, `deedglass.yaml` or `policies/**`. A pull request that changes none of these, or
whose grade, counts and findings all match the base, gets no new comment.

Once a comment exists, each later run for the pull request's current head edits it: to that run's
numbers, or, when the run has no result to show (the scan job stopped before uploading one, its
result failed validation, or a private repository had no licence for comments), to say so. A run for
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
| `version` | `0.1.0` | the deedglass release to run; its sha256 must be in `checksums/` |
| `licence` | `''` | a Pro licence, only for comments on private repositories (pass a secret); used only on a private repository, where each run activates it with Dodo Payments and deedglass.com, then deactivates it |
| `fail-under` | `''` | fail when the grade is below this (A to D); empty never fails on the grade |
| `sarif` | `auto` | `auto`, `always` or `never` |
| `dir` | `.` | the directory to scan, relative to the repository root; a leading `/` or `~`, or `..`, fails the job |

Outputs: `grade`, `points`, `base-grade`, `touched`.

## Permissions

| Workflow | Trigger | Permissions | Secrets | Checks out PR code |
|---|---|---|---|---|
| scan | `pull_request` | `contents: read` (fork PRs get a read-only token) | none (the licence only on private repos) | yes, with `persist-credentials: false` |
| comment | `workflow_run` | `pull-requests: write`, `actions: read` | none | never |

## Forks

A fork's pull request runs the scan with a read-only token and no secrets. Its result reaches the
comment job only as data: at most 256 KiB, closed keys, typed fields, ids by pattern, strings
escaped (no HTML, links, mentions or issue references), paths outside `[A-Za-z0-9._/@ -]` shown as
`…`, links only to deedglass.com/score and the run. The pull request number and the changed files
come from GitHub, not from the artifact.

## Private repositories

The scan and the job summary are free everywhere. Comments on private repositories need a Pro
licence with `action_private`. The action uses the CLI's own licence code, the same as on a laptop:

1. `deedglass licence activate` registers the runner with Dodo Payments and asks deedglass.com for
   a signed token. This takes one of the key's 3 activations.
2. `deedglass licence show` reads the token offline: is it active, and does it include
   `action_private`?
3. `deedglass licence deactivate` frees the activation at Dodo Payments. It runs every time, even
   when step 1 or 2 failed, and the licence files are then removed from the runner.

So a run holds one activation for a few seconds. With the key active on 3 machines already, step 1
fails and the job summary says so. An activation stays taken if the run is cancelled between steps 1
and 3, if Dodo Payments can't be reached for step 3 (the step log warns), or if deedglass.com fails
after Dodo Payments accepted the key in step 1 (the CLI then has no token to deactivate with). Ask at
deedglass.com/support to free one.

Known, accepted risk: a forged `entitled: true` in the artifact gets a private repository one free
comment.

## What it never does

- `pull_request_target`, or any write from the scan job.
- A comment, issue, pull request or badge in any repository other than this one.
- Telemetry, or sending scan data to Deedglass or anywhere but this repository on GitHub.
- Failing a check or blocking a merge from the comment job.
- Running a deedglass binary whose sha256 isn't committed in this repository.

Windows runners are refused: "Deedglass scan runs on Linux and macOS runners."

## Releasing (maintainers)

1. Copy the release's `checksums.txt` lines for the four `.tar.gz` archives into
   `checksums/<version>.txt`, match them against the release's asset digests, and set the
   `version` default in `action.yml`.
2. `npm test`, `actionlint`, `zizmor .` (one documented suppression, in `examples/`). CI runs
   `npm test` and this action on its own pull request.
3. Tag `v1.x.y` on the release commit and move `v1` to it. Then, in a follow-up commit on `main`,
   pin this README and `examples/` to that commit's sha (a commit can't name its own sha, so the
   tagged README pins the previous release, or uses `@v1` for v1.0.0). Publishing to the
   Marketplace is the founder's.

See [CHANGELOG.md](CHANGELOG.md). Apache-2.0.
