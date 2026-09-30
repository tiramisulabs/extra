import type { JsonValue, LabAction, Session } from './index';
import type { BridgeRequest } from './protocol';

/** Runs a validated bridge request against a started session. Lifecycle requests are handled by the caller. */
export async function invokeSession(session: Session, request: BridgeRequest): Promise<JsonValue> {
	switch (request.type) {
		case 'session.act':
			return (await session.act(request.payload as unknown as LabAction)) as unknown as JsonValue;
		case 'session.view': {
			const { actor, channelRef } = request.payload as { actor: string; channelRef: string };
			return (await session.view(actor, channelRef)) as unknown as JsonValue;
		}
		case 'session.inspect':
			return (await session.inspect()) as unknown as JsonValue;
		case 'session.describe':
			return (await session.describe()) as unknown as JsonValue;
		case 'session.commandSchemas':
			return (await session.commandSchemas()) as unknown as JsonValue;
		case 'session.inspectProject': {
			const { name, args } = request.payload as { name: string; args?: JsonValue };
			return await session.inspectProject(name, args);
		}
		case 'session.log':
			return (await session.log()) as unknown as JsonValue;
		default:
			throw new Error(`Unsupported session request ${request.type}`);
	}
}
