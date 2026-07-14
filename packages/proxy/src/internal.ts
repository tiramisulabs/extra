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
		// Drain unread bytes before throwing so the server can still write a response on this socket.
		req.resume();
		throw new PayloadTooLargeError();
	}

	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > maxBytes) {
			// Drain unread bytes before throwing so the server can still write a response on this socket.
			req.resume();
			throw new PayloadTooLargeError();
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, size);
}

export class PayloadTooLargeError extends Error {
	constructor() {
		super('Request payload exceeds maxRequestBytes.');
	}
}
