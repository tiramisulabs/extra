import { createServer } from 'node:http';
import nacl from 'tweetnacl';

export const init = (options: AppOptions) => {
	const server = createServer((req, res) => {
		if (req.method !== 'POST') return res.writeHead(405).end();
		if (req.url !== options.path) return res.writeHead(401).end();

		let rawBody = '';

		req.on('data', chunk => {
			rawBody += chunk.toString(); // Append each chunk of data
		});

		req.on('end', () => {
			let verify: boolean;
			try {
				verify = verifySignature({
					timestamp: (req.headers['x-signature-timestamp'] as string) ?? '',
					ed25519: (req.headers['x-signature-ed25519'] as string) ?? '',
					body: rawBody,
					publicKey: options.publicKey,
				});
			} catch (e) {
				console.error(e);
				return res.writeHead(401).end();
			}

			if (verify) {
				const body = JSON.parse(rawBody);
				if (body.type === WebhookRequestType.Event) options.callback(body);
				return res.writeHead(204).end();
			}
			// collector speed goes brrrrrr
			rawBody = '';
			return res.writeHead(401).end();
		});

		return;
	});

	server.listen(options.port, options.listen);
	return server;
};

export function verifySignature({ timestamp, body, ed25519, publicKey }: SignatureOptions) {
	return nacl!.sign.detached.verify(
		Buffer.from(timestamp + body),
		Buffer.from(ed25519, 'hex'),
		Buffer.from(publicKey, 'hex'),
	);
}

export interface AppOptions {
	path: `/${string}`;
	port: number;
	publicKey: string;
	callback: (body: WebhookEventPayload) => unknown;
	listen?: () => void;
}

export interface SignatureOptions {
	timestamp: string;
	ed25519: string;
	body: string;
	publicKey: string;
}

export enum ApplicationIntegrationType {
	GuildInstall = 0,
	UserInstall = 1,
}

/**
 * https://discord.com/developers/docs/events/webhook-events#webhook-types
 */
export enum WebhookRequestType {
	/** PING event sent to verify your Webhook Event URL is active */
	PING = 0,
	/** Webhook event (details for event in event body object) */
	Event = 1,
}

/**
 * https://discord.com/developers/docs/events/webhook-events#event-types
 */
export enum WebhookEventTypes {
	/** Sent when an app was authorized by a user to a server or their account */
	ApplicationAuthorized = 'APPLICATION_AUTHORIZED',
	/** Entitlement was created */
	EntitlementCreate = 'ENTITLEMENT_CREATE',
	/**
	 * User was added to a Quest (currently unavailable)
	 * @unstable
	 */
	QuestUserEnrollment = 'QUEST_USER_ENROLLMENT',
}

/**
 * https://discord.com/developers/docs/events/webhook-events#webhook-event-payloads
 */
interface BaseWebhookEventPayload {
	/** Version scheme for the webhook event */
	version: 1;
	/**	ID of your app */
	application_id: string;
}

export type WebhookPingEventPayload = BaseWebhookEventPayload & { type: WebhookRequestType.PING };

export interface WebhookEventPayload extends BaseWebhookEventPayload {
	type: WebhookRequestType.Event;
	event: EventBodyObject;
}

type EventBodyObjectData<T extends WebhookEventTypes> = T extends WebhookEventTypes.ApplicationAuthorized
	? ApplicationAuthorizedEvent
	: EntitlementCreateEventType;

/**
 * https://discord.com/developers/docs/events/webhook-events#event-body-object
 */
export interface EventBodyObject<T extends WebhookEventTypes = WebhookEventTypes> {
	/** Event type */
	type: T;
	/** Timestamp of when the event occurred in ISO8601 format */
	timestamp: string;
	/** Data for the event. The shape depends on the event type */
	data?: EventBodyObjectData<T>;
}

/**
 * https://discord.com/developers/docs/events/webhook-events#application-authorized-application-authorized-structure
 */
export interface ApplicationAuthorizedEvent {
	/** Installation context for the authorization. Either guild (0) if installed to a server or user (1) if installed to a user's account */
	integration_type?: ApplicationIntegrationType;
	/** User who authorized the app */
	user: UserType;
	/** List of scopes the user authorized */
	scopes: string[];
	/**	Server which app was authorized for (when integration type is 0) */
	guild?: GuildType;
}

// For overwriting
export interface EntitlementCreateEventType {}
export interface UserType {}
export interface GuildType {}
