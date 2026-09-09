async function verifyLifecycle() {
	const root = inject('consumer');
	const { Client } = require(path.join(root, 'node_modules/seyfert/lib/index.js'));
	const { HandleCommand } = require(path.join(root, 'node_modules/seyfert/lib/commands/handle.js'));
	const { ComponentHandler } = require(path.join(root, 'node_modules/seyfert/lib/components/handler.js'));
	const flows = await import(pathToFileURL(path.join(root, 'dist/lifecycle.js')));
	for (const family of [
		'Command',
		'SubCommand',
		'ComponentCommand',
		'ModalCommand',
		'ContextMenuCommand',
		'EntryPointCommand',
	]) {
		const chat = ['Command', 'SubCommand'].includes(family);
		const component = ['ComponentCommand', 'ModalCommand'].includes(family);
		for (const outcome of ['success', 'run-error', 'denial', 'internal', ...(chat ? ['options-error'] : [])]) {
			const client = new Client();
			client.middlewares = {
				staff: ({ next, stop }) => {
					if (outcome === 'denial') return stop('denied');
					if (outcome === 'internal') throw Error('middleware failed');
					next({ userId: 'staff' });
				},
			};
			const command = new flows[`Flow${family}`]();
			const internal = command.onInternalError;
			command.onInternalError = function (...args) {
				this.lastError = args[2];
				return internal.apply(this, args);
			};
			command.fail = outcome === 'run-error';
			const context = { client, command, metadata: {}, globalMetadata: {}, options: {} };
			const dispatcher = new HandleCommand(client);
			if (component) {
				await command._filter(context);
				await ComponentHandler.prototype.execute.call({ client }, command, context);
			} else if (chat) {
				const resolver = {
					getHoisted: () => (outcome === 'options-error' ? undefined : { value: 'query' }),
					getValue: () => 'query',
				};
				await dispatcher.chatInput(command, {}, resolver, context);
			} else if (family === 'ContextMenuCommand') await dispatcher.contextMenu(command, {}, context);
			else await dispatcher.entryPoint(command, {}, context);
			const start = component ? ['filter'] : chat ? ['options:before'] : [];
			const expected =
				outcome === 'options-error' ? [...start, 'options:failed'] : [...start, 'before', ...outcomeEvents[outcome]];
			expect(command.events, `${family}: ${outcome}: ${command.lastError?.stack ?? ''}`).toEqual(expected);
		}
	}
}

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, inject, test } from 'vitest';

const outcomeEvents = {
	success: ['run:staff', 'after:staff:ok'],
	denial: ['denied'],
	internal: ['internal'],
	'run-error': ['run:staff', 'error:staff', 'after:staff:error'],
};
const require = createRequire(import.meta.url);
test('contexts follow the real Seyfert lifecycle', verifyLifecycle);
