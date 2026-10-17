// Strict reader for result.json, the artifact the scan job uploads. The comment job treats it as
// hostile (a fork's PR controls the scan job): size cap, closed keys, typed fields, ids by regex,
// strings at most 300 characters. Anything else is refused.
export const MAX_BYTES = 256 * 1024;
const GRADE = /^[ABCDF]$/;
const ID = /^[a-z][a-z0-9_]{1,63}$/;
const SEV = new Set(['high', 'medium', 'low', 'info']);

class Invalid extends Error {}
const fail = (m) => { throw new Invalid(m); };
const keys = (o, want, where) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${where} must be an object`);
  const k = Object.keys(o).sort().join(',');
  // The message names the keys, but only in a log-safe form: they come from hostile data.
  if (k !== [...want].sort().join(',')) fail(`${where} has keys ${k.replace(/[^A-Za-z0-9_,]/g, '?').slice(0, 200)}`);
};
const str = (v, where, max = 300) => { if (typeof v !== 'string' || v.length > max) fail(`${where} must be a string of at most ${max}`); return v; };
const int = (v, where, max) => { if (!Number.isInteger(v) || v < 0 || v > max) fail(`${where} must be 0 to ${max}`); return v; };

function side(o, where) {
  if (o === null) return null;
  keys(o, ['grade', 'points', 'write_paths', 'high', 'medium'], where);
  if (!GRADE.test(o.grade)) fail(`${where}.grade`);
  int(o.points, `${where}.points`, 100); int(o.write_paths, `${where}.write_paths`, 999);
  int(o.high, `${where}.high`, 999); int(o.medium, `${where}.medium`, 999);
  return o;
}

function finding(f, where) {
  keys(f, ['id', 'severity', 'title', 'path'], where);
  if (!ID.test(f.id)) fail(`${where}.id`);
  if (!SEV.has(f.severity)) fail(`${where}.severity`);
  str(f.title, `${where}.title`); str(f.path, `${where}.path`);
  return f;
}

/** parseResult returns the validated result or throws. text is the file's contents. */
export function parseResult(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail('result.json is too large');
  let v;
  try { v = JSON.parse(text); } catch { fail('result.json is not JSON'); }
  keys(v, ['v', 'version', 'base', 'head', 'new_findings', 'resolved', 'new_paths', 'fix_first', 'touched', 'entitled'], 'result');
  if (typeof v.entitled !== 'boolean') fail('result.entitled');
  if (v.v !== 1) fail('result.v');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(v.version)) fail('result.version');
  side(v.base, 'base');
  if (v.head === null) fail('head is required');
  side(v.head, 'head');
  for (const k of ['new_findings', 'resolved']) {
    if (!Array.isArray(v[k]) || v[k].length > 50) fail(`${k} must be a list of at most 50`);
    v[k].forEach((f, i) => finding(f, `${k}[${i}]`));
  }
  if (!Array.isArray(v.new_paths) || v.new_paths.length > 50) fail('new_paths');
  v.new_paths.forEach((p, i) => str(p, `new_paths[${i}]`, 200));
  str(v.fix_first, 'fix_first');
  if (!Array.isArray(v.touched) || v.touched.length > 50) fail('touched');
  v.touched.forEach((p, i) => str(p, `touched[${i}]`, 200));
  return v;
}

export { Invalid };
