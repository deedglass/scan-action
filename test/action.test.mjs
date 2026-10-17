// node --test: the diff, the strict artifact reader, the renderer and the comment upsert on a
// recorded GitHub API fake (S47 §6 Action table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare } from '../src/diff.mjs';
import { parseResult } from '../src/validate.mjs';
import { render, MARKER, esc, nothingChanged, DATA_LINE, PROVENANCE } from '../src/render.mjs';
import { run, api, logSafe } from '../src/comment.mjs';
import { isAgentPath } from '../src/paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const text = (f) => readFileSync(join(root, f), 'utf8');
const ZWSP = '\u200b';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const head = fx('head.json');
const base = fx('base.json');
const good = () => compare(head, base, ['.cursor/mcp.json', 'README.md']);

test('compare: new findings, write paths and touched', () => {
  const r = good();
  assert.equal(r.head.grade, 'D');
  assert.equal(r.base.grade, 'A');
  assert.ok(r.new_findings.some((f) => f.id === 'database_url_in_client_args'));
  assert.deepEqual(r.touched, ['.cursor/mcp.json']);
  parseResult(JSON.stringify(r));
});

test('paths: the agent-config list', () => {
  for (const p of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'x/claude_desktop_config.json', 'a/b/mcp_config.json', 'package.json', 'pyproject.toml', 'requirements-dev.txt', 'deedglass.yaml', 'policies/a.yaml']) assert.ok(isAgentPath(p), p);
  for (const p of ['README.md', 'src/index.ts', 'docs/mcp.md']) assert.ok(!isAgentPath(p), p);
});

test('validate: poisoned artifacts are refused', () => {
  const r = good();
  const bad = [
    { ...r, extra: 1 },
    { ...r, head: { ...r.head, grade: 'E' } },
    { ...r, fix_first: 'x'.repeat(301) },
    { ...r, new_findings: [{ id: 'Bad Id', severity: 'high', title: 't', path: 'p' }] },
    { ...r, entitled: 'yes' },
  ];
  for (const b of bad) assert.throws(() => parseResult(JSON.stringify(b)));
  assert.throws(() => parseResult('x'.repeat(300 * 1024)));
});

test('render: escaped, no HTML but the marker, links only to deedglass.com/score and the run', () => {
  const r = good();
  r.fix_first = '](javascript:alert(1)) <img src=x> @everyone';
  r.new_findings = [{ id: 'database_url_in_client_args', severity: 'medium', title: '<img src=x onerror=1>', path: 'a'.repeat(1000) }];
  const md = render(r, { runUrl: 'https://github.com/acme/agents/actions/runs/42' });
  assert.ok(md.startsWith(MARKER));
  assert.ok(!/(^|[^\\])<img/.test(md));
  assert.ok(!/@everyone/.test(md));
  assert.ok(!/\]\(javascript:/.test(md));
  assert.ok(md.includes('· …'));
  const links = [...md.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(links, ['https://deedglass.com/score', 'https://github.com/acme/agents/actions/runs/42']);
  assert.ok(md.length < 2000);
  assert.equal(esc('a`b'), 'a\\`b');
});

test('api: every URL targets GITHUB_REPOSITORY', () => {
  assert.equal(api('acme/agents', '/issues/1/comments'), 'https://api.github.com/repos/acme/agents/issues/1/comments');
  assert.throws(() => api('acme/agents/../other', '/x'));
  assert.throws(() => api('acme/agents', '/../../other/repo'));
});

function fakeGitHub({ files = ['.cursor/mcp.json'], comments = [], pulls = [] } = {}) {
  const calls = [];
  const state = { comments: [...comments], next: 100 };
  const f = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    assert.ok(url.startsWith('https://api.github.com/repos/acme/agents/'), url);
    const u = new URL(url);
    const ok = (v) => ({ ok: true, status: 200, json: async () => v });
    const page = (v) => {
      const per = Number(u.searchParams.get('per_page') ?? 30);
      const n = Number(u.searchParams.get('page') ?? 1);
      return v.slice((n - 1) * per, n * per);
    };
    if (u.pathname.endsWith('/files')) return ok(page(files.map((filename) => ({ filename }))));
    if (init.method === 'GET' && u.pathname.endsWith('/comments')) return ok(page(state.comments));
    if (init.method === 'GET' && u.pathname.endsWith('/pulls')) return ok(pulls);
    if (init.method === 'POST') { state.comments.push({ id: state.next++, user: { login: 'github-actions[bot]' }, body: JSON.parse(init.body).body }); return ok({}); }
    if (init.method === 'PATCH') { const id = Number(u.pathname.split('/').pop()); state.comments.find((c) => c.id === id).body = JSON.parse(init.body).body; return ok({}); }
    throw new Error('unexpected ' + url);
  };
  return { f, calls, state };
}

