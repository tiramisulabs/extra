import type { Logger, UsingClient } from 'seyfert';
import type { HttpServerAdapter } from 'seyfert/lib/client/types';
import { type APIInteraction, InteractionResponseType, InteractionType } from 'seyfert/lib/types';
import nacl from 'tweetnacl';
import { App, type HttpRequest, type HttpResponse, type TemplatedApp } from 'uWebSockets.js';
import type { File } from '../../../node_modules/.pnpm/undici-types@6.19.8/node_modules/undici-types/file';

export class UwsAdapter implements HttpServerAdapter {
	public app!: TemplatedApp;
	publicKeyHex!: Buffer;
	applicationId!: string;
	debugger?: Logger;
	logger: Logger;

	constructor(public client: UsingClient) {
		this.logger = client.logger;
	}

	async start(path: `/${string}` = '/interactions', uwsApp?: TemplatedApp) {
		if (this.client.debugger) this.debugger = this.client.debugger;

		const { publicKey, port, applicationId } = await this.client.getRC();

		if (!publicKey) {
			throw new Error('Expected a publicKey, check your config file');
		}
		if (!(port || uwsApp)) {
			throw new Error('Expected a port, check your config file');
		}
		if (applicationId) {
			this.applicationId = applicationId;
		}

		this.publicKeyHex = Buffer.from(publicKey, 'hex');
		this.app = uwsApp ?? App();
		this.app.post(path, this.onPacket.bind(this));

		if (uwsApp) {
			this.logger.info(`Running on <url>${path}`);
		} else {
			this.app.listen(port!, () => {
				this.logger.info(`Listening to <url>:${port}${path}`);
			});
		}
	}

	protected async verifySignature(res: HttpResponse, req: HttpRequest) {
		const timestamp = req.getHeader('x-signature-timestamp');
		const ed25519 = req.getHeader('x-signature-ed25519');
		const body = await UwsAdapter.readJson<APIInteraction>(res);
		if (
			nacl.sign.detached.verify(
				Buffer.from(timestamp + JSON.stringify(body)),
				Buffer.from(ed25519, 'hex'),
				this.publicKeyHex,
			)
		) {
			return body;
		}
		return;
	}

	protected async onPacket(res: HttpResponse, req: HttpRequest) {
		const rawBody = await this.verifySignature(res, req);
		if (!rawBody) {
			this.debugger?.debug('Invalid request/No info, returning 418 status.');
			// I'm a teapot
			res.writeStatus('418').end();
			return;
		}
		switch (rawBody.type) {
			case InteractionType.Ping: {
				this.debugger?.debug('Ping interaction received, responding.');
				res.writeHeader('Content-Type', 'application/json').end(JSON.stringify({ type: InteractionResponseType.Pong }));
				break;
			}
			default:
				res.cork(async () => {
					const { headers, response } = await this.client.onInteractionRequest(rawBody);
					for (const i in headers) {
						res.writeHeader(i, headers[i as keyof typeof headers]!);
					}
					if (response instanceof FormData) {
						const files: File[] = [];
						let body: string | undefined;
						for (const [key, value] of response.entries()) {
							if (key === 'payload_json') {
								body = value as string;
							} else {
								files.push(value as File);
							}
						}

						const boundary = `${Date.now() + Math.random().toString(10).slice(2)}`;
						res.cork(async () => {
							res.writeHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
							if (body) {
								res.write(
									`\r\n--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${body}`,
								);
							}
							if (files.length) {
								for (let i = 0; i < files.length; i++) {
									const file = files[i];

									const bytes = await file.bytes();
									res.cork(() => {
										res.write(
											`\r\n--${boundary}\r\nContent-Disposition: form-data; name="files[${i}]"; filename="${file.name}"${file.type ? `\r\nContent-Type: ${file.type}` : ''}\r\n\r\n`,
										);
										res.write(bytes);
									});
								}
							}
							res.cork(() => res.end(`\r\n--${boundary}--`));
						});
					} else res.end(JSON.stringify(response));
				});
				break;
		}
	}

	protected static readJson<T extends Record<string, any>>(res: HttpResponse) {
		return new Promise<T>((ok, rej) => {
			const buffers: Buffer[] = [];
			res.onData((ab, isLast) => {
				const chunk = Buffer.from(ab);
				if (isLast) {
					try {
						buffers.push(chunk);
						ok(JSON.parse(Buffer.concat(buffers).toString()));
					} catch (e) {
						res.close();
						return;
					}
				} else {
					buffers.push(chunk);
				}
			});

			res.onAborted(rej);
		});
	}
}
