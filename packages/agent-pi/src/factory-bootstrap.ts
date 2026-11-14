import { createEventBus, DefaultResourceLoader, SettingsManager, type ExtensionFactory, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { lstat, mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { frozenLoader } from './resources.js';
const INERT = 'Loopwright trusted inline factory compiler. No role or task execution occurs here.';
export interface TrustedFactory { readonly name: 'loopwright-authorization' | 'loopwright-mcp' | 'loopwright-codemode'; readonly factory: ExtensionFactory }
const names = ['loopwright-authorization', 'loopwright-mcp', 'loopwright-codemode'];
async function emptyDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || await realpath(path) !== path || (await readdir(path)).length) throw new Error('Unsafe factory namespace');
}
/** Container-only by default; isolated host-session workers must opt in via LOOPWRIGHT_HOST_SESSION=1. */
export async function compileTrustedFactories(factories: readonly TrustedFactory[], prompt: string) {
  const isHostSession = process.env.LOOPWRIGHT_HOST_SESSION === '1';
  if (Object.hasOwn(process.env, 'LOOPWRIGHT_HOST_SESSION')) {
    if (!isHostSession) throw new Error('Unsafe factory environment');
    delete process.env.LOOPWRIGHT_HOST_SESSION;
  }
  let home: string;
  if (isHostSession) {
    const supportedPlatform = (process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'x64'))
      || (process.platform === 'darwin' && process.arch === 'arm64');
    const rawHome = process.env.HOME;
    if (!supportedPlatform || typeof rawHome !== 'string' || !isAbsolute(rawHome) || homedir() !== rawHome || process.env.PI_OFFLINE !== '1'
      || Object.keys(process.env).some(key => /(?:AGENT_DIR|PACKAGE_DIR)$/.test(key))) throw new Error('Unsafe factory environment');
    home = rawHome;
  } else {
    if (process.platform !== 'linux' || process.env.HOME !== '/tmp/home' || homedir() !== '/tmp/home' || process.env.PI_OFFLINE !== '1'
      || Object.keys(process.env).some(key => /(?:AGENT_DIR|PACKAGE_DIR)$/.test(key))) throw new Error('Unsafe factory environment');
    home = '/tmp/home';
  }
  if (factories.length < 1 || factories.length > 3 || factories.some((item, index) => item.name !== names[index] || typeof item.factory !== 'function')) throw new Error('Unexpected factory provenance');
  // The only non-project automatic root is HOME/.agents/skills. Reject a preexisting HOME tree before SDK resolution.
  try { await mkdir(home, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await emptyDirectory(home);
  const tmpRoot = isHostSession ? await realpath(process.env.TMPDIR || '/tmp') : '/tmp';
  const directory = await mkdtemp(join(tmpRoot, 'loopwright-factory-')); await emptyDirectory(directory);
  const settings = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [],
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: 'off', compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 4096 } }, { projectTrusted: false });
  const eventBus = createEventBus();
  const compiler = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, eventBus,
    extensionFactories: factories.map(item => ({ name: item.name, factory: item.factory })), disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
    additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [],
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: INERT, appendSystemPrompt: [] });
  await compiler.reload();
  const extensions = compiler.getExtensions();
  verifyCompilerOutput(compiler, factories.map(item => `<inline:${item.name}>`));
  // Keep the original native records/runtime and the bus captured by their real ExtensionAPI closures.
  return { loader: frozenLoader(prompt, extensions), extensions, eventBus, settings, directory };
}
/** Exact-output validation only; it never filters resources or makes an unsafe input namespace acceptable. */
export function verifyCompilerOutput(compiler: ResourceLoader, paths: readonly string[]): void {
  const result = compiler.getExtensions();
  if (result.errors.length || result.warnings?.length || result.extensions.length !== paths.length
    || result.extensions.some((item, index) => item.path !== paths[index] || item.resolvedPath !== paths[index])
    || !result.runtime || compiler.getSystemPrompt() !== INERT || compiler.getSystemPromptSource() !== undefined
    || compiler.getAppendSystemPrompt().length || compiler.getAppendSystemPromptSources().length || compiler.getAgentsFiles().agentsFiles.length
    || compiler.getSkills().skills.length || compiler.getSkills().diagnostics.length || compiler.getPrompts().prompts.length
    || compiler.getPrompts().diagnostics.length || compiler.getThemes().themes.length || compiler.getThemes().diagnostics.length) throw new Error('Unexpected native compiler output');
}
