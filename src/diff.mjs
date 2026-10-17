// Compares the head and base scans, writes result.json (the only artifact), the job summary and the
// step outputs. Runs in the pull_request job, which has a read-only token.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { touched as touchedOf } from './paths.mjs';
import { render } from './render.mjs';
import { parseResult } from './validate.mjs';

const dir = join(process.env.RUNNER_TEMP ?? '/tmp', 'deedglass');
const read = (f) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null);

export function summarise(rep) {
  if (!rep || rep.object !== 'scan_report') return null;
  const n = (s) => (rep.findings ?? []).filter((f) => f.severity === s).length;
  const paths = (rep.score?.deductions ?? []).filter((d) => d.id === 'unchecked_write_path').length;
  return { grade: rep.score.grade, points: rep.score.points, write_paths: paths, high: n('high'), medium: n('medium') };
}

const key = (f) => `${f.id}|${(f.paths ?? [])[0] ?? ''}`;
// licenceCheck: on a private repo, comments need a Pro licence with action_private. It uses the
// CLI's own licence code: `licence activate` (the key goes to Dodo Payments, then deedglass.com),
// `licence show` (offline), and then, in every case, `licence deactivate` (Dodo Payments), so the
// run gives back the activation it took: a key has 3. The licence files sit in their own directory,
// removed at the end. The key is never logged.
export function licenceCheck(env, bin, home = join(dir, 'licence'), exec = execFileSync) {
  if (env.DG_PRIVATE !== 'true') return { entitled: true, why: 'public' };
  if (!env.DG_LICENCE) return { entitled: false, why: 'no-licence' };
  mkdirSync(home, { recursive: true });
  const token = join(home, 'licence.json');
  const opts = { env: { ...env, DEEDGLASS_LICENCE_FILE: token }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 };
  const out = { entitled: false, why: 'show' };
  try {
    try {
      exec(bin, ['--json', 'licence', 'activate', env.DG_LICENCE], opts);
    } catch (e) {
      return Object.assign(out, { why: 'activate', code: errCode(e) });
    }
    const show = JSON.parse(String(exec(bin, ['--json', 'licence', 'show'], opts)));
    const ok = show?.active === true && Array.isArray(show.features) && show.features.includes('action_private');
    return Object.assign(out, ok ? { entitled: true, why: 'licence' } : { why: 'feature' });
  } catch {
    return out;
  } finally {
    // Always, even when activate or show failed: a half-finished activate can leave a token behind.
    const held = existsSync(token);
    try {
      exec(bin, ['--json', 'licence', 'deactivate'], opts);
    } catch (e) {
      if (held) out.warning = `This run couldn't deactivate the licence it activated (${errCode(e)}), so it still counts as one of the key's 3 machines. Ask at deedglass.com/support to free it.`;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// errCode reads the CLI's JSON error code ({"error":{"code":"licence_key_limit",...}} on stderr).
function errCode(e) {
  try {
    const c = JSON.parse(String(e?.stderr ?? '')).error.code;
    if (typeof c === 'string' && /^[a-z_]{1,48}$/.test(c)) return c;
  } catch { /* not JSON */ }
  return 'no error code';
}

/** licenceLine is the job-summary line for a private repo without a comment, or ''. */
export function licenceLine(lic) {
  const free = 'The scan and this summary are free.';
  switch (lic.why) {
    case 'no-licence': return `Comments on private repos are part of Pro: deedglass.com/pro. ${free}`;
    case 'feature': return `This licence doesn't include comments on private repos (\`action_private\`): deedglass.com/pro. ${free}`;
    case 'activate': {
      const limit = lic.code === 'licence_key_limit'
        ? ' The key is active on 3 machines already, and each run needs one of them for a few seconds: free one with `deedglass licence deactivate`.'
        : '';
      return `The licence couldn't be activated for this run (${lic.code ?? 'no error code'}), so there's no comment from it.${limit} ${free}`;
    }
    case 'show': return `The licence was activated but couldn't be read back, so there's no comment from this run. ${free}`;
    default: return '';
  }
}

export function compare(head, base, changed, entitled = true) {
  const flat = (rep) => (rep?.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, title: f.title, path: (f.paths ?? [])[0] ?? '' }));
  const hb = new Set(flat(base).map(key));
  const hh = new Set(flat(head).map(key));
  const pathsOf = (rep) => (rep?.score?.deductions ?? []).filter((d) => d.id === 'unchecked_write_path').map((d) => d.subject);
  const basePaths = new Set(pathsOf(base));
  return {
    v: 1,
    version: String(head.deedglass_version ?? '0.0.0').replace(/^v/, '').split(' ')[0],
    base: summarise(base),
    head: summarise(head),
    new_findings: base ? flat(head).filter((f) => !hb.has(key(f))).slice(0, 50) : [],
    resolved: base ? flat(base).filter((f) => !hh.has(key(f))).slice(0, 50) : [],
    new_paths: base ? pathsOf(head).filter((p) => !basePaths.has(p)).slice(0, 50) : [],
    fix_first: String(head.score?.fix_first ?? '').slice(0, 300),
    touched: touchedOf(changed).slice(0, 50),
    entitled,
  };
}

if (process.argv[1] && process.argv[1].endsWith('diff.mjs')) {
  const head = read('head.json');
  if (!head) {
    console.error('✕ The scan of head produced no report. See the step above.');
    process.exit(1);
  }
  const changed = existsSync(join(dir, 'changed.txt')) ? readFileSync(join(dir, 'changed.txt'), 'utf8').split('\n').filter(Boolean) : [];
  const lic = licenceCheck(process.env, join(dir, 'bin', 'deedglass'));
  if (lic.warning) console.log(`::warning title=Deedglass licence::${lic.warning}`);
  const result = compare(head, read('base.json'), changed, lic.entitled);
  const text = JSON.stringify(result);
  parseResult(text); // the comment job will refuse anything this wouldn't pass
  writeFileSync(join(dir, 'result.json'), text);
  const note = lic.entitled ? '' : licenceLine(lic);
  if (note) console.log(`○ ${note}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, render(result, { comment: false }) + (note ? `\n\n${note}` : '') + '\n');
  const out = process.env.GITHUB_OUTPUT;
  const sarif = existsSync(join(dir, 'head', 'deedglass-scan.sarif'));
  if (out) appendFileSync(out, `grade=${result.head.grade}\npoints=${result.head.points}\nbase-grade=${result.base?.grade ?? ''}\ntouched=${result.touched.length > 0}\nsarif=${sarif}\n`);
  console.log(`✓ Blast radius ${result.head.grade} · ${result.head.points} of 100${result.base ? ` (base ${result.base.grade})` : ''}`);
}
