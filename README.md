# Deedglass scan

Grades the agent setup in your repository on every pull request: the **agent blast radius**, A to
F, with its deductions. It runs `deedglass scan` on the runner, read-only.

**What leaves the runner.** Scan data is never sent to Deedglass. Results go only to GitHub: the
job summary, code scanning (SARIF), one workflow artifact kept for 3 days, and one comment on the
pull request. On a private repository with a licence set, the licence is checked with Dodo Payments
and deedglass.com; nothing from the scan goes with it. On a public repository the licence is never
used. The action comments only on pull requests in the repository that installed it.

A means a small blast radius, not a safe agent. What the grade measures: https://deedglass.com/score

## Use it

Add two workflows to `.github/workflows/` (full copies in [`examples/`](examples/)). Pin this
action to a full commit sha, as below, and let Dependabot move it; the comment names the tag.

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
  API, and posts **one** comment, edited on each push. It never checks out pull request code.

## The comment

A comment appears only when the pull request changes agent config and the scan differs from the
base. Agent config is `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`**/claude_desktop_config.json`, `**/mcp_config.json`, `package.json`, `pyproject.toml`,
`requirements*.txt`, `deedglass.yaml` or `policies/**`. A pull request that changes none of these, or
whose grade, counts and findings all match the base, gets no comment. If an earlier push left a
comment, it is edited to the current numbers, so it never shows a stale grade.

The comment reads "Reported by this PR's run": a fork's pull request runs its own scan job, so the
numbers are what that run reported. The comment is information only. Its job turns every error into
a warning and never fails, so it can't block a merge. The scan job fails only when you set
`fail-under` and the grade is below it, or when the scan itself can't run.

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `version` | `0.1.0` | the deedglass release to run; its sha256 must be in `checksums/` |
| `licence` | `''` | a Pro licence, only for comments on private repositories (pass a secret); checked with Dodo Payments and deedglass.com, and only on a private repository |
| `fail-under` | `''` | fail when the grade is below this (A to D); empty never fails on the grade |
| `sarif` | `auto` | `auto`, `always` or `never` |
| `dir` | `.` | the directory to scan |

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
licence with `action_private`, checked by the CLI's own licence code (`deedglass licence activate`
asks Dodo Payments and deedglass.com). Known, accepted risk: a forged `entitled: true` in the
artifact gets a private repository one free comment.

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
3. Tag `v1.x.y` and move `v1` to it. Then point the pinned sha in this README and `examples/` at
   that commit. Publishing to the Marketplace is the founder's.

See [CHANGELOG.md](CHANGELOG.md). Apache-2.0.
