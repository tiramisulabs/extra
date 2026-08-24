import { ApiHandler, type ApiRequestOptions, type HttpMethods, WorkerClient } from 'seyfert';
import { createProxy, ProxyApiHandler, ProxyError, type ProxyServer } from '../src';

const handler: ApiHandler = new ProxyApiHandler({ url: 'http://127.0.0.1:4444', credential: 'service-credential' });
const request: (method: HttpMethods, url: `/${string}`, options?: ApiRequestOptions) => Promise<unknown> =
	handler.request.bind(handler);
const worker = new WorkerClient();
worker.setServices({ rest: handler });

declare const server: ProxyServer;
const stats: number = server.getStats().inFlightRequests;
const tokenContexts: number = server.getStats().tokenContexts;
const authenticatedGateOccupancy: number = server.getStats().authenticatedGateOccupancy;
const unauthenticatedGateOccupancy: number = server.getStats().unauthenticatedGateOccupancy;
// @ts-expect-error gate occupancy is scoped instead of exposing the old aggregate
server.getStats().globalGateOccupancy;
declare const error: ProxyError;
const outcome: 'not_dispatched' | 'completed' | 'unknown' = error.outcome;
const phase: string = error.phase;
const instanceId: string | undefined = error.instanceId;
declare const centralRest: ApiHandler;
const staticServer = createProxy({ rest: centralRest, credentials: ['hash'], port: 4444 });
const customServer = createProxy({
	rest: centralRest,
	authenticate: async () => ({ serviceId: 'workers' }),
	port: 4444,
});
// @ts-expect-error an authentication mechanism is required
void createProxy({ rest: centralRest, port: 4444 });
// @ts-expect-error static credentials and a custom authenticator are mutually exclusive
void createProxy({ rest: centralRest, credentials: ['hash'], authenticate: async () => null, port: 4444 });

void request;
void stats;
void tokenContexts;
void authenticatedGateOccupancy;
void unauthenticatedGateOccupancy;
void outcome;
void phase;
void instanceId;
void staticServer;
void customServer;
