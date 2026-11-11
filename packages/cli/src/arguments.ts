export class UsageError extends Error { constructor() { super('CLI_USAGE'); } }
export interface Arguments { readonly command: 'init' | 'check' | 'run' | 'resume' | 'reconcile' | 'status' | 'inspect' | 'closure'; readonly values: ReadonlyMap<string, string>; readonly flags: ReadonlySet<string> }
const commands = {
  init: { required: ['directory'], values: ['directory'], flags: ['force', 'json'] },
  check: { required: ['config', 'registry', 'registry-sha256'], values: ['config', 'registry', 'registry-sha256', 'output'], flags: ['json'] },
  run: { required: ['config', 'registry', 'registry-sha256'], values: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id', 'output'], flags: ['json', 'dry-run'] },
  resume: { required: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id'], values: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id'], flags: ['json'] },
  reconcile: { required: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id', 'receipt'], values: ['config', 'registry', 'registry-sha256', 'repo', 'run-root', 'run-id', 'receipt', 'output'], flags: ['json'] },
  status: { required: ['run-root', 'run-id'], values: ['run-root', 'run-id'], flags: ['json'] },
  inspect: { required: ['run-root', 'run-id'], values: ['run-root', 'run-id', 'output'], flags: ['json'] },
  closure: { required: [], values: ['repo', 'output'], flags: ['json', 'verify-failures'] },
};
export function parseArguments(argv: readonly string[]): Arguments {
  if (argv.length > 32 || argv.some(arg => arg.length > 4096 || /[\0\r\n]/.test(arg))) throw new UsageError();
  const command = argv[0] as keyof typeof commands; if (!Object.hasOwn(commands, command)) throw new UsageError();
  const rule = commands[command], values = new Map<string, string>(), flags = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const raw = argv[index]!; if (!raw.startsWith('--')) throw new UsageError(); const key = raw.slice(2);
    if (values.has(key) || flags.has(key)) throw new UsageError();
    if (rule.flags.includes(key)) flags.add(key);
    else if (rule.values.includes(key)) { const value = argv[++index]; if (!value || value.startsWith('--')) throw new UsageError(); values.set(key, value); }
    else throw new UsageError();
  }
  const required = [...rule.required];
  if (command === 'run' && !flags.has('dry-run')) { required.push('repo', 'run-root', 'run-id'); if (values.has('output')) throw new UsageError(); }
  if (command === 'run' && flags.has('dry-run') && ['repo', 'run-root', 'run-id'].some(key => values.has(key))) throw new UsageError();
  if (values.has('run-id') && (values.get('run-id')!.length > 64 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(values.get('run-id')!))) throw new UsageError();
  if (required.some(key => !values.has(key))) throw new UsageError(); return { command, values, flags };
}