function envWith(result, extra = {}) {
  const d = join(tmpdir(), `dgact-${Math.random()}`);
  mkdirSync(join(d, 'dg-artifact'), { recursive: true });
  writeFileSync(join(d, 'dg-artifact', 'result.json'), typeof result === 'string' ? result : JSON.stringify(result));
  return { GITHUB_REPOSITORY: 'acme/agents', GITHUB_TOKEN: 't', RUNNER_TEMP: d, DG_RUN_ID: '42', DG_PRS: JSON.stringify([{ number: 7 }]), DG_PRIVATE: 'false', ...extra };
}

test('comment: posts once, then edits in place (50 pushes, one comment, at most 3 writes per run)', async () => {
  const gh = fakeGitHub();
  assert.equal((await run(envWith(good()), gh.f)).done, 'posted');
  for (let i = 0; i < 50; i++) {
    const before = gh.calls.length;
    assert.equal((await run(envWith(good()), gh.f)).done, 'edited');
    assert.ok(gh.calls.length - before <= 3);
  }
  assert.equal(gh.state.comments.length, 1);
});

test('comment: a README-only PR gets nothing; the artifact\'s own touched list is ignored', async () => {
  const gh = fakeGitHub({ files: ['README.md'] });
  const forged = { ...good(), touched: ['.mcp.json'] };
  assert.equal((await run(envWith(forged), gh.f)).done, 'untouched');
  assert.equal(gh.state.comments.length, 0);
});

test('comment: a fork PR is resolved by owner, branch and sha', async () => {
  const gh = fakeGitHub({ pulls: [{ number: 9, head: { sha: 'abc' } }, { number: 10, head: { sha: 'zzz' } }] });
  const r = await run(envWith(good(), { DG_PRS: '[]', DG_HEAD_OWNER: 'forker', DG_HEAD_BRANCH: 'patch-1', DG_HEAD_SHA: 'abc' }), gh.f);
  assert.deepEqual(r, { done: 'posted', pr: 9 });
  assert.ok(gh.calls[0].includes('head=forker%3Apatch-1'));
});

test('comment: poisoned artifact is refused before any write', async () => {
  const gh = fakeGitHub();
  await assert.rejects(run(envWith('{"v":1,"pwn":true}'), gh.f));
  assert.equal(gh.calls.length, 0);
});

test('comment: private repo without the licence feature gets no comment', async () => {
  const gh = fakeGitHub();
  const r = await run(envWith({ ...good(), entitled: false }, { DG_PRIVATE: 'true' }), gh.f);
  assert.equal(r.done, 'private-not-entitled');
  assert.equal(gh.state.comments.length, 0);
});

// --- ACT-01 and ACT-02 ---

const same = () => compare(head, head, ['.cursor/mcp.json']);

test('render: the footer says what leaves the runner, and the comment says whose numbers these are', () => {
  const md = render(good(), { runUrl: 'https://github.com/acme/agents/actions/runs/42' });
  assert.ok(md.includes(DATA_LINE));
  assert.ok(DATA_LINE.includes('scan data is never sent to Deedglass'));
  assert.ok(DATA_LINE.includes('on a private repo with a licence, the licence is checked with Dodo Payments and deedglass.com'));
  assert.ok(md.includes("Reported by this PR's run"));
  assert.ok(md.includes('it never blocks a merge'));
  assert.ok(md.split('\n').includes(PROVENANCE));
  const summary = render(good(), { comment: false });
  assert.ok(summary.includes(DATA_LINE));
  assert.ok(!summary.includes(MARKER) && !summary.includes(PROVENANCE));
});

