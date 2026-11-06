/** Only the exact inspect-ID not-found form is absence. Other failures retain uncertainty. */
export function isAbsentInspect(id, exit, stdout, stderr) {
  if (!/^[a-f0-9]{64}$/.test(id) || exit !== 1 || !['', '[]'].includes(stdout.trim()) || stderr.length > 512) return false;
  return new RegExp('^error: no such (?:object|container): ' + id + '\\s*$', 'i').test(stderr);
}
