import { createDrainPipeline } from 'evlog/pipeline';
import {
	Client,
	Command,
	ComponentCommand,
	createMiddleware,
	createPlugin,
	ModalCommand,
	Logger as SeyfertLogger,
} from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import { assert, describe, test } from 'vitest';
import { evlogTransport, type LogEntry, type LoggerAdapter, logger, useLogger } from '../src';

type LoggerPlugin = ReturnType<typeof logger>;

class RecordingAdapter implements LoggerAdapter {
	readonly entries: LogEntry[] = [];

	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

class SkipCommand extends Command {
	run(): void {}
}

class CustomCommand extends Command {
	name = 'custom-command';
	description = 'custom command';
	contexts = [0] as never;
	readonly afterErrors: unknown[] = [];
	readonly optionErrors: unknown[] = [];
	permissionCalls = 0;
	readonly runErrors: unknown[] = [];
	throwOnPermissions = false;
	throwOnRun = false;

	run(): void {
		if (this.throwOnRun) throw new Error('command run failed');
	}

	onRunError(_context: unknown, error: unknown): void {
		this.runErrors.push(error);
	}

	onOptionsError(_context: unknown, metadata: unknown): void {
		this.optionErrors.push(metadata);
	}

	onPermissionsFail(): void {
		this.permissionCalls++;
		if (this.throwOnPermissions) throw new Error('permission hook failed');
	}

	onAfterRun(_context: unknown, error: unknown): void {
		this.afterErrors.push(error);
	}
}

class CustomComponent extends ComponentCommand {
	componentType = 'Button' as const;
	customId = 'custom:component';
	readonly afterErrors: unknown[] = [];
	readonly runErrors: unknown[] = [];
	throwOnRun = false;

	run(): void {
		if (this.throwOnRun) throw new Error('component run failed');
	}

	onRunError(_context: unknown, error: unknown): void {
		this.runErrors.push(error);
	}

	onAfterRun(_context: unknown, error: unknown): void {
		this.afterErrors.push(error);
	}
}

class CustomModal extends ModalCommand {
	customId = 'custom:modal';
	readonly afterErrors: unknown[] = [];
	readonly runErrors: unknown[] = [];
	throwOnRun = false;

	run(): void {
		if (this.throwOnRun) throw new Error('modal run failed');
	}

	onRunError(_context: unknown, error: unknown): void {
		this.runErrors.push(error);
	}

	onAfterRun(_context: unknown, error: unknown): void {
		this.afterErrors.push(error);
	}
}

function getLoggerPluginOptions(plugin: LoggerPlugin) {
	const fragment = (plugin.options?.({} as never) ?? {}) as Record<string, unknown>;
	const defaults = { commands: {}, components: {}, modals: {} };
	let transform: ((instance: object, metadata: { kind: 'command' | 'component' | 'modal' }) => unknown) | undefined;
	plugin.register?.({
		commands: {
			observe: (observer: object) => Object.assign(defaults.commands, observer),
			defaults: () => undefined,
		},
		components: { defaults: (hooks: object) => Object.assign(defaults.components, hooks) },
		modals: { defaults: (hooks: object) => Object.assign(defaults.modals, hooks) },
		handlers: {
			transform: (handler: typeof transform) => {
				transform = handler;
			},
		},
	} as never);
	transform?.(defaults.components, { kind: 'component' });
	transform?.(defaults.modals, { kind: 'modal' });
	return {
		...fragment,
		commands: { defaults: defaults.commands },
		components: { defaults: defaults.components },
		modals: { defaults: defaults.modals },
	} as never;
}

function fakeClient() {
	return { commands: {}, components: {}, events: {}, langs: {}, cache: {} };
}

function interactionContext(extra: Record<string, unknown> = {}) {
	return {
		client: { middlewares: {}, logger: { warn() {} } },
		fullCommandName: 'admin skip',
		globalMetadata: {},
		metadata: {},
		...extra,
	};
}

async function setupLifecycleClient(adapter: LoggerAdapter) {
	const command = new CustomCommand();
	const component = new CustomComponent();
	const modal = new CustomModal();
	const loggerPlugin = logger({ renderer: adapter });
	const fixtures = createPlugin({
		name: '@test/logger-lifecycle-fixtures',
		register: api => {
			api.commands.add(command);
			api.components.add(component);
			api.modals.add(modal);
		},
	});
	const client = new Client({
		plugins: [loggerPlugin, fixtures],
		logger: { active: false },
		commands: { prefix: () => ['!'] },
	});
	await (client as unknown as { setupPlugins(): Promise<void> }).setupPlugins();
	await client.reloadPluginContributions();
	client.handleCommand = new HandleCommand(client);
	return { client, command, component, modal };
}

function commandHandlerContext(client: Client, command: Command) {
	return interactionContext({
		client,
		command,
		author: { id: 'user-1' },
		options: {},
	});
}

function componentHandlerContext(client: Client, command: ComponentCommand | ModalCommand) {
	return interactionContext({
		client,
		command,
		customId: command.customId,
		author: { id: 'user-1' },
	});
}

function rawPrefixMessage() {
	return {
		id: 'message-1',
		channel_id: 'channel-1',
		guild_id: 'guild-1',
		content: '!custom-command',
		author: {
			id: 'user-1',
			username: 'tester',
			discriminator: '0',
			avatar: null,
		},
		attachments: [],
		components: [],
		embeds: [],
		mentions: [],
		mention_roles: [],
		mention_everyone: false,
		pinned: false,
		timestamp: '2026-07-10T12:00:00.000Z',
		tts: false,
		type: 0,
	};
}

describe('logger lifecycle regressions', () => {
	test('bare stop() emits one skipped event while other terminal paths stay singular', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ renderer: adapter });
		const options = getLoggerPluginOptions(plugin);
		const skip = createMiddleware<void>(({ stop }) => stop());
		const command = new SkipCommand();
		command.middlewares = ['skip'] as never;
		const context = interactionContext({
			client: { middlewares: { skip }, logger: { warn() {} } },
		});

		await options.contextScopes?.[0]?.(context, async () => {
			await options.commands.defaults.onBeforeMiddlewares(context);
			const result = await (
				command as unknown as { __runMiddlewares(ctx: unknown): Promise<{ pass?: boolean }> }
			).__runMiddlewares(context);
			assert.equal(result.pass, true);
		});

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.kind, 'command');
		assert.equal(adapter.entries[0].data.outcome, 'skipped');
		assert.equal(adapter.entries[0].message, 'command skipped');

