import type { JsonValue, Session } from './index';
import type { BridgeRequest } from './protocol';

/**
 * Session results are plain data that crosses IPC or HTTP as JSON; their declared types
 * (with optional properties and Discord payload interfaces) just are not written as `JsonValue`.
 */
export const asJson = (value: unknown): JsonValue => value as JsonValue;

/** Runs a validated bridge request against a started session. Lifecycle requests are handled by the caller. */
export async function invokeSession(session: Session, request: BridgeRequest): Promise<JsonValue> {
	switch (request.type) {
		case 'session.act':
			return asJson(await session.act(request.payload));
		case 'session.view':
			return asJson(await session.view(request.payload.actor, request.payload.channelRef));
		case 'session.inspect':
			return asJson(await session.inspect());
		case 'session.describe':
			return asJson(await session.describe());
		case 'session.commandSchemas':
			return asJson(await session.commandSchemas());
		case 'session.inspectProject':
			return await session.inspectProject(request.payload.name, request.payload.args);
		case 'session.log':
			return asJson(await session.log());
		default:
			throw new Error(`Unsupported session request ${request.type}`);
	}
}
