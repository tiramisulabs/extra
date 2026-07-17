import { ApiHandler, type ApiRequestOptions, type HttpMethods, WorkerClient } from 'seyfert';
import { ProxyApiHandler, ProxyError, type ProxyServer } from '../src';

const handler: ApiHandler = new ProxyApiHandler({ url: 'http://127.0.0.1:4444', credential: 'service-credential' });
const request: (method: HttpMethods, url: `/${string}`, options?: ApiRequestOptions) => Promise<unknown> =
	handler.request.bind(handler);
const worker = new WorkerClient();
worker.setServices({ rest: handler });

declare const server: ProxyServer;
const stats: number = server.getStats().inFlightRequests;
declare const error: ProxyError;
const outcome: 'not_dispatched' | 'completed' | 'unknown' = error.outcome;

void request;
void stats;
void outcome;
