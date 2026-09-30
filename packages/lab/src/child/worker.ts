import { pathToFileURL } from 'node:url';
import type { JsonValue, Project, Session } from '../index';
import {
	type BridgeRequest,
	PROTOCOL_VERSION,
	type ProjectDescription,
	validateBridgeRequest,
	validateProjectDescription,
} from '../protocol';
import { createSession } from '../runtime';

const send = (message: unknown) => {
	if (process.connected) process.send?.(message);
};
const modulePath = process.argv[2];
const disposeTimeoutMs = Number(process.argv[3] ?? 5000);
let session: Session | undefined;
let queue = Promise.resolve();
async function loadProject(): Promise<Project> {
	try {
		const loaded = require(modulePath) as { default?: Project; project?: Project } | Project;
		return 'scenarios' in loaded
			? loaded
			: (loaded.project ?? loaded.default ?? Promise.reject(new Error('Project module has no project export')));
	} catch (error) {
		if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ERR_REQUIRE_ESM') throw error;
		const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: Project; project?: Project };
		return loaded.project ?? loaded.default ?? Promise.reject(new Error('Project module has no project export'));
	}
}
async function handle(request: BridgeRequest): Promise<JsonValue> {
	if (request.type === 'project.describe') {
		if (session) throw new Error('Cannot describe an active session');
		const project = await loadProject();
		const description: ProjectDescription = {
			name: project.name,
			scenarios: project.scenarios.map(({ id, version, title, params }) => ({
				id,
				version,
				title,
				params: params ?? {},
			})),
			services: Object.fromEntries(
				Object.entries(project.services ?? {}).map(([name, service]) => [
					name,
					{ default: service.default, variants: Object.keys(service.variants) },
				]),
			),
			inspectors: Object.keys(project.inspect ?? {}),
		};
		validateProjectDescription(description);
		return description as unknown as JsonValue;
	}
	if (request.type === 'session.start') {
		if (session) throw new Error('Session already started');
		const project = await loadProject();
		session = createSession(project, request.payload as unknown as import('../index').Preset, { disposeTimeoutMs });
		session.observe(event => send({ version: PROTOCOL_VERSION, type: 'event', event }));
		await session.start();
		return null;
	}
	if (!session) throw new Error('Session is not started');
	switch (request.type) {
		case 'session.dispose':
			await session.dispose();
			session = undefined;
			return null;
		case 'session.commandSchemas':
			return (await session.commandSchemas()) as unknown as JsonValue;
		case 'session.log':
			return (await session.log()) as unknown as JsonValue;
		case 'session.inspect':
			return (await session.inspect()) as unknown as JsonValue;
		case 'session.describe':
			return (await session.describe()) as unknown as JsonValue;
		case 'session.act':
			return (await session.act(request.payload as unknown as import('../index').LabAction)) as unknown as JsonValue;
		case 'session.view': {
			const { actor, channelRef } = request.payload as { actor: string; channelRef: string };
			return (await session.view(actor, channelRef)) as unknown as JsonValue;
		}
		case 'session.inspectProject': {
			const { name, args } = request.payload as { name: string; args: JsonValue };
			return await session.inspectProject(name, args);
		}
		default:
			throw new Error('Unknown child request');
	}
}
process.on('message', message => {
	queue = queue.then(async () => {
		try {
			validateBridgeRequest(message);
			send({ version: PROTOCOL_VERSION, type: 'result', id: message.id, ok: true, value: await handle(message) });
			if (message.type === 'session.dispose' || message.type === 'project.describe') process.disconnect?.();
		} catch (error) {
			const id =
				typeof message === 'object' && message !== null && 'id' in message && Number.isSafeInteger(message.id)
					? message.id
					: 0;
			send({
				version: PROTOCOL_VERSION,
				type: 'result',
				id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
});
