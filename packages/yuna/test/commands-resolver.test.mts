import { Command, SubCommand, type UsingClient } from 'seyfert';
import { ApplicationCommandType } from 'seyfert/lib/types';
import { assert, describe, test, vi } from 'vitest';
import { Yuna } from '../src';
import { Keys } from '../src/things';
import { baseResolver } from '../src/utils/commandsResolver/base';
import { addCommandsEvents, getCommandsMetadata } from '../src/utils/commandsResolver/prepare';
import { YunaCommandsResolver } from '../src/utils/commandsResolver/resolver';

class TestCommand extends Command {}
class TestSubCommand extends SubCommand {}

function createCommand(data: Partial<Command> = {}) {
	return Object.assign(new TestCommand(), {
		name: 'parent',
		description: 'test command',
		type: ApplicationCommandType.ChatInput,
		...data,
	});
}

function createSubCommand(data: Partial<SubCommand> = {}) {
	return Object.assign(new TestSubCommand(), {
		name: 'child',
		description: 'test subcommand',
		...data,
	});
}

function createClient(commands: Command[] = []) {
	return {
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
		},
		commands: {
			values: commands,
			load: vi.fn(async () => 'loaded'),
			reloadAll: vi.fn(async () => 'reloaded'),
		},
	} as unknown as UsingClient;
}

describe('commands resolver', () => {
	test('clamps endPad to the last matched token when fallback resolution has no explicit subcommand', () => {
		const subCommand = createSubCommand({ name: 'play', group: 'admin' });
		const parent = createCommand({
			name: 'music',
			groups: {
				admin: {
					description: 'admin group',
				},
			},
			options: [subCommand],
		});
		const client = createClient([parent]);

		const result = baseResolver(
			client,
			'music',
			{ useFallbackSubCommand: true, inMessage: true },
			{
				findGroupName: () => 'admin',
			},
		);

		assert.equal(result?.command, subCommand);
		assert.equal(result?.endPad, 'music'.length);
	});

	test('awaits command preparation after wrapped command loads', async () => {
		const client = createClient([createCommand()]);
		let prepared = false;

		getCommandsMetadata(client).config = {
			whilePreparing: async () => {
				await new Promise(resolve => setTimeout(resolve, 0));
				prepared = true;
				return null;
			},
		};

		addCommandsEvents(client);

		await client.commands!.load();

		assert.equal(prepared, true);
	});

	test('passes resolver diagnostics to the logger when logResult is enabled', () => {
		const command = createCommand({ name: 'ping' });
		const client = createClient();
		const resolver = YunaCommandsResolver({
			client,
			logResult: true,
			extendSearch: () => ({
				findCommand: name => (name === command.name ? command : undefined),
			}),
		});

		resolver.call({} as never, 'ping value');

		const debug = client.logger.debug as ReturnType<typeof vi.fn>;
		assert.equal(debug.mock.calls[0][0], '[Yuna.resolver]');
		assert.equal(debug.mock.calls[0][1].resolverResult.command, command);
	});

	test('resolves shortcuts from commands already loaded before resolver creation', () => {
		const shortcut = createSubCommand({ name: 'play' });
		Object.assign(shortcut, { [Keys.resolverIsShortcut]: true });
		const parent = createCommand({
			name: 'music',
			options: [shortcut],
		});
		const client = createClient([parent]);
		const resolver = YunaCommandsResolver({ client });

		const result = resolver.call({} as never, 'play now');

		assert.equal(result.command, shortcut);
		assert.equal(result.parent, parent);
		assert.equal(result.argsContent, 'now');
	});

	test('does not narrow subcommand groups to direct subcommands', () => {
		const command = createCommand({
			options: [
				{
					name: 'admin',
					type: 2,
				},
			] as never,
		});

		assert.equal(Yuna.commands.isParent(command), false);
	});
});
