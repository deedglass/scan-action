// node --test: the diff, the strict artifact reader, the renderer and the comment upsert on a
// recorded GitHub API fake (S47 §6 Action table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare, licenceCheck, licenceLine } from '../src/diff.mjs';
import { parseResult } from '../src/validate.mjs';
import { render, renderNoResult, MARKER, esc, nothingChanged, DATA_LINE, PROVENANCE, SCAN_FAILED, NO_RESULT } from '../src/render.mjs';
import { run, api, logSafe } from '../src/comment.mjs';
import { isAgentPath } from '../src/paths.mjs';
import { checkDir, checkFailUnder, checkSarif } from '../src/inputs.mjs';

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

const HEAD_SHA = 'a'.repeat(40);

function fakeGitHub({ files = ['.cursor/mcp.json'], comments = [], pulls = [], headSha = HEAD_SHA } = {}) {
  const calls = [];
  const state = { comments: [...comments], next: 100, headSha };
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
    if (init.method === 'GET' && /\/pulls\/[0-9]+$/.test(u.pathname)) return ok({ number: Number(u.pathname.split('/').pop()), head: { sha: state.headSha } });
    if (init.method === 'POST') { state.comments.push({ id: state.next++, user: { login: 'github-actions[bot]' }, body: JSON.parse(init.body).body }); return ok({}); }
    if (init.method === 'PATCH') { const id = Number(u.pathname.split('/').pop()); state.comments.find((c) => c.id === id).body = JSON.parse(init.body).body; return ok({}); }
    throw new Error('unexpected ' + url);
  };
  return { f, calls, state };
}

function envWith(result, extra = {}) {
  const d = join(tmpdir(), `dgact-${Math.random()}`);
  mkdirSync(join(d, 'dg-artifact'), { recursive: true });
  if (result !== null) writeFileSync(join(d, 'dg-artifact', 'result.json'), typeof result === 'string' ? result : JSON.stringify(result));
  if (result === null) rmSync(join(d, 'dg-artifact'), { recursive: true, force: true });
  return { GITHUB_REPOSITORY: 'acme/agents', GITHUB_TOKEN: 't', RUNNER_TEMP: d, DG_RUN_ID: '42', DG_PRS: JSON.stringify([{ number: 7 }]), DG_HEAD_SHA: HEAD_SHA, DG_PRIVATE: 'false', DG_CONCLUSION: 'success', ...extra };
}

