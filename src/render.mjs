// The PR comment and the job summary (S47 §5, ACT-02). Every interpolated field goes through a
// typed formatter (grade, num, sev, path or esc), so render() stays safe even on input that skipped
// the validator. No HTML but the marker and <sub>; links only to deedglass.com/score and the run.
export const MARKER = '<!-- deedglass-scan -->';

// What leaves the runner, said only as far as the code goes (ACT-01). diff.mjs touches the licence
// only when the repository is private and the licence input is set: `deedglass licence activate`
// posts the key to Dodo Payments and to deedglass.com, `licence show` reads it back offline, and
// `licence deactivate` frees the activation at Dodo Payments in every case. The scan makes no request.
export const DATA_LINE = 'read-only · scan data is never sent to Deedglass · on a private repo with a licence, each run activates the licence with Dodo Payments and deedglass.com, then deactivates it';

// A fork's pull request controls its own scan job, so the comment says whose numbers these are. The
// comment job never fails; the scan job's own check can (fail-under), and the comment says so then.
export const PROVENANCE = "Reported by this PR's run. This comment is information only and never blocks a merge.";
export const SCAN_FAILED = "The scan job's own check failed (for example on `fail-under`); that check, not this comment, can block a merge.";
export const EDITS = 'each later run edits this comment';

// Why a run has no result to show. Fixed text only: nothing here comes from the artifact.
export const NO_RESULT = {
  missing: 'the scan job uploaded no result (it stopped before the upload, or its artifact couldn\'t be downloaded)',
  refused: 'its result didn\'t pass this action\'s checks, so nothing from it is shown',
  private: 'comments on private repositories need a Deedglass Pro licence with `action_private`, and this run had none; its job summary has the grade',
};

const SAFE_PATH = /^[A-Za-z0-9._/@ -]{1,200}$/;
const GRADE = /^[ABCDF]$/;
const SEVERITIES = new Set(['high', 'medium', 'low', 'info']);
const ZWSP = '\u200b';
// Control, bidi, zero-width, filler, variation-selector, tag and other invisible characters, and
// lone surrogates, are dropped: none of them can carry a hidden message into the comment.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\ud800-\udfff\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const MAX_TEXT = 300;

/** esc makes untrusted text inert Markdown: one line, no HTML, no links, no mentions, no references. */
export function esc(s) {
  return Array.from(String(s ?? '').replace(INVISIBLE, ''))
    .slice(0, MAX_TEXT)
    .join('')
    .replace(/[\\`*_{}[\]()#+!|<>~&$]/g, (c) => (c === '#' ? `\\#${ZWSP}` : `\\${c}`)) // # also breaks issue references
    .replace(/@/g, `@${ZWSP}`) // mentions, team mentions, emails, owner/repo@sha
    .replace(/:\/\//g, `:${ZWSP}//`) // https:// and other autolinks
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}${ZWSP}.`) // www. autolinks
    .replace(/\bGH-(?=[0-9])/gi, (m) => `${m.slice(0, 2)}${ZWSP}-`); // GH-123 references
}

export const grade = (g) => (typeof g === 'string' && GRADE.test(g) ? g : '?');
export const num = (n) => (Number.isInteger(n) && n >= 0 && n <= 1e6 ? String(n) : '?');
export const sev = (s) => (SEVERITIES.has(s) ? s : '?');
export const path = (p) => (typeof p === 'string' && SAFE_PATH.test(p) ? '`' + p + '`' : '…');
const side = (s) => (s ? `${grade(s.grade)} · ${num(s.points)}` : 'not scanned');
const list = (v) => (Array.isArray(v) ? v : []);

/** nothingChanged is true when the base was scanned and the head matches it on every count. */
export function nothingChanged(r) {
  const b = r?.base;
  const h = r?.head;
  if (!b || !h) return false;
  return ['grade', 'points', 'write_paths', 'high', 'medium'].every((k) => b[k] === h[k])
    && !list(r.new_findings).length && !list(r.resolved).length && !list(r.new_paths).length;
}

export function render(r, { runUrl = '', comment = true, scanFailed = false } = {}) {
  const h = r.head;
  const b = r.base;
  const touched = list(r.touched);
  const newFindings = list(r.new_findings);
  const resolved = list(r.resolved);
  const newPaths = list(r.new_paths);
  const lines = [];
  if (comment) lines.push(MARKER);
  const was = b && b.grade !== h.grade ? ` (was **${grade(b.grade)}**)` : '';
  lines.push(`### Deedglass scan · agent blast radius **${grade(h.grade)}**${was}`);
  if (comment) lines.push('', scanFailed ? `${PROVENANCE} ${SCAN_FAILED}` : PROVENANCE);
  if (touched.length) lines.push('', `This pull request changes agent config: ${touched.slice(0, 5).map(path).join(', ')}${touched.length > 5 ? ` and ${num(touched.length - 5)} more` : ''}`);
  if (nothingChanged(r)) lines.push('', 'No change from the base branch.');
  lines.push('', '| | Before | After |', '|---|---:|---:|');
  lines.push(`| Grade | ${side(b)} | ${side(h)} |`);
  lines.push(`| Write paths with no check | ${b ? num(b.write_paths) : '·'} | ${num(h.write_paths)} |`);
  lines.push(`| High · medium findings | ${b ? `${num(b.high)} · ${num(b.medium)}` : '·'} | ${num(h.high)} · ${num(h.medium)} |`);
  if (newFindings.length || newPaths.length) {
    lines.push('', '**New in this pull request**');
    for (const f of newFindings.slice(0, 10)) lines.push(`- ${sev(f?.severity)} · ${esc(f?.title)} · ${path(f?.path)}`);
    for (const p of newPaths.slice(0, 10)) lines.push(`- write path with no check · ${path(p)}`);
  }
  if (resolved.length) {
    lines.push('', '**Resolved in this pull request**');
    for (const f of resolved.slice(0, 10)) lines.push(`- ${sev(f?.severity)} · ${esc(f?.title)}`);
  }
  if (r.fix_first) lines.push('', `**Fix this first:** ${esc(r.fix_first)}.`);
  lines.push('', `<sub>deedglass ${esc(r.version)} · formula v1 · ${DATA_LINE} · [What the grade means](https://deedglass.com/score)${runLink(runUrl)}${comment ? ` · ${EDITS}` : ''}</sub>`);
  return lines.join('\n');
}

const runLink = (u) => (/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/[0-9]+$/.test(u) ? ` · [This run](${u})` : '');

/** renderNoResult replaces an earlier comment when the latest run has no result to show, so the
 * comment doesn't keep an older run's grade. why is one of NO_RESULT's fixed lines. */
export function renderNoResult(why, { runUrl = '' } = {}) {
  const line = Object.values(NO_RESULT).includes(why) ? why : NO_RESULT.missing;
  return [
    MARKER,
    '### Deedglass scan · no result from the latest run',
    '',
    `The latest run of the scan on this pull request reported no result: ${line}. The grade shown here before came from an earlier run, so it was removed. This comment is information only and never blocks a merge.`,
    '',
    `<sub>formula v1 · ${DATA_LINE} · [What the grade means](https://deedglass.com/score)${runLink(runUrl)} · ${EDITS}</sub>`,
  ].join('\n');
}
