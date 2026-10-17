// The workflow_run half (S47 §3.5, ACT-02): never checks out PR code; reads the artifact as hostile
// data; resolves the PR from trusted event data; re-derives touched paths from the API; upserts one
// sticky comment. Every URL is built from GITHUB_REPOSITORY: it can't reach another repository.
// It never fails its job: any error becomes a warning in the log, so it can't block a merge.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { touched as touchedOf } from './paths.mjs';
import { MARKER, nothingChanged, render } from './render.mjs';
import { parseResult } from './validate.mjs';

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PAGE = 100;
const MAX_FILE_PAGES = 30; // GitHub lists at most 3,000 files of a pull request
const MAX_COMMENT_PAGES = 10;

export function api(repo, path) {
  if (!REPO_RE.test(repo)) throw new Error('bad GITHUB_REPOSITORY');
  if (!path.startsWith('/') || path.includes('..') || /^\/\//.test(path)) throw new Error('bad path');
  return `https://api.github.com/repos/${repo}${path}`;
}

/** logSafe makes text safe for one log line: no line breaks, so no workflow command, at most 300. */
export function logSafe(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/%/g, '%25').slice(0, 300);
}

export async function run(env, fetchImpl = fetch) {
  const repo = env.GITHUB_REPOSITORY;
  const gh = async (method, path, body) => {
    const r = await fetchImpl(api(repo, path), {
      method,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'deedglass-scan-action' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  const all = async (path, maxPages) => {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const got = await gh('GET', `${path}?per_page=${PAGE}&page=${page}`);
      if (!Array.isArray(got)) break;
      out.push(...got);
      if (got.length < PAGE) break;
    }
    return out;
  };
  const file = join(env.RUNNER_TEMP ?? '/tmp', 'dg-artifact', 'result.json');
  if (!existsSync(file)) return { done: 'no-artifact' };
  const result = parseResult(readFileSync(file, 'utf8'));

  // 1. The PR, from trusted data only.
  let pr = null;
  let prs = [];
  try { prs = JSON.parse(env.DG_PRS || '[]'); } catch { prs = []; }
  if (Array.isArray(prs) && prs.length === 1 && Number.isInteger(prs[0]?.number) && prs[0].number > 0) pr = prs[0].number;
  if (pr === null) {
    if (!/^[A-Za-z0-9._-]+$/.test(env.DG_HEAD_OWNER ?? '') || !/^[A-Za-z0-9._\/-]+$/.test(env.DG_HEAD_BRANCH ?? '')) return { done: 'no-pr' };
    const list = await gh('GET', `/pulls?state=open&head=${encodeURIComponent(`${env.DG_HEAD_OWNER}:${env.DG_HEAD_BRANCH}`)}&per_page=10`);
    const match = (Array.isArray(list) ? list : []).filter((p) => p?.head?.sha === env.DG_HEAD_SHA);
    if (match.length !== 1 || !Number.isInteger(match[0].number) || match[0].number <= 0) return { done: 'no-pr' };
    pr = match[0].number;
  }
  // 2. Touched paths, from the API (the artifact's own list is ignored).
  const files = await all(`/pulls/${pr}/files`, MAX_FILE_PAGES);
  const touched = touchedOf(files.map((f) => f?.filename));
  // A pull request that doesn't change agent config, or whose scan matches the base, gets no new
  // comment. An earlier comment is still edited, so it never shows a stale grade.
  const quiet = !touched.length ? 'untouched' : nothingChanged(result) ? 'unchanged' : '';
  // A forged entitled: true on a private repo gets one free comment: an accepted, documented risk.
  if (env.DG_PRIVATE === 'true' && !result.entitled) return { done: quiet || 'private-not-entitled', pr };
  // 3. Render and upsert.
  const comments = await all(`/issues/${pr}/comments`, MAX_COMMENT_PAGES);
  const mine = comments.find((c) => c?.user?.login === 'github-actions[bot]' && Number.isInteger(c.id) && typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (quiet && !mine) return { done: quiet, pr };
  const body = render({ ...result, touched }, { runUrl: `https://github.com/${repo}/actions/runs/${env.DG_RUN_ID}` });
  if (mine) {
    await gh('PATCH', `/issues/comments/${mine.id}`, { body });
    return { done: quiet ? `edited-${quiet}` : 'edited', pr };
  }
  await gh('POST', `/issues/${pr}/comments`, { body });
  return { done: 'posted', pr };
}

if (process.argv[1] && process.argv[1].endsWith('comment.mjs')) {
  run(process.env).then(
    (r) => console.log(`✓ ${r.done}${r.pr ? ` · #${r.pr}` : ''}`),
    (e) => console.log(`::warning title=Deedglass scan comment::No comment this time: ${logSafe(e?.message)}`),
  );
}
