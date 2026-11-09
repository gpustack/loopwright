import { s03Groups } from './s03-scope.mjs';
export const qualificationMaxima = Object.freeze({ provider: 960, mcp: 1728, containers: 896 });
export const phaseLimits = Object.freeze({ t0: 320, initial: 1500, finalPi: 1900, finalController: 1380 });
export const leaves = Object.freeze({
  'parser-descriptor': ['parser-descriptor.mjs', 60],
  'capture-binding': ['capture-binding.mjs', 180],
  'mcp-http': ['mcp-auth.mjs', 180, 'http'],
  'mcp-tls': ['mcp-auth.mjs', 180, 'tls'],
  'mcp-credentials': ['mcp-auth.mjs', 120, 'auth'],
  cycle: ['native-fixtures.mjs', 120],
  repair: ['native-fixtures.mjs', 120],
  recovery: ['native-fixtures.mjs', 240],
  cancellation: ['native-fixtures.mjs', 120],
  secrets: ['native-fixtures.mjs', 60],
  'image-preflight': ['native-image-inspector.mjs', 750],
  'derived-image-build': ['delivery-build.mjs', 120],
  ...Object.fromEntries(Object.keys(s03Groups).map(group=>['s03-'+group,['delivery-s03.mjs',group==='recovery'?810:group==='limits'?920:120]])),
});
export const nativeActivationHeld = () => true;
const aliases = Object.freeze({ feasibility: ['parser-descriptor', 'capture-binding'], 'mcp-auth': ['mcp-http', 'mcp-tls', 'mcp-credentials'] });
export class QualificationRefusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = code => { throw new QualificationRefusal(code); };
export function selection(args) {
  const fields = new Map();
  if (args.length % 2) refuse('QUALIFICATION_ARGUMENT_INVALID');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--case', '--phase'].includes(args[i]) || fields.has(args[i])) refuse('QUALIFICATION_ARGUMENT_INVALID');
    fields.set(args[i], args[i + 1]);
  }
  const name = fields.get('--case'), phase = fields.get('--phase') ?? 'finalController';
  if (typeof name==='string'&&name.startsWith('s03-')&&phase!=='finalPi') refuse('QUALIFICATION_ARGUMENT_INVALID');
  if (name === 'image-preflight' && phase !== 'initial') refuse('QUALIFICATION_ARGUMENT_INVALID');
  if (!Object.hasOwn(phaseLimits, phase) || !Object.hasOwn(leaves, name) && !Object.hasOwn(aliases, name)) refuse('QUALIFICATION_ARGUMENT_INVALID');
  return { cases: [...(aliases[name] ?? [name])], phase };
}
export function validateUsage(native) {
  const phases = Object.keys(phaseLimits), seconds = native?.seconds;
  if (native?.version !== 1 || !seconds || Object.keys(seconds).sort().join() !== [...phases].sort().join()
    || Object.values(seconds).some(amount => !Number.isFinite(amount) || amount < 0)
    || !native.leafSeconds || Array.isArray(native.leafSeconds) || Object.keys(native.leafSeconds).length > 256
    || !Number.isFinite(native.cleanupSeconds) || native.cleanupSeconds < 0) refuse('QUALIFICATION_BUDGET_INVALID');
  allocationCharges(native);
  const totals = Object.fromEntries(phases.map(phase => [phase, 0]));
  for (const [key, amount] of Object.entries(native.leafSeconds)) {
    const [phase, leaf, extra] = key.split(':');
    if (extra || !phases.includes(phase) || leaf === 'image-preflight' && phase !== 'initial' || !['tls-fixture', 'incident-reconciliation'].includes(leaf) && !Object.hasOwn(leaves, leaf) || !Number.isFinite(amount) || amount < 0) refuse('QUALIFICATION_BUDGET_INVALID');
    totals[phase] += amount;
  }
  if (phases.some(phase => Math.abs(totals[phase] - seconds[phase]) > 0.000001)) refuse('QUALIFICATION_BUDGET_INVALID');
  return native;
}
/** Qualification experiment allocations are nonrefundable and never measured production elapsed. */
export function allocationCharges(native) {
  const rows = native.qualificationAllocations ?? []; if (!Array.isArray(rows) || rows.length > 8) refuse('QUALIFICATION_ALLOCATION_INVALID');
  const phases = Object.fromEntries(Object.keys(phaseLimits).map(phase => [phase, 0])), seen = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join(',') !== ['id','phase','allocationSeconds','kind','reason','receipt'].sort().join(',') || seen.has(row.id)
      || !/^[a-z0-9-]{1,64}$/.test(row.id) || !Object.hasOwn(phases,row.phase) || row.kind !== 'local_qualification_allocation'
      || !Number.isFinite(row.allocationSeconds) || row.allocationSeconds <= 0 || row.allocationSeconds > 60 || typeof row.reason !== 'string'
      || !row.receipt || !/^[a-f0-9]{64}$/.test(row.receipt.sha256) || !Number.isSafeInteger(row.receipt.byteLength) || row.receipt.byteLength <= 0 || !row.receipt.path?.startsWith('/')) refuse('QUALIFICATION_ALLOCATION_INVALID');
    seen.add(row.id); phases[row.phase] += row.allocationSeconds;
  }
  return { phases, total: Object.values(phases).reduce((sum, value) => sum + value, 0) };
}
export function allowance(native, phase, key, cap) {
  validateUsage(native);
  if (key.startsWith('s03-') && phase !== 'finalPi' || key === 'image-preflight' && phase !== 'initial') refuse('QUALIFICATION_ARGUMENT_INVALID');
  if (!Object.hasOwn(phaseLimits, phase) || key !== 'tls-fixture' && !Object.hasOwn(leaves, key) || !Number.isFinite(cap) || cap <= 0) refuse('QUALIFICATION_ARGUMENT_INVALID');
  const spent = leaf => native.leafSeconds[phase + ':' + leaf] ?? 0;
  const allocated = allocationCharges(native), work = Object.values(native.seconds).reduce((sum, amount) => sum + amount, 0) + allocated.total;
  const initialRepair = phase === 'initial' && key === 'repair';
  const leafCap = initialRepair ? 240 : key === 'tls-fixture' ? 10 : leaves[key][1];
  const s03Extended = key === 's03-recovery' || key === 's03-limits';
  const leafRemaining = initialRepair ? Math.min(cap, 120, leafCap - spent(key)) : key === 'image-preflight' ? Math.min(cap, 60, leafCap - spent(key)) : s03Extended ? Math.min(cap, 300, leafCap - spent(key)) : Math.min(cap, leafCap) - spent(key);
  let remaining = Math.min(leafRemaining, phaseLimits[phase] - native.seconds[phase] - allocated.phases[phase], 5100 - work, 5400 - work - native.cleanupSeconds);
  if (key.startsWith('mcp-') || key === 'tls-fixture') remaining = Math.min(remaining, 480 - spent('mcp-http') - spent('mcp-tls') - spent('mcp-credentials') - spent('tls-fixture'));
  if (key === 'mcp-tls' || key === 'tls-fixture') remaining = Math.min(remaining, 180 - spent('mcp-tls') - spent('tls-fixture'));
  if (remaining <= 0) refuse('QUALIFICATION_LIMIT');
  return remaining;
}
