import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { Client, runPluginHooks, SubCommand } from 'seyfert';
import type { MockBotOptions, MockCommandClass, MockSubCommandClass, MockTopLevelCommandClass } from './bot';
import { dispatchStore } from './dispatch-context';
import { clientLifecycle } from './seyfert-internals';

export interface FileLoadingHandler {
	filter?: (path: string) => boolean;
	getFiles?: (dir: string) => Promise<string[]>;
	loadFiles?: (paths: string[]) => Promise<unknown[]>;
	loadFilesK?: (paths: string[]) => Promise<unknown[]>;
}

interface CommandPathState {
	path: string;
	loaded: boolean;
}

export class CommandPathCatalog {
	private readonly byPath = new Map<string, CommandPathState>();

	constructor(
		private readonly rootDir: string,
		paths: readonly string[],
	) {
		for (const path of paths) this.add(path);
	}

	add(path: string): CommandPathState {
		let entry = this.byPath.get(path);
		if (!entry) {
			entry = { path, loaded: false };
			this.byPath.set(path, entry);
		}
		return entry;
	}

	markLoaded(path: string): void {
		this.add(path).loaded = true;
	}

	entries(): CommandPathState[] {
		return [...this.byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
	}

	allPaths(): string[] {
		return this.entries().map(entry => entry.path);
	}

	pathsForCommandName(name: string, includeRootSiblings = false): string[] {
		const paths = this.allPaths();
		const selected = new Set<string>();
		for (const path of paths) {
			const segments = path.split(/[/\\]/);
			const base = (segments.at(-1) ?? '').replace(/\.[cm]?[jt]s$/, '');
			if (!segments.includes(name) && base !== name) continue;
			selected.add(path);
			const dir = dirname(path);
			if (dir === this.rootDir && !includeRootSiblings) continue;
			for (const sibling of paths) {
				if (dirname(sibling) === dir) selected.add(sibling);
			}
		}
		return [...selected];
	}
}

function isCommandFile(path: string): boolean {
	return path.endsWith('.js') || (!path.endsWith('.d.ts') && path.endsWith('.ts'));
}

export function pathIsInsideDir(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

async function discoverCommandPaths(dir: string): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			paths.push(...(await discoverCommandPaths(path)));
			continue;
		}
		if (isCommandFile(path)) paths.push(path);
	}
	return paths.sort((a, b) => a.localeCompare(b));
}

async function resolveCommandsDir(client: Client, options: MockBotOptions): Promise<string | undefined> {
	if (options.commandsDir !== undefined) return options.commandsDir;
	if (options.loadFromConfig !== true) return undefined;
	const config = (await client.getRC()) as { locations?: { commands?: string } };
	return config.locations?.commands;
}

export async function createCommandPathCatalog(
	client: Client,
	options: MockBotOptions,
): Promise<CommandPathCatalog | undefined> {
	if (options.commandsDir === undefined && options.loadFromConfig !== true) return undefined;
	const dir = await resolveCommandsDir(client, options);
	return dir ? new CommandPathCatalog(dir, await discoverCommandPaths(dir)) : undefined;
}

/**
 * Replace the command/component/event handlers' file loaders with the user-supplied {@link MockBotOptions.loadModule}
 * importer. See that option's docs for why: seyfert's default `magicImport` reaches files via a `require`/`new
 * Function('return import(...)')` pair that escapes the test runner's transform, so a directory of TS source won't
 * parse and `vi.mock` can't reach a command's deps. Routing through a `path => import(path)` thunk defined in the
 * user's test file keeps the loaded modules in the runner's graph.
 *
 * Imports run SEQUENTIALLY, not via `Promise.all`. Firing every file's `import()` concurrently makes a Vite-style
 * module runner deadlock when the command files share a barrel/circular dependency graph: two in-flight dynamic
 * imports each await a half-initialized module the other holds, and the runner never resolves them. Loading one
 * file at a time lets each entry into the shared graph settle before the next begins. Directory loading is a
 * one-time setup cost, so the lost parallelism is irrelevant.
 */
function installModuleLoader(client: Client, loadModule: (path: string) => Promise<unknown>): void {
	const handlers = [client.commands, client.components, client.events] as unknown as FileLoadingHandler[];
	for (const handler of handlers) {
		if (typeof handler.loadFiles === 'function') {
			handler.loadFiles = async paths => {
				const files: unknown[] = [];
				for (const path of paths) {
					const mod = (await loadModule(path)) as { default?: unknown };
					files.push(mod?.default ?? mod);
				}
				return files;
			};
		}
		if (typeof handler.loadFilesK === 'function') {
			handler.loadFilesK = async paths => {
				const files: unknown[] = [];
				for (const path of paths) {
					files.push({ name: basename(path), file: await loadModule(path), path });
				}
				return files;
			};
		}
	}
}

