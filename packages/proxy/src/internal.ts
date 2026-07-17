import type { IncomingMessage, ServerResponse } from 'node:http';

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
	return value;
}

export function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer.`);
	return value;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function writeJson(res: ServerResponse, status: number, value: unknown): void {
	if (res.destroyed || res.writableEnded) return;
	const body = JSON.stringify(value);
	res.writeHead(status, {
		'content-length': Buffer.byteLength(body),
		'content-type': 'application/json; charset=utf-8',
	});
	res.end(body);
}

export function writeEmpty(res: ServerResponse, status: number): void {
	if (res.destroyed || res.writableEnded) return;
	res.writeHead(status, { 'content-length': '0' });
	res.end();
}

export async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const declaredLength = Number(req.headers['content-length']);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		req.pause();
		throw new PayloadTooLargeError();
	}

	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;

		const cleanup = () => {
			req.off('data', onData);
			req.off('end', onEnd);
			req.off('aborted', onAborted);
			req.off('error', onError);
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onData = (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > maxBytes) {
				req.pause();
				fail(new PayloadTooLargeError());
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = () => {
			cleanup();
			resolve(Buffer.concat(chunks, size));
		};
		const onAborted = () => fail(new Error('Request body was aborted.'));
		const onError = (error: Error) => fail(error);

		req.on('data', onData);
		req.once('end', onEnd);
		req.once('aborted', onAborted);
		req.once('error', onError);
	});
}

export class PayloadTooLargeError extends Error {
	constructor() {
		super('Request payload exceeds maxRequestBytes.');
	}
}
