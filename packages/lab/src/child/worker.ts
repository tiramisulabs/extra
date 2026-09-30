import { pathToFileURL } from 'node:url';
import { asJson, invokeSession } from '../bridge';
import type { JsonValue, Project, Session } from '../index';
import {
	type BridgeEvent,
	type BridgeRequest,
	type BridgeResponse,
	PROTOCOL_VERSION,
	type ProjectDescription,
	validateBridgeRequest,
	validateProjectDescription,
} from '../protocol';
import { createSession } from '../runtime';
import { errorText } from '../shared';

// argv: project module path, then the in-process dispose timeout in ms; the parent always passes both.
const modulePath = process.argv[2];
const disposeTimeoutMs = Number(process.argv[3]);
let session: Session | undefined;
let queue = Promise.resolve();

const send = (message: BridgeResponse | BridgeEvent) => {
	if (process.connected) process.send?.(message);
};

type ProjectModule = Partial<Project> & { project?: Project; default?: Project };

/** Accepts a module exporting `project`, a default project, or the project itself, as CommonJS or ESM. */
async function loadProject(): Promise<Project> {
	let loaded: ProjectModule;
	try {
		loaded = require(modulePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ERR_REQUIRE_ESM') throw error;
		loaded = await import(pathToFileURL(modulePath).href);
	}
	const project = loaded.project ?? loaded.default ?? (loaded.scenarios ? (loaded as Project) : undefined);
	if (!project) throw new Error('Project module has no project export');
	return project;
}

function describeProject(project: Project): ProjectDescription {
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
	return description;
}

async function handle(request: BridgeRequest): Promise<JsonValue> {
	switch (request.type) {
		case 'project.describe':
			return asJson(describeProject(await loadProject()));
		case 'session.start': {
			if (session) throw new Error('Session already started');
			session = createSession(await loadProject(), request.payload, { disposeTimeoutMs });
			session.observe(event => send({ version: PROTOCOL_VERSION, type: 'event', event }));
			await session.start();
			return null;
		}
		case 'session.dispose':
			if (!session) throw new Error('Session is not started');
			await session.dispose();
			session = undefined;
			return null;
		default:
			if (!session) throw new Error('Session is not started');
			return invokeSession(session, request);
	}
}

/** The request ID to answer with, even when the request itself is invalid. */
function requestId(message: unknown): number {
	const id = typeof message === 'object' && message !== null && 'id' in message ? message.id : undefined;
	return typeof id === 'number' && Number.isSafeInteger(id) ? id : 0;
}

process.on('message', message => {
	queue = queue.then(async () => {
		try {
			validateBridgeRequest(message);
			send({ version: PROTOCOL_VERSION, type: 'result', id: message.id, ok: true, value: await handle(message) });
			// Both requests end the worker's job; disconnecting lets the process exit on its own.
			if (message.type === 'session.dispose' || message.type === 'project.describe') process.disconnect?.();
		} catch (error) {
			send({ version: PROTOCOL_VERSION, type: 'result', id: requestId(message), ok: false, error: errorText(error) });
		}
	});
});
