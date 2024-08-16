import { HttpClient, Logger, } from 'seyfert';
import { InternalRuntimeConfigHTTP } from 'seyfert/lib/client/base';
import { APIInteraction, InteractionResponseType, InteractionType } from 'seyfert/lib/types';
import type { HttpServerAdapter } from 'seyfert/lib/client/types';

import nacl from 'tweetnacl';
import { App, HttpRequest, HttpResponse, type TemplatedApp } from 'uWebSockets.js'

export class UwsAdapter implements HttpServerAdapter {
    public app!: TemplatedApp
    publicKeyHex!: Buffer;
    applicationId!: string;
    debugger?: Logger;
    logger!: Logger

    constructor(public client: HttpClient) {
        this.logger = client.logger
    }

    async start(path: `/${string}` = "/interactions", uwsApp?: TemplatedApp) {
        if (this.client.debugger) this.debugger = this.client.debugger

        const {
            publicKey,
            port,
            applicationId,
        } = await this.client.getRC<InternalRuntimeConfigHTTP>()

        if (!publicKey) {
            throw new Error('Expected a publicKey, check your config file');
        }
        if (!port && !uwsApp) {
            throw new Error('Expected a port, check your config file');
        }
        if (applicationId) {
            this.applicationId = applicationId;
        }

        this.publicKeyHex = Buffer.from(publicKey, 'hex');
        this.app = uwsApp ?? App()
        this.app.post(path, this.onPacket.bind(this));

        if (!uwsApp) {
            this.app.listen(port, () => {
                this.logger.info(`Listening to <url>:${port}${path}`);
            });
        } else {
            this.logger.info(`Running on <url>${path}`);
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
            return
        }
        switch (rawBody.type) {
            case InteractionType.Ping:
                this.debugger?.debug('Ping interaction received, responding.');
                res
                    .writeHeader('Content-Type', 'application/json')
                    .end(JSON.stringify({ type: InteractionResponseType.Pong }));
                break;
            default:
                res.cork(async () => {
                    const { headers, response } = await this.client.onPacket(rawBody)
                    for (const i in headers) {
                        res.writeHeader(i, headers[i as keyof typeof headers]!);
                    }
                    res.end(JSON.stringify(response))
                });
                return;
        }
    }

    protected static readJson<T extends Record<string, any>>(res: HttpResponse) {
        return new Promise<T>((ok, rej) => {
            const buffers: Buffer[] = [];
            res.onData((ab, isLast) => {
                const chunk = Buffer.from(ab);
                if (isLast) {
                    try {
                        buffers.push(chunk)
                        ok(JSON.parse(Buffer.concat(buffers).toString()));
                    } catch (e) {
                        res.close();
                        return;
                    }
                } else {
                    buffers.push(chunk)
                }
            });

            res.onAborted(rej);
        });
    }
}

const client = new HttpClient();

const uws = new UwsAdapter(client)

client.start()
    .then(() => {
        uws.start();
    });