		for (const [outcome, terminal] of [
			['success', (ctx: unknown) => options.commands.defaults.onAfterRun(ctx, undefined)],
			['denied', (ctx: unknown) => options.commands.defaults.onMiddlewaresError(ctx, 'owner only', {})],
			['error', (ctx: unknown) => options.commands.defaults.onRunError(ctx, new Error('boom'))],
		] as const) {
			const before = adapter.entries.length;
			const nextContext = interactionContext();
			await options.contextScopes?.[0]?.(nextContext, () => terminal(nextContext));
			assert.equal(adapter.entries.length, before + 1);
			assert.equal(adapter.entries.at(-1)?.data.outcome, outcome);
		}
	});

	test('real Seyfert handlers compose custom success hooks with one terminal event', async () => {
		const adapter = new RecordingAdapter();
		const { client, command, component, modal } = await setupLifecycleClient(adapter);

		try {
			await client.handleCommand.chatInput(
				command,
				{} as never,
				{} as never,
				commandHandlerContext(client, command) as never,
			);
			await client.components.execute(component, componentHandlerContext(client, component) as never);
			await client.components.execute(modal, componentHandlerContext(client, modal) as never);
		} finally {
			await client.close();
		}

		assert.deepEqual(command.afterErrors, [undefined]);
		assert.deepEqual(component.afterErrors, [undefined]);
		assert.deepEqual(modal.afterErrors, [undefined]);
		assert.deepEqual(
			adapter.entries.map(entry => entry.data.outcome),
			['success', 'success', 'success'],
		);
		assert.deepEqual(
			adapter.entries.map(entry => entry.data.kind),
			['command', 'component', 'modal'],
		);
	});

	test('real Seyfert handlers compose custom error hooks with one terminal event', async () => {
		const adapter = new RecordingAdapter();
		const { client, command, component, modal } = await setupLifecycleClient(adapter);
		command.throwOnRun = true;
		component.throwOnRun = true;
		modal.throwOnRun = true;

		try {
			await client.handleCommand.chatInput(
				command,
				{} as never,
				{} as never,
				commandHandlerContext(client, command) as never,
			);
			await client.components.execute(component, componentHandlerContext(client, component) as never);
			await client.components.execute(modal, componentHandlerContext(client, modal) as never);
		} finally {
			await client.close();
		}

		for (const artifact of [command, component, modal]) {
			assert.equal(artifact.runErrors.length, 1);
			assert.equal(artifact.afterErrors.length, 1);
			assert.equal(artifact.afterErrors[0], artifact.runErrors[0]);
		}
		assert.deepEqual(
			adapter.entries.map(entry => entry.data.outcome),
			['error', 'error', 'error'],
		);
		assert.deepEqual(
			adapter.entries.map(entry => entry.data.kind),
			['command', 'component', 'modal'],
		);
	});

	test('loaded command callbacks preserve custom option handling and emit one error', async () => {
		const adapter = new RecordingAdapter();
		const { client, command } = await setupLifecycleClient(adapter);
		command.options = [{ name: 'required', required: true }] as never;

		try {
			await client.handleCommand.chatInput(
				command,
				{} as never,
				{ getHoisted: () => undefined } as never,
				commandHandlerContext(client, command) as never,
			);
		} finally {
			await client.close();
		}

		assert.equal(command.optionErrors.length, 1);
		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.outcome, 'error');
		assert.equal(adapter.entries[0].message, 'command options failed');
	});

	test('real prefix permission hook failures correlate to one command internal error', async () => {
		const adapter = new RecordingAdapter();
		const { client, command } = await setupLifecycleClient(adapter);
		command.defaultMemberPermissions = 8n;
		command.throwOnPermissions = true;
		(client.members as unknown as { permissions(): Promise<unknown> }).permissions = async () => ({
			has: () => false,
			keys: () => ['Administrator'],
			missings: () => [8n],
			values: () => [8n],
		});
		(client.guilds as unknown as { raw(): Promise<unknown> }).raw = async () => ({ owner_id: 'owner-1' });

		try {
			await client.handleCommand.message(rawPrefixMessage() as never, 0);
		} finally {
			await client.close();
		}

		assert.equal(command.permissionCalls, 1);
		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.kind, 'command');
		assert.equal(adapter.entries[0].data.command, 'custom-command');
		assert.equal(adapter.entries[0].data.outcome, 'error');
		assert.equal(adapter.entries[0].message, 'command internal error');
	});

	test('real prefix runtime errors preserve custom hooks and emit one command failure', async () => {
		const adapter = new RecordingAdapter();
		const { client, command } = await setupLifecycleClient(adapter);
		command.throwOnRun = true;

		try {
			await client.handleCommand.message(rawPrefixMessage() as never, 0);
		} finally {
			await client.close();
		}

		assert.equal(command.runErrors.length, 1);
		assert.equal(command.afterErrors.length, 1);
		assert.equal(command.afterErrors[0], command.runErrors[0]);
		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.kind, 'command');
		assert.equal(adapter.entries[0].data.command, 'custom-command');
		assert.equal(adapter.entries[0].data.outcome, 'error');
		assert.equal(adapter.entries[0].message, 'command failed');
	});

	test('evlogTransport flushes an owned batched drain', async () => {
		const batches: unknown[][] = [];
		const drain = createDrainPipeline({ batch: { size: 50, intervalMs: 60_000 } })(batch => {
			batches.push(batch);
		});
		const adapter = evlogTransport({ _suppressDrainWarning: true, drain });

		await adapter.write({
			bindings: {},
			data: { jobId: 'job-1' },
			level: 'info',
			message: 'queued',
			time: new Date('2026-07-10T12:00:00.000Z'),
		});
		assert.equal(batches.length, 0);

		await adapter.flush?.();
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 1);
	});

	test('multiple clients require explicit ambient association and teardown stays client-local', async () => {
		const firstAdapter = new RecordingAdapter();
		const secondAdapter = new RecordingAdapter();
		const first = logger({ renderer: firstAdapter });
		const second = logger({ renderer: secondAdapter });
		const firstClient = fakeClient();
		const secondClient = fakeClient();
		const hostRecords: unknown[][] = [];
		const hostConsole: unknown[][] = [];
		const restoreHostLogger = SeyfertLogger.customize((self, level, args) => {
			hostRecords.push([self.name, level, args]);
			return args;
		});
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			hostConsole.push(args);
		};

		try {
			await first.setup?.(firstClient);
			await second.setup?.(secondClient);

			assert.throws(() => useLogger(), /Multiple @slipher\/logger clients are active/);
			await useLogger(firstClient).info('first');
			await useLogger({ client: secondClient }).info('second');

			new SeyfertLogger({ name: '[API]', active: true }).info('ambiguous internal');
			await Promise.resolve();
			assert.deepEqual(
				firstAdapter.entries.map(entry => entry.message),
				['first'],
			);
			assert.deepEqual(
				secondAdapter.entries.map(entry => entry.message),
				['second'],
			);
			assert.deepEqual(hostRecords, [['[API]', 1, ['ambiguous internal']]]);
			assert.deepEqual(hostConsole, [['ambiguous internal']]);

			await first.teardown?.(firstClient);
			await useLogger().info('second remains');
			assert.deepEqual(
				secondAdapter.entries.map(entry => entry.message),
				['second', 'second remains'],
			);
		} finally {
			await first.teardown?.(firstClient);
			await second.teardown?.(secondClient);
			restoreHostLogger();
			console.log = originalLog;
		}

		assert.throws(() => useLogger(), /before the @slipher\/logger plugin is set up/);
	});

	test('component and modal internal hooks log their third error argument', async () => {
		for (const kind of ['components', 'modals'] as const) {
			const adapter = new RecordingAdapter();
			const plugin = logger({ renderer: adapter });
			const options = getLoggerPluginOptions(plugin);
			const error = new Error(`${kind} exploded`);
			const context = interactionContext({ customId: `${kind}:confirm` });

			await options.contextScopes?.[0]?.(context, () =>
				options[kind].defaults.onInternalError({}, { customId: `${kind}:confirm` }, error),
			);

			assert.equal(adapter.entries.length, 1);
			assert.equal(adapter.entries[0].data.outcome, 'error');
			assert.equal(adapter.entries[0].data.error, error);
			assert.equal(adapter.entries[0].data.customId, `${kind}:confirm`);
			assert.equal(adapter.entries[0].message, `${kind === 'components' ? 'component' : 'modal'} internal error`);
		}
	});
});
