// Checks the action's inputs before anything is downloaded, so a mistake fails the job with one
// clear line instead of a scan that quietly measures the wrong thing.
const shown = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 100);

/** checkDir: dir must name a directory inside the repository, relative to its root. The base
 * branch is scanned from its own checkout with the same dir, so an absolute path, or one that
 * climbs out with .., would scan the head checkout twice and always report no change. */
export function checkDir(d) {
  const s = String(d ?? '');
  if (s.trim() === '') return 'dir is empty. Use . for the whole repository.';
  if (s.startsWith('/') || s.startsWith('~')) {
    return `dir must be relative to the repository root, like . or agent (got "${shown(s)}"). The base branch is scanned from its own checkout with the same dir.`;
  }
  if (s.split('/').includes('..')) return `dir can't contain .. (got "${shown(s)}"). Name a directory inside the repository.`;
  return '';
}

/** checkFailUnder: empty, or a grade that something can fall below (A to D). */
export function checkFailUnder(f) {
  const s = String(f ?? '');
  return ['', 'A', 'B', 'C', 'D'].includes(s) ? '' : `fail-under takes A, B, C or D, or empty to never fail on the grade (got "${shown(s)}").`;
}

/** checkSarif: auto, always or never. */
export function checkSarif(v) {
  const s = String(v ?? '');
  return ['auto', 'always', 'never'].includes(s) ? '' : `sarif takes auto, always or never (got "${shown(s)}").`;
}

/** checkBadge: true or false. */
export function checkBadge(v) {
  const s = String(v ?? '');
  return ['true', 'false'].includes(s) ? '' : `badge takes true or false (got "${shown(s)}").`;
}

if (process.argv[1] && process.argv[1].endsWith('inputs.mjs')) {
  const errs = [checkDir(process.env.DG_DIR), checkFailUnder(process.env.DG_FAIL_UNDER), checkSarif(process.env.DG_SARIF), checkBadge(process.env.DG_BADGE ?? 'false')].filter(Boolean);
  for (const e of errs) console.error(`✕ ${e}`);
  process.exit(errs.length ? 1 : 0);
}