function installCommandPathTracker(client: Client, catalog: CommandPathCatalog): void {
	const handler = client.commands as unknown as FileLoadingHandler;
	if (typeof handler.loadFilesK !== 'function') return;
	const loadFilesK = handler.loadFilesK.bind(handler);
	handler.loadFilesK = async paths => {
		const files = await loadFilesK(paths);
		for (const path of paths) catalog.markLoaded(path);
		return files;
	};
}

export function splitCommandClasses(commands: readonly MockCommandClass[]): {
	topLevel: MockTopLevelCommandClass[];
	subcommands: MockSubCommandClass[];
} {
	const topLevel: MockTopLevelCommandClass[] = [];
	const subcommands: MockSubCommandClass[] = [];
	for (const command of commands) {
		const instance = new command();
		if (instance instanceof SubCommand) subcommands.push(command as MockSubCommandClass);
		else topLevel.push(command as MockTopLevelCommandClass);
	}
	return { topLevel, subcommands };
}

export function shouldDeferCommandLoading(options: MockBotOptions): boolean {
	return options.loadFromConfig === true || options.commandsDir !== undefined;
}

export function installRunErrorCaptureDefaults(client: Client, options: MockBotOptions): void {
	// Capture unhandled run() errors into the active dispatch context. seyfert binds a noisy built-in onRunError
	// default that only logs and swallows, so without this a command that throws (e.g. a second ctx.write) would
	// let a happy-path test pass green. Re-apply this after plugin option refreshes too: Seyfert recomposes
	// client.options during startup, and commands loaded from commandsDir/plugins bind whatever default is current
	// at load time. A command with its OWN onRunError keeps it (seyfert's `??=` skips our default), so that path
	// never reaches here. When the AUTHOR supplied a client-level default, delegate and mark it handled (no throw);
	// otherwise replace seyfert's logger and let the dispatch fail loud / expose result.error under capture.
	const userClientOptions = options.clientOptions as
		| Record<string, { defaults?: { onRunError?: (context: unknown, error: unknown) => unknown } } | undefined>
		| undefined;
	const install = (scope: 'commands' | 'components' | 'modals'): void => {
		const authorHandler = userClientOptions?.[scope]?.defaults?.onRunError;
		const clientOpts = client.options as Record<string, { defaults?: { onRunError?: unknown } } | undefined>;
		const target = (clientOpts[scope] ??= {});
		const defaults = (target.defaults ??= {});
		defaults.onRunError = (context: unknown, error: unknown) => {
			const ctx = dispatchStore.getStore();
			if (ctx && ctx.error === undefined) {
				ctx.error = error;
				if (authorHandler) ctx.errorHandled = true;
			}
			return authorHandler?.(context, error);
		};
	};
	install('commands');
	install('components');
	install('modals');
}

export async function runMockClientStartup(
	client: Client,
	options: MockBotOptions,
	commandCatalog?: CommandPathCatalog,
): Promise<void> {
	const lifecycle = clientLifecycle(client);
	const loadFromConfig = options.loadFromConfig === true;

	await lifecycle.setupPlugins();
	lifecycle.refreshPluginContributions();
	installRunErrorCaptureDefaults(client, options);
	await runPluginHooks(client, 'plugins:ready', client);
	await client.cache.adapter.start();

	if (options.loadModule) installModuleLoader(client, options.loadModule);
	if (commandCatalog) installCommandPathTracker(client, commandCatalog);
	const deferCommandLoading = shouldDeferCommandLoading(options);

	if (loadFromConfig || options.langsDir) await client.loadLangs(options.langsDir);
	if (options.defaultLang) client.langs.defaultLang = options.defaultLang;

	await runPluginHooks(client, 'commands:beforeLoad', client, options.commandsDir);
	if (!deferCommandLoading && (loadFromConfig || options.commandsDir)) await client.loadCommands(options.commandsDir);
	await lifecycle.reloadPluginCommands();

	if (loadFromConfig || options.componentsDir) await client.loadComponents(options.componentsDir);
	await lifecycle.reloadPluginComponents();

	if (loadFromConfig || options.eventsDir) await client.loadEvents(options.eventsDir);
}
