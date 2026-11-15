import { parseReportOutputFormats, type RoleModelOverride } from '@loopwright/controller';

export class UsageError extends Error { constructor() { super('CLI_USAGE'); } }
export type StepAction = 'next' | 'submit' | 'cancel';
export interface Arguments {
  readonly command: 'init' | 'check' | 'run' | 'resume' | 'reconcile' | 'status' | 'inspect' | 'closure' | 'app-serve' | 'step';
  readonly stepAction?: StepAction;
  readonly roleModelOverrides?: readonly RoleModelOverride[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}
interface CommandRule {
  readonly required: readonly string[];
  readonly values: readonly string[];
  readonly flags: readonly string[];
  readonly allowRoleModel?: boolean;
}
const commands: Record<Exclude<Arguments['command'], 'step'>, CommandRule> = {
  init: { required: ['directory'], values: ['directory'], flags: ['force', 'json'] },
  check: { required: ['config', 'registry', 'registry-sha256'], values: ['config', 'registry', 'registry-sha256', 'output'], flags: ['json'], allowRoleModel: true },
  run: { required: ['config', 'registry', 'registry-sha256'], values: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id', 'output', 'output-format', 'step-summary-file'], flags: ['json', 'dry-run'], allowRoleModel: true },
  resume: { required: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id'], values: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id', 'output-format', 'step-summary-file'], flags: ['json'], allowRoleModel: true },
  reconcile: { required: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id', 'receipt'], values: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id', 'receipt', 'output', 'output-format', 'step-summary-file'], flags: ['json'] },
  status: { required: ['run-root', 'run-id'], values: ['run-root', 'run-id'], flags: ['json'] },
  inspect: { required: ['run-root', 'run-id'], values: ['run-root', 'run-id', 'output'], flags: ['json'] },
  closure: { required: [], values: ['repo', 'output'], flags: ['json', 'verify-failures'] },
  'app-serve': { required: ['config'], values: ['config', 'repo'], flags: ['json'] },
};
const stepRules: Record<StepAction, CommandRule> = {
  next: {
    required: ['run-root', 'run-id'],
    values: ['run-root', 'run-id', 'config', 'registry', 'registry-sha256', 'taskpack', 'repo', 'mode', 'output-format', 'step-summary-file'],
    flags: ['reissue-lease', 'json'],
    allowRoleModel: true,
  },
  submit: {
    required: ['run-root', 'run-id', 'lease'],
    values: ['run-root', 'run-id', 'lease', 'submission-file', 'status', 'reason', 'output-format', 'step-summary-file'],
    flags: ['json'],
  },
  cancel: {
    required: ['run-root', 'run-id'],
    values: ['run-root', 'run-id', 'output-format', 'step-summary-file'],
    flags: ['json'],
  },
};
const STEP_VALUE_KEYS = new Set(['action', ...stepRules.next.values, ...stepRules.submit.values, ...stepRules.cancel.values]);
const STEP_FLAG_KEYS = new Set([...stepRules.next.flags, ...stepRules.submit.flags, ...stepRules.cancel.flags]);
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_ROLE_MODELS = 8;
function isValidLabel(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !/[\s\p{C}]/u.test(value);
}
function parseRoleModelSpec(spec: string): RoleModelOverride {
  const eqIdx = spec.indexOf('=');
  if (eqIdx <= 0 || eqIdx === spec.length - 1) throw new UsageError();
  const roleId = spec.slice(0, eqIdx);
  const rhs = spec.slice(eqIdx + 1);
  if (roleId.length < 1 || roleId.length > 64 || !IDENTIFIER_PATTERN.test(roleId)) throw new UsageError();
  const slashIdx = rhs.indexOf('/');
  if (slashIdx <= 0 || slashIdx === rhs.length - 1) throw new UsageError();
  const provider = rhs.slice(0, slashIdx);
  const rest = rhs.slice(slashIdx + 1);
  if (!isValidLabel(provider)) throw new UsageError();
  const colonIdx = rest.indexOf(':');
  let model: string;
  let thinking: string | undefined;
  if (colonIdx !== -1) {
    if (rest.indexOf(':', colonIdx + 1) !== -1) throw new UsageError();
    model = rest.slice(0, colonIdx);
    thinking = rest.slice(colonIdx + 1);
    if (!isValidLabel(thinking)) throw new UsageError();
  } else {
    model = rest;
  }
  if (!isValidLabel(model)) throw new UsageError();
  return thinking !== undefined ? { roleId, provider, model, thinking } : { roleId, provider, model };
}
function validateCommonValues(values: ReadonlyMap<string, string>): void {
  if (values.has('output-format')) {
    try { parseReportOutputFormats(values.get('output-format')); }
    catch { throw new UsageError(); }
  }
  if (values.has('step-summary-file') && values.get('step-summary-file')!.trim().length === 0) throw new UsageError();
  if (values.has('run-id') && (values.get('run-id')!.length > 64 || !IDENTIFIER_PATTERN.test(values.get('run-id')!))) throw new UsageError();
}
function validateStepArguments(
  stepAction: StepAction,
  values: ReadonlyMap<string, string>,
  flags: ReadonlySet<string>,
  overrides: readonly RoleModelOverride[],
): void {
  const rule = stepRules[stepAction];
  if (overrides.length > 0 && !rule.allowRoleModel) throw new UsageError();
  for (const key of values.keys()) {
    if (key !== 'action' && !rule.values.includes(key)) throw new UsageError();
  }
  for (const flag of flags) {
    if (!rule.flags.includes(flag)) throw new UsageError();
  }
  if (stepAction === 'next') {
    const hasTaskpack = values.has('taskpack');
    const hasAnyConfig = values.has('config') || values.has('registry') || values.has('registry-sha256');
    const hasAllConfig = values.has('config') && values.has('registry') && values.has('registry-sha256');
    if (hasTaskpack && hasAnyConfig) throw new UsageError();
    if (hasAnyConfig && (!hasAllConfig || !values.has('repo'))) throw new UsageError();
    if (hasTaskpack && !values.has('repo')) throw new UsageError();
    if (overrides.length > 0 && !hasTaskpack && !values.has('config')) throw new UsageError();
    if (values.has('mode')) {
      const mode = values.get('mode')!;
      if (mode !== 'candidate' && mode !== 'no-change') throw new UsageError();
    }
  } else if (stepAction === 'submit') {
    if (values.has('lease') && values.get('lease')!.trim().length === 0) throw new UsageError();
    if (values.has('status')) {
      const status = values.get('status')!;
      if (!['completed', 'no_change', 'failed', 'blocked'].includes(status)) throw new UsageError();
    }
  }
  validateCommonValues(values);
  if (rule.required.some(key => !values.has(key))) throw new UsageError();
}
export function parseArguments(argv: readonly string[]): Arguments {
  if (argv.length > 64 || argv.some(arg => arg.length > 4096 || /[\0\r\n]/.test(arg))) throw new UsageError();
  const rawCommand = argv[0];
  if (!rawCommand) throw new UsageError();
  const values = new Map<string, string>(), flags = new Set<string>();
  const overrides: RoleModelOverride[] = [];
  const seenRoleIds = new Set<string>();

  const parseOptions = (startIndex: number, isAllowedFlag: (k: string) => boolean, isAllowedValue: (k: string) => boolean, allowRoleModel: boolean) => {
    for (let index = startIndex; index < argv.length; index++) {
      const raw = argv[index]!;
      if (!raw.startsWith('--')) throw new UsageError();
      const key = raw.slice(2);
      if (key === 'role-model') {
        if (!allowRoleModel || overrides.length >= MAX_ROLE_MODELS) throw new UsageError();
        const spec = argv[++index];
        if (!spec || spec.startsWith('--')) throw new UsageError();
        const parsed = parseRoleModelSpec(spec);
        if (seenRoleIds.has(parsed.roleId)) throw new UsageError();
        seenRoleIds.add(parsed.roleId);
        overrides.push(parsed);
        continue;
      }
      if (values.has(key) || flags.has(key)) throw new UsageError();
      if (isAllowedFlag(key)) flags.add(key);
      else if (isAllowedValue(key)) {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new UsageError();
        values.set(key, value);
      } else throw new UsageError();
    }
  };

  if (rawCommand === 'step') {
    let positionalAction: StepAction | undefined;
    let startIndex = 1;
    if (argv.length > 1 && !argv[1]!.startsWith('--')) {
      const rawAction = argv[1]!;
      if (rawAction !== 'next' && rawAction !== 'submit' && rawAction !== 'cancel') throw new UsageError();
      positionalAction = rawAction;
      startIndex = 2;
    }
    parseOptions(startIndex, key => STEP_FLAG_KEYS.has(key), key => STEP_VALUE_KEYS.has(key), true);
    if (positionalAction !== undefined && values.has('action')) throw new UsageError();
    const resolvedAction = positionalAction ?? values.get('action');
    if (resolvedAction !== 'next' && resolvedAction !== 'submit' && resolvedAction !== 'cancel') throw new UsageError();
    validateStepArguments(resolvedAction, values, flags, overrides);
    return {
      command: 'step',
      stepAction: resolvedAction,
      ...(overrides.length > 0 ? { roleModelOverrides: overrides } : {}),
      values,
      flags,
    };
  }

  const command = rawCommand as Exclude<Arguments['command'], 'step'>;
  if (!Object.hasOwn(commands, command)) throw new UsageError();
  const rule = commands[command];
  parseOptions(1, key => rule.flags.includes(key), key => rule.values.includes(key), rule.allowRoleModel === true);
  const required = [...rule.required];
  if (command === 'run' && !flags.has('dry-run')) { required.push('repo', 'run-root', 'run-id'); if (values.has('output')) throw new UsageError(); }
  if (command === 'run' && flags.has('dry-run') && ['repo', 'run-root', 'run-id', 'output-format', 'step-summary-file'].some(key => values.has(key))) throw new UsageError();
  validateCommonValues(values);
  if (required.some(key => !values.has(key))) throw new UsageError();
  return {
    command,
    ...(overrides.length > 0 ? { roleModelOverrides: overrides } : {}),
    values,
    flags,
  };
}
