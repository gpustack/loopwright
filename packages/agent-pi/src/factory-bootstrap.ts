import { createEventBus, DefaultResourceLoader, SettingsManager, type ExtensionFactory, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { lstat, mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { frozenLoader } from './resources.js';
const INERT = 'Loopwright trusted inline factory compiler. No role or task execution occurs here.';
export interface TrustedFactory { readonly name: 'loopwright-authorization' | 'loopwright-mcp' | 'loopwright-codemode'; readonly factory: ExtensionFactory }
const names = ['loopwright-authorization', 'loopwright-mcp', 'loopwright-codemode'];
async function emptyDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || await realpath(path) !== path || (await readdir(path)).length) throw new Error('Unsafe factory namespace');
}
/** Container-only, before untrusted execution. Public SDK compiler; final role loader never discovers. */
export async function compileTrustedFactories(factories: readonly TrustedFactory[], prompt: string) {
  if (process.platform !== 'linux' || process.env.HOME !== '/tmp/home' || homedir() !== '/tmp/home' || process.env.PI_OFFLINE !== '1'
    || Object.keys(process.env).some(key => /(?:AGENT_DIR|PACKAGE_DIR)$/.test(key))) throw new Error('Unsafe factory environment');
  if (factories.length < 1 || factories.length > 3 || factories.some((item, index) => item.name !== names[index] || typeof item.factory !== 'function')) throw new Error('Unexpected factory provenance');
  // The only non-project automatic root is HOME/.agents/skills. Reject a preexisting HOME tree before SDK resolution.
  try { await mkdir('/tmp/home', { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await emptyDirectory('/tmp/home');
  const directory = await mkdtemp('/tmp/loopwright-factory-'); await emptyDirectory(directory);
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