test('esc: mentions, references, links, HTML and invisible characters are inert', () => {
  const cases = {
    '@everyone and @acme/security': (o) => !/@[^\u200b]/.test(o),
    'see #12 and acme/other#3 and GH-7': (o) => !/#[0-9]/.test(o) && !/GH-[0-9]/i.test(o),
    'https://evil.example/x and www.evil.example': (o) => !o.includes('://') && !/www\./i.test(o),
    '<img src=x onerror=1> &lt;b&gt;': (o) => !/(^|[^\\])[<>&]/.test(o),
    '[x](javascript:alert(1)) ![i](x) `code` *b* _i_ ~s~ $x$ | {a}': (o) => !/(^|[^\\])[[\]()`*_~$|{}!]/.test(o.replace(/\\./g, '')),
    'a\u202eb\u200bc\u2066d\nline\r\u0000e\u2028f\ufeffg': (o) => o === 'abcdlinee' + 'fg',
  };
  for (const [input, ok] of Object.entries(cases)) assert.ok(ok(esc(input)), `${JSON.stringify(input)} → ${JSON.stringify(esc(input))}`);
  assert.equal(Array.from(esc('x'.repeat(5000))).length, 300);
  assert.equal(esc(undefined), '');
});

test('render: every interpolated field is escaped or typed, even on input that skipped the validator', () => {
  const evil = '@everyone #1 https://evil.example <b>x</b> ](javascript:1) \u202e';
  const r = {
    v: 1, version: evil, entitled: true, fix_first: evil,
    base: { grade: '<b>', points: '100<b>', write_paths: -1, high: 1.5, medium: evil },
    head: { grade: 'A<script>', points: evil, write_paths: {}, high: [], medium: null },
    new_findings: [{ id: 'x', severity: evil, title: evil, path: evil }, null],
    resolved: [{ id: 'x', severity: 'high<b>', title: evil, path: 'p' }],
    new_paths: [evil, 'ok/path.json'],
    touched: [evil, '.mcp.json', 1, 2, 3, 4, 5],
  };
  const md = render(r, { runUrl: 'https://github.com/acme/agents/actions/runs/42' });
  const body = md.replace(MARKER, '').replace(/<\/?sub>/g, '');
  assert.ok(!/(^|[^\\])</.test(body), 'raw <');
  assert.ok(!/@[^\u200b]/.test(md), 'live mention');
  assert.ok(!/#[0-9]/.test(md), 'live reference');
  assert.ok(!md.includes('https://evil'), 'live link');
  assert.ok(!md.includes('\u202e'), 'bidi');
  assert.ok(!/\]\(javascript:/.test(md));
  const links = [...md.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(links, ['https://deedglass.com/score', 'https://github.com/acme/agents/actions/runs/42']);
  assert.ok(md.includes('agent blast radius **?**'));
  assert.ok(md.includes('| Grade | ? · ? | ? · ? |'));
  assert.ok(md.includes('- ? · '));
  assert.ok(md.includes('`.mcp.json`') && md.includes('`ok/path.json`') && md.includes('and 2 more'));
});

test('render: nothingChanged and its line', () => {
  assert.equal(nothingChanged(same()), true);
  assert.equal(nothingChanged(good()), false);
  assert.equal(nothingChanged({ ...same(), base: null }), false);
  assert.ok(render(same()).includes('No change from the base branch.'));
  assert.ok(!render(good()).includes('No change from the base branch.'));
});

test('comment: a PR whose scan matches the base gets no comment', async () => {
  const gh = fakeGitHub();
  assert.deepEqual(await run(envWith(same()), gh.f), { done: 'unchanged', pr: 7 });
  assert.equal(gh.state.comments.length, 0);
  assert.ok(gh.calls.every((c) => c.startsWith('GET ')));
});

test('comment: an earlier comment is edited when the PR goes quiet, so it never shows a stale grade', async () => {
  const gh = fakeGitHub();
  assert.equal((await run(envWith(good()), gh.f)).done, 'posted');
  assert.equal((await run(envWith(same()), gh.f)).done, 'edited-unchanged');
  assert.equal(gh.state.comments.length, 1);
  assert.ok(gh.state.comments[0].body.includes('No change from the base branch.'));
  const quiet = fakeGitHub({ files: ['README.md'], comments: gh.state.comments });
  assert.equal((await run(envWith(good()), quiet.f)).done, 'edited-untouched');
  assert.ok(!quiet.state.comments[0].body.includes('changes agent config'));
});

test('comment: the sticky comment is found past the first page (no duplicate)', async () => {
  const others = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, user: { login: 'someone' }, body: `${MARKER} not ours` }));
  const gh = fakeGitHub({ comments: [...others, { id: 999, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nold` }] });
  assert.equal((await run(envWith(good()), gh.f)).done, 'edited');
  assert.equal(gh.state.comments.length, 151);
  assert.ok(gh.state.comments.at(-1).body.includes(PROVENANCE));
  assert.ok(gh.state.comments.slice(0, 150).every((c) => c.body.endsWith('not ours')));
});