test('comment: posts once, then edits in place (50 pushes, one comment, one write per run)', async () => {
  const gh = fakeGitHub();
  assert.equal((await run(envWith(good()), gh.f)).done, 'posted');
  for (let i = 0; i < 50; i++) {
    const before = gh.calls.length;
    assert.equal((await run(envWith(good()), gh.f)).done, 'edited');
    assert.equal(gh.calls.slice(before).filter((c) => !c.startsWith('GET ')).length, 1);
    assert.ok(gh.calls.length - before <= 4);
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

test('comment: a poisoned artifact is refused: no new comment, nothing from it shown, an earlier comment says so', async () => {
  const gh = fakeGitHub();
  await assert.rejects(run(envWith('{"v":1,"pwn":"@everyone"}'), gh.f));
  assert.equal(gh.state.comments.length, 0);
  assert.ok(gh.calls.every((c) => c.startsWith('GET ')));
  assert.equal((await run(envWith(good()), gh.f)).done, 'posted');
  await assert.rejects(run(envWith('{"v":1,"pwn":"@everyone"}'), gh.f));
  assert.equal(gh.state.comments.length, 1);
  const body = gh.state.comments[0].body;
  assert.equal(body, renderNoResult(NO_RESULT.refused, { runUrl: 'https://github.com/acme/agents/actions/runs/42' }));
  assert.ok(body.startsWith(MARKER) && !body.includes('everyone') && !/agent blast radius \*\*[A-F]/.test(body));
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
  assert.ok(DATA_LINE.includes('on a private repo with a licence, each run activates the licence with Dodo Payments and deedglass.com, then deactivates it'));
  assert.ok(!/checked with Dodo/.test(DATA_LINE), 'the run activates the licence; it does not only check it');
  assert.ok(md.includes("Reported by this PR's run"));
  assert.ok(md.includes('This comment is information only and never blocks a merge.'));
  assert.ok(md.split('\n').includes(PROVENANCE));
  assert.ok(!md.includes(SCAN_FAILED));
  assert.ok(md.includes('each later run edits this comment'));
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
    // Tag characters spell "Ign" invisibly; variation selectors, fillers and lone surrogates too.
    'ok\u{e0049}\u{e0067}\u{e006e}\u{e0001}\u{e007f}': (o) => o === 'ok',
    'v\ufe00\ufe0f\u{e0100}\u{e01ef}s\u034f\u115f\u1160\u3164\uffa0\u17b4\u17b5\u180b\u180d\u180f\u{1d173}\u{1bca0}\ud800x': (o) => o === 'vsx',
  };
  for (const [input, ok] of Object.entries(cases)) assert.ok(ok(esc(input)), `${JSON.stringify(input)} → ${JSON.stringify(esc(input))}`);
  assert.equal(Array.from(esc('x'.repeat(5000))).length, 300);
  assert.equal(esc('\u{e0041}'.repeat(400) + 'visible'), 'visible', 'invisible characters do not count toward the cap');
  assert.equal(esc('caf\u00e9 \u{1f600} \u4e2d'), 'caf\u00e9 \u{1f600} \u4e2d', 'visible non-ASCII stays');
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

test('comment: an earlier comment is edited to the current numbers when the PR goes quiet', async () => {
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
  // DG_PRS '[]' and no head owner: the PR can't be resolved, so the script makes no request at all.
  const r = spawnSync(process.execPath, [join(root, 'src', 'comment.mjs')], { env: { PATH: process.env.PATH, ...env, DG_PRS: '[]' }, encoding: 'utf8', timeout: 30000 });
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

test('docs: every use of this action names one ref: a release commit sha with a # v1 comment, or v1', () => {
  // The README on main pins a release's full sha; the README inside the v1.0.0 tag can't name its
  // own sha, so it uses @v1 (see Releasing).
  const files = ['README.md', 'examples/deedglass-scan.yml', 'examples/deedglass-comment.yml'];
  const refs = new Set();
  let seen = 0;
  for (const f of files) {
    for (const m of text(f).matchAll(/uses: deedglass\/scan-action[^\s@]*@(\S+)(.*)$/gm)) {
      seen++;
      refs.add(m[1]);
      const pinned = /^[0-9a-f]{40}$/.test(m[1]) && m[2] === ' # v1';
      const tag = m[1] === 'v1' && m[2] === '';
      assert.ok(pinned || tag, `${f}: ${m[0]}`);
    }
  }
  assert.ok(seen >= 4, `only ${seen} uses`);
  assert.equal(refs.size, 1, `every use names the same ref: ${[...refs].join(', ')}`);
  assert.ok(!refs.has('070ad8307767ff38b4e912e9f6187aad55be9e65'), 'never the pre-release commit');
  assert.match(text('README.md').replace(/\s+/g, ' '), /Pin this action to the full commit sha of a release/);
});

test('docs: the README and action.yml say what the footer says', () => {
  for (const f of ['README.md', 'action.yml']) {
    const t = text(f).replace(/\s+/g, ' ');
    assert.ok(/scan data is never sent to Deedglass/i.test(t), f);
    assert.ok(/activates the licence with Dodo Payments and deedglass\.com/.test(t), f);
    assert.ok(/deactivates it/.test(t), f);
    assert.ok(!/checked with Dodo/.test(t), f);
  }
  const t = text('README.md').replace(/\s+/g, ' ');
  assert.ok(t.includes("one of the key's 3 activations"), 'README says a run takes an activation');
  assert.ok(!/never shows a stale grade|edited on each push/.test(t + text('CHANGELOG.md') + text('src/render.mjs')));
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

// --- review fixes: licence activations, stale comments, out-of-order runs, inputs ---

// A fake deedglass that logs each call and plays the licence commands (FAKE_* pick the outcome).
function fakeDeedglass() {
  const d = join(tmpdir(), `dgbin-${Math.random()}`);
  mkdirSync(d, { recursive: true });
  const bin = join(d, 'deedglass');
  writeFileSync(bin, `#!/bin/sh
echo "$DEEDGLASS_LICENCE_FILE|$*" >> "$FAKE_LOG"
case "$*" in
  *"licence activate"*)
    if [ "$FAKE_ACTIVATE" = fail ]; then echo '{"error":{"code":"licence_key_limit","message":"x"}}' >&2; exit 1; fi
    if [ "$FAKE_ACTIVATE" = half ]; then echo '{}' > "$DEEDGLASS_LICENCE_FILE"; echo '{"error":{"code":"licence_unreachable"}}' >&2; exit 1; fi
    echo '{}' > "$DEEDGLASS_LICENCE_FILE"; echo '{"status":"activated"}' ;;
  *"licence show"*)
    if [ "$FAKE_SHOW" = fail ]; then echo '{"error":{"code":"licence_signature"}}' >&2; exit 1; fi
    echo "{\\"active\\":true,\\"features\\":[\\"\${FAKE_FEATURE:-action_private}\\"]}" ;;
  *"licence deactivate"*)
    if [ ! -f "$DEEDGLASS_LICENCE_FILE" ]; then echo '{"error":{"code":"licence_missing"}}' >&2; exit 1; fi
    if [ "$FAKE_DEACTIVATE" = fail ]; then echo '{"error":{"code":"licence_unreachable"}}' >&2; exit 1; fi
    rm -f "$DEEDGLASS_LICENCE_FILE"; echo '{"status":"deactivated"}' ;;
  *) exit 2 ;;
esac
`);
  chmodSync(bin, 0o755);
  const log = join(d, 'calls.log');
  const home = join(d, 'licence');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const env = (extra = {}) => ({ PATH: process.env.PATH, FAKE_LOG: log, DG_PRIVATE: 'true', DG_LICENCE: 'DG-TEST-KEY-0001', ...extra });
  return { bin, home, calls, env };
}

test('licence: a private run activates, reads, then always deactivates with the same licence file', () => {
  const cases = [
    { name: 'entitled', extra: {}, want: { entitled: true, why: 'licence' } },
    { name: 'show fails', extra: { FAKE_SHOW: 'fail' }, want: { entitled: false, why: 'show' } },
    { name: 'no action_private', extra: { FAKE_FEATURE: 'scan_full' }, want: { entitled: false, why: 'feature' } },
    { name: 'activate refused', extra: { FAKE_ACTIVATE: 'fail' }, want: { entitled: false, why: 'activate', code: 'licence_key_limit' } },
    { name: 'activate half-done', extra: { FAKE_ACTIVATE: 'half' }, want: { entitled: false, why: 'activate', code: 'licence_unreachable' } },
  ];
  for (const c of cases) {
    const fk = fakeDeedglass();
    const got = licenceCheck(fk.env(c.extra), fk.bin, fk.home);
    assert.deepEqual(got, c.want, c.name);
    const calls = fk.calls();
    assert.equal(calls.at(-1).split('|')[1], '--json licence deactivate', `${c.name}: deactivate runs last`);
    assert.equal(calls[0].split('|')[1], '--json licence activate DG-TEST-KEY-0001', c.name);
    assert.equal(new Set(calls.map((l) => l.split('|')[0])).size, 1, `${c.name}: one licence file`);
    assert.ok(calls[0].startsWith(join(fk.home, 'licence.json')), c.name);
    assert.ok(!existsSync(fk.home), `${c.name}: licence files removed`);
  }
});

test('licence: a failed deactivate is a warning that never shows the key; public and keyless runs never call the CLI', () => {
  const fk = fakeDeedglass();
  const got = licenceCheck(fk.env({ FAKE_DEACTIVATE: 'fail' }), fk.bin, fk.home);
  assert.equal(got.entitled, true);
  assert.match(got.warning, /couldn't deactivate the licence it activated \(licence_unreachable\)/);
  assert.ok(!got.warning.includes('DG-TEST-KEY-0001'));
  assert.ok(!existsSync(fk.home));
  const quiet = fakeDeedglass();
  assert.deepEqual(licenceCheck(quiet.env({ DG_PRIVATE: 'false' }), quiet.bin, quiet.home), { entitled: true, why: 'public' });
  assert.deepEqual(licenceCheck(quiet.env({ DG_LICENCE: '' }), quiet.bin, quiet.home), { entitled: false, why: 'no-licence' });
  assert.deepEqual(quiet.calls(), []);
  const refused = fakeDeedglass();
  assert.equal(licenceCheck(refused.env({ FAKE_ACTIVATE: 'fail' }), refused.bin, refused.home).warning, undefined, 'nothing was held, so nothing to warn about');
});

test('licence: the job summary says why a private repo got no comment', () => {
  assert.match(licenceLine({ why: 'no-licence' }), /^Comments on private repos are part of Pro: deedglass\.com\/pro\./);
  assert.match(licenceLine({ why: 'feature' }), /doesn't include comments on private repos \(`action_private`\)/);
  const limit = licenceLine({ why: 'activate', code: 'licence_key_limit' });
  assert.match(limit, /couldn't be activated for this run \(licence_key_limit\)/);
  assert.match(limit, /active on 3 machines already/);
  assert.ok(!licenceLine({ why: 'activate', code: 'licence_unreachable' }).includes('3 machines'));
  assert.ok(!/part of Pro/.test(limit), 'a paying customer is not told to buy Pro');
  assert.equal(licenceLine({ why: 'licence' }), '');
});

test('comment: a run with no artifact edits an earlier comment to say so, and posts nothing new', async () => {
  const none = fakeGitHub();
  assert.deepEqual(await run(envWith(null), none.f), { done: 'no-artifact', pr: 7 });
  assert.equal(none.state.comments.length, 0);
  assert.ok(none.calls.every((c) => c.startsWith('GET ')));
  const gh = fakeGitHub();
  assert.equal((await run(envWith(good()), gh.f)).done, 'posted');
  assert.deepEqual(await run(envWith(null), gh.f), { done: 'edited-no-artifact', pr: 7 });
  assert.equal(gh.state.comments.length, 1);
  assert.ok(gh.state.comments[0].body.includes('no result from the latest run'));
  assert.ok(gh.state.comments[0].body.includes(NO_RESULT.missing));
  assert.ok(!/agent blast radius/.test(gh.state.comments[0].body), 'the old grade is gone');
  assert.equal((await run(envWith(good()), gh.f)).done, 'edited');
  assert.ok(gh.state.comments[0].body.includes('agent blast radius **D**'));
});

test('comment: a private repo that is no longer entitled edits its earlier comment instead of leaving the grade', async () => {
  const gh = fakeGitHub();
  assert.equal((await run(envWith(good(), { DG_PRIVATE: 'true' }), gh.f)).done, 'posted');
  const r = await run(envWith({ ...good(), entitled: false }, { DG_PRIVATE: 'true' }), gh.f);
  assert.deepEqual(r, { done: 'edited-private-not-entitled', pr: 7 });
  assert.ok(gh.state.comments[0].body.includes(NO_RESULT.private));
});

test('comment: a run for an older push never edits the comment (runs can finish out of order)', async () => {
  const gh = fakeGitHub();
  assert.equal((await run(envWith(good()), gh.f)).done, 'posted');
  const before = gh.state.comments[0].body;
  gh.state.headSha = 'b'.repeat(40);
  assert.deepEqual(await run(envWith(same()), gh.f), { done: 'outdated', pr: 7 });
  assert.deepEqual(await run(envWith(null), gh.f), { done: 'outdated', pr: 7 });
  assert.equal(gh.state.comments[0].body, before);
  await assert.rejects(run(envWith('{"v":1}'), gh.f), 'a refused artifact still warns');
});

test('comment: when the scan job failed, the comment says its own check can block a merge', async () => {
  const gh = fakeGitHub();
  assert.equal((await run(envWith(good(), { DG_CONCLUSION: 'failure' }), gh.f)).done, 'posted');
  assert.ok(gh.state.comments[0].body.includes(`${PROVENANCE} ${SCAN_FAILED}`));
  assert.equal((await run(envWith(good()), gh.f)).done, 'edited');
  assert.ok(!gh.state.comments[0].body.includes(SCAN_FAILED));
  assert.ok(!render(good(), { comment: false, scanFailed: true }).includes(SCAN_FAILED), 'the summary has no provenance line');
});

test('renderNoResult: fixed text only, the same links as the comment', () => {
  for (const why of Object.values(NO_RESULT)) {
    const md = renderNoResult(why, { runUrl: 'https://github.com/acme/agents/actions/runs/42' });
    assert.ok(md.startsWith(MARKER) && md.includes(why) && md.includes(DATA_LINE));
    assert.ok(md.includes('This comment is information only and never blocks a merge.'));
    const links = [...md.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(links, ['https://deedglass.com/score', 'https://github.com/acme/agents/actions/runs/42']);
  }
  assert.ok(renderNoResult('@everyone <img>').includes(NO_RESULT.missing) && !renderNoResult('@everyone <img>').includes('everyone'));
});

test('inputs: dir must be relative to the repository root; fail-under and sarif take their listed values', () => {
  for (const d of ['.', 'agent', 'agent/sub', './agent', 'a..b', '.hidden']) assert.equal(checkDir(d), '', d);
  for (const d of ['', ' ', '/home/runner/work/x/x/agent', '~/agent', '..', '../other', 'agent/../..', 'a/..']) assert.notEqual(checkDir(d), '', JSON.stringify(d));
  assert.match(checkDir('/abs\n::error::x'), /^dir must be relative.*"\/abs\?::error::x"/);
  for (const f of ['', 'A', 'B', 'C', 'D']) assert.equal(checkFailUnder(f), '', f);
  for (const f of ['c', 'E', 'F', 'B+']) assert.notEqual(checkFailUnder(f), '', f);
  for (const v of ['auto', 'always', 'never']) assert.equal(checkSarif(v), '', v);
  for (const v of ['', 'true', 'Never']) assert.notEqual(checkSarif(v), '', v);
  const r = spawnSync(process.execPath, [join(root, 'src', 'inputs.mjs')], { env: { PATH: process.env.PATH, DG_DIR: '/abs', DG_FAIL_UNDER: '', DG_SARIF: 'auto' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^✕ dir must be relative/);
  const ok = spawnSync(process.execPath, [join(root, 'src', 'inputs.mjs')], { env: { PATH: process.env.PATH, DG_DIR: '.', DG_FAIL_UNDER: 'C', DG_SARIF: 'never' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(ok.status, 0, ok.stderr);
});

test('action.yml: the inputs are checked before the download; the comment step passes the conclusion', () => {
  const a = text('action.yml');
  const i = a.indexOf('node "$DG_ACTION_PATH/src/inputs.mjs"');
  assert.ok(i > 0 && i < a.indexOf('node "$DG_ACTION_PATH/src/install.mjs"'));
  for (const k of ['DG_DIR: ${{ inputs.dir }}', 'DG_FAIL_UNDER: ${{ inputs.fail-under }}', 'DG_SARIF: ${{ inputs.sarif }}']) assert.ok(a.includes(k), k);
  const c = text('comment/action.yml');
  assert.ok(c.includes('DG_CONCLUSION: ${{ github.event.workflow_run.conclusion }}'));
  assert.equal(c.split('"success","failure","cancelled","timed_out"').length - 1, 2);
});
