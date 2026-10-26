// The PR comment and the job summary (S47 §5, ACT-02). Every interpolated field goes through a
// typed formatter (grade, num, sev, path or esc), so render() stays safe even on input that skipped
// the validator. No HTML but the marker, <sub> and <br>; links only to deedglass.com/score and the run.
export const MARKER = '<!-- deedglass-scan -->';

// What leaves the runner, said only as far as the code goes (ACT-01). The action runs the scan on
// the runner; the scan makes no request, and nothing in this action calls Deedglass.
export const DATA_LINE = 'read-only · scan data is never sent to Deedglass';

// A fork's pull request controls its own scan job, so the comment says whose numbers these are. The
// comment job never fails; the scan job's own check can (fail-under), and the comment says so then.
export const PROVENANCE = "Reported by this PR's run. This comment is information only and never blocks a merge.";
export const SCAN_FAILED = "The scan job's own check failed (for example on `fail-under`); that check, not this comment, can block a merge.";
export const EDITS = 'each later run edits this comment';

// Why a run has no result to show. Fixed text only: nothing here comes from the artifact.
export const NO_RESULT = {
  missing: 'the scan job uploaded no result (it stopped before the upload, or its artifact couldn\'t be downloaded)',
  refused: 'its result didn\'t pass this action\'s checks, so nothing from it is shown',
};

// The badge colours match `deedglass scan --badge` (internal/scan/badge.go): teal for A and B,
// neutral for C, amber for D and F; never red, which means deny.
export const BADGE_COLORS = { A: '0F766E', B: '0F766E', C: '3F4453', D: '9A5B00', F: '9A5B00' };
const SCORE_URL = 'https://deedglass.com/score';

/** badgeLine is a shields.io static badge for a grade, as one Markdown line to paste in a README. */
export function badgeLine(g) {
  const v = grade(g);
  if (v === '?') return '';
  return `[![agent blast radius ${v}](https://img.shields.io/badge/agent%20blast%20radius-${v}-${BADGE_COLORS[v]})](${SCORE_URL})`;
}

/** badgeJSON is the shields.io endpoint body, the same as `deedglass scan --badge` writes. */
export function badgeJSON(g) {
  const v = grade(g);
  if (v === '?') return '';
  return JSON.stringify({ schemaVersion: 1, label: 'agent blast radius', message: v, color: BADGE_COLORS[v], cacheSeconds: 3600 });
}

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

// One finding or path per line, with the CLI's glyphs: ✕ high, ○ medium or lower, ✓ resolved.
const glyph = (s) => (s === 'high' ? '✕' : '○');
const change = (b, h, f) => (b ? (f(b) === f(h) ? f(h) : `${f(b)} → ${f(h)}`) : f(h));

export function render(r, { runUrl = '', comment = true, scanFailed = false } = {}) {
  const h = r.head;
  const b = r.base;
  const touched = list(r.touched);
  const newFindings = list(r.new_findings);
  const resolved = list(r.resolved);
  const newPaths = list(r.new_paths);
  const lines = [];
  if (comment) lines.push(MARKER);
  const was = b && grade(b.grade) !== grade(h.grade) ? `${grade(b.grade)} → ` : '';
  lines.push(`### Deedglass · agent blast radius ${was}**${grade(h.grade)}**`);
  lines.push('');
  if (nothingChanged(r)) lines.push('✓ No change from the base branch.');
  else if (!b) lines.push('○ The base branch wasn\'t scanned, so this is the head only.');
  lines.push(`- Points: ${change(b, h, (s) => num(s.points))} of 100`);
  lines.push(`- Write paths with no check: ${change(b, h, (s) => num(s.write_paths))}`);
  lines.push(`- High · medium findings: ${change(b, h, (s) => `${num(s.high)} · ${num(s.medium)}`)}`);
  if (touched.length) lines.push(`- Agent config changed: ${touched.slice(0, 5).map(path).join(', ')}${touched.length > 5 ? ` and ${num(touched.length - 5)} more` : ''}`);
  if (newFindings.length || newPaths.length) {
    lines.push('', '**New**');
    for (const f of newFindings.slice(0, 10)) lines.push(`- ${glyph(f?.severity)} ${sev(f?.severity)} · ${esc(f?.title)} · ${path(f?.path)}`);
    for (const p of newPaths.slice(0, 10)) lines.push(`- ○ write path with no check · ${path(p)}`);
  }
  if (resolved.length) {
    lines.push('', '**Resolved**');
    for (const f of resolved.slice(0, 10)) lines.push(`- ✓ ${sev(f?.severity)} · ${esc(f?.title)}`);
  }
  if (r.fix_first) lines.push('', `**Fix first:** ${esc(r.fix_first)}`);
  if (!comment && badgeLine(h.grade)) lines.push('', '**README badge** (a static shields.io badge for this grade; paste it, and update it when the grade changes)', '', '```markdown', badgeLine(h.grade), '```');
  lines.push('');
  if (comment) lines.push(`<sub>${scanFailed ? `${PROVENANCE} ${SCAN_FAILED}` : PROVENANCE}</sub><br>`);
  lines.push(`<sub>deedglass ${esc(r.version)} · ${DATA_LINE} · [What the grade means](${SCORE_URL})${runLink(runUrl)}${comment ? ` · ${EDITS}` : ''}</sub>`);
  return lines.join('\n');
}

const runLink = (u) => (/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/[0-9]+$/.test(u) ? ` · [This run](${u})` : '');

/** renderNoResult replaces an earlier comment when the latest run has no result to show, so the
 * comment doesn't keep an older run's grade. why is one of NO_RESULT's fixed lines. */
export function renderNoResult(why, { runUrl = '' } = {}) {
  const line = Object.values(NO_RESULT).includes(why) ? why : NO_RESULT.missing;
  return [
    MARKER,
    '### Deedglass · no result from the latest run',
    '',
    `○ The latest run reported no result: ${line}. The grade shown here before came from an earlier run, so it was removed.`,
    '',
    `<sub>${PROVENANCE}</sub><br>`,
    `<sub>${DATA_LINE} · [What the grade means](${SCORE_URL})${runLink(runUrl)} · ${EDITS}</sub>`,
  ].join('\n');
}
