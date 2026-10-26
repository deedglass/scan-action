// Compares the head and base scans, writes result.json (the only artifact), the job summary and the
// step outputs. Runs in the pull_request job, which has a read-only token.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { touched as touchedOf } from './paths.mjs';
import { badgeJSON, badgeLine, render } from './render.mjs';
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
export function compare(head, base, changed) {
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
    // Kept for the v1 result format, so a v1.0.x comment job still reads a v1.1 result. Comments are
    // free on every repository now (DL-131), so it is always true and the comment job ignores it.
    entitled: true,
  };
}

if (process.argv[1] && process.argv[1].endsWith('diff.mjs')) {
  const head = read('head.json');
  if (!head) {
    console.error('✕ The scan of head produced no report. See the step above.');
    process.exit(1);
  }
  const changed = existsSync(join(dir, 'changed.txt')) ? readFileSync(join(dir, 'changed.txt'), 'utf8').split('\n').filter(Boolean) : [];
  const result = compare(head, read('base.json'), changed);
  const text = JSON.stringify(result);
  parseResult(text); // the comment job will refuse anything this wouldn't pass
  writeFileSync(join(dir, 'result.json'), text);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, render(result, { comment: false }) + '\n');
  // badge: true writes the shields.io endpoint file into the workspace (never a commit), so a later
  // step of the user's own workflow can commit it. The file holds the grade and nothing else.
  if (process.env.DG_BADGE === 'true' && process.env.GITHUB_WORKSPACE) {
    mkdirSync(join(process.env.GITHUB_WORKSPACE, '.deedglass'), { recursive: true });
    writeFileSync(join(process.env.GITHUB_WORKSPACE, '.deedglass', 'score.json'), badgeJSON(result.head.grade) + '\n');
    console.log('✓ Wrote .deedglass/score.json (not committed)');
  }
  const out = process.env.GITHUB_OUTPUT;
  const sarif = existsSync(join(dir, 'head', 'deedglass-scan.sarif'));
  if (out) appendFileSync(out, `grade=${result.head.grade}\npoints=${result.head.points}\nbase-grade=${result.base?.grade ?? ''}\ntouched=${result.touched.length > 0}\nsarif=${sarif}\nbadge=${badgeLine(result.head.grade)}\n`);
  console.log(`✓ Blast radius ${result.head.grade} · ${result.head.points} of 100${result.base ? ` (base ${result.base.grade})` : ''}`);
}