test('comment: agent config past the first page of files still counts', async () => {
  const files = [...Array.from({ length: 120 }, (_, i) => `src/f${i}.ts`), '.mcp.json'];
  const gh = fakeGitHub({ files });
  assert.equal((await run(envWith(good()), gh.f)).done, 'posted');
  assert.ok(gh.state.comments[0].body.includes('`.mcp.json`'));
});

test('comment: the script never fails its job, and hostile text can\'t start a workflow command', () => {
  const env = envWith(JSON.stringify({ v: 1, 'x\n::error::pwned\n::add-mask::y': 1 }));
  const r = spawnSync(process.execPath, [join(root, 'src', 'comment.mjs')], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('::warning title=Deedglass scan comment::No comment this time: '));
  assert.ok(!r.stdout.includes('::error::') && !r.stdout.includes('::add-mask::'));
  assert.equal(logSafe('a\nb\r%0Ac'), 'a b %250Ac');
});

test('checksums: the default version has a sha256 for every runner the action accepts', () => {
  const version = /version:\n\s+description:[^\n]*\n\s+default: "([0-9.]+)"/.exec(text('action.yml'))?.[1];
  assert.equal(version, '0.1.0');
  const sums = text(`checksums/${version}.txt`);
  for (const os of ['linux', 'darwin']) {
    for (const arch of ['amd64', 'arm64']) {
      assert.match(sums, new RegExp(`^[0-9a-f]{64}  deedglass_${version}_${os}_${arch}\\.tar\\.gz$`, 'm'), `${os}/${arch}`);
    }
  }
  assert.ok(text('action.yml').includes('mkdir -p "$out/head"'), 'the scan writes into $out/head, which must exist first');
});

test('docs: the README and action.yml say what the footer says', () => {
  for (const f of ['README.md', 'action.yml']) {
    const t = text(f).replace(/\s+/g, ' ');
    assert.ok(/scan data is never sent to Deedglass/i.test(t), f);
    assert.ok(/checked with Dodo Payments and deedglass\.com/.test(t), f);
  }
  assert.ok(!/nothing (is )?sent to Deedglass|nothing leaves the runner|nothing left the runner/i.test(text('README.md') + text('action.yml') + text('src/render.mjs')));
});

test('banned words: none in the action, its docs or its code', () => {
  // The product's scripts/banned_words.txt and the site's .banned-words, as of 2026-10-17.
  const banned = ['trustless', 'irrefutable', 'unbreakable', 'tamper-proof', 'tamperproof', 'proof', 'proofs', 'prove', 'proves', 'proven',
    'guarantee', 'guaranteed', 'guarantees', 'receipt', 'receipts', 'compliance', 'compliant', 'synchronous', 'patented', 'certified',
    'certification', 'certificate', 'certificates', 'attest', 'attests', 'attestation', 'attested', 'we testify', 'revolutionary',
    'world-class', 'cutting-edge', 'seamless', 'seamlessly', 'next-gen', 'military-grade', 'bank-grade', 'unhackable',
    'liability transfer', 'intent verification', 'no hidden side effects', 'prevents all tampering', 'verify any agent action'];
  const walk = (d) => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => {
    const rel = d ? `${d}/${e.name}` : e.name;
    if (e.isDirectory()) return ['.git', 'node_modules', 'fixtures'].includes(e.name) ? [] : walk(rel);
    return /\.(md|mjs|yml|yaml|json|txt)$/.test(e.name) ? [rel] : [];
  });
  const files = walk('').filter((f) => f !== 'LICENSE' && f !== 'test/action.test.mjs'); // this file holds the list itself
  assert.ok(files.includes('README.md') && files.includes('src/render.mjs'));
  for (const f of files) {
    const t = text(f).toLowerCase();
    for (const w of banned) {
      const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[-\s]/g, '[-\\s]')}([^a-z0-9]|$)`);
      assert.ok(!re.test(t), `${f}: "${w}"`);
    }
    assert.ok(!/\bal{2}oy\b/.test(t), `${f}: codename`);
  }
});
