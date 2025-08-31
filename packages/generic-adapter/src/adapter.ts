import type { Logger, UsingClient } from 'seyfert';
import type { HttpServerAdapter } from 'seyfert/lib/client/types';
import { isCloudfareWorker } from 'seyfert/lib/common';
import { type APIInteraction, InteractionResponseType, InteractionType } from 'seyfert/lib/types';
import nacl from 'tweetnacl';

export class GenericAdapter implements HttpServerAdapter {
	publicKeyHex!: Uint8Array;
	applicationId!: string;
	debugger?: Logger;
	logger: Logger;

	constructor(public client: UsingClient) {
		this.logger = client.logger;
	}

	async start() {
		if (this.client.debugger) this.debugger = this.client.debugger;

		const { publicKey, applicationId } = await this.client.getRC();

		if (!publicKey) {
			throw new Error('Expected a publicKey, check your config file');
		}
		if (applicationId) {
			this.applicationId = applicationId;
		}
		this.publicKeyHex = new Uint8Array(Buffer.from(publicKey, 'hex'));
		this.logger.info('Running on <url>');
	}

	protected async verifySignature(req: Request) {
		const timestamp = req.headers.get('x-signature-timestamp');
		const ed25519 = req.headers.get('x-signature-ed25519') ?? '';
		const body = (await req.json()) as APIInteraction;
		if (
			nacl!.sign.detached.verify(
				Uint8Array.from(timestamp + JSON.stringify(body)),
				new Uint8Array(Buffer.from(ed25519, 'hex')),
				this.publicKeyHex,
			)
		) {
			return body;
		}
		return;
	}

	async fetch(req: Request) {
		const rawBody = await this.verifySignature(req);
		if (!rawBody) {
			this.debugger?.debug('Invalid request/No info, returning 418 status.');
			// I'm a teapot
			return new Response('', { status: 418 });
		}
		switch (rawBody.type) {
			case InteractionType.Ping: {
				this.debugger?.debug('Ping interaction received, responding.');
				return Response.json(
					{ type: InteractionResponseType.Pong },
					{
						headers: {
							'Content-Type': 'application/json',
						},
					},
				);
			}
			default: {
				if (isCloudfareWorker()) {
					// you can not do more net requests after responding.
					// so we use discord api instead
					return this.client.handleCommand
						.interaction(rawBody, -1)
						.then(() => new Response())
						.catch(() => new Response());
				}
				return new Promise(async r => {
					const { headers, response } = await this.client.onInteractionRequest(rawBody);
					r(
						response instanceof FormData
							? new Response(response, { headers })
							: Response.json(response, {
									headers,
								}),
					);
				});
			}
		}
	}
}
