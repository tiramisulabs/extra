import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { RawFile } from 'seyfert';
import { isRecord } from './internal';
import { isRequestId, parseWireRequest, type WireApiRequest } from './protocol';

export interface EncodedRequest {
	body: Buffer;
	contentType: string;
}

export interface TokenOverrideRequest {
	tokenOverride: true;
	requestId?: string;
}

export type DecodedApiRequest = WireApiRequest & { files?: RawFile[] };
export type DecodedProxyRequest = DecodedApiRequest | TokenOverrideRequest;

function fileDataToBuffer(data: RawFile['data']): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return Buffer.from(String(data));
}

function escapeDisposition(value: string): string {
	return value.replace(/[\r\n"]/g, character => (character === '"' ? '%22' : ''));
}

function safeContentType(value: string | undefined): string {
	return value && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) ? value : 'application/octet-stream';
}

export function encodeProxyRequest(request: WireApiRequest, files: readonly RawFile[] | undefined): EncodedRequest {
	const wire: WireApiRequest = {
		...request,
		...(files?.length ? { fileKeys: files.map(file => file.key ?? null) } : {}),
	};
	if (!files?.length) {
		return { body: Buffer.from(JSON.stringify(wire)), contentType: 'application/json' };
	}

	const boundary = `slipher-${randomBytes(18).toString('hex')}`;
	const chunks: Buffer[] = [];
	const append = (value: string | Buffer) => chunks.push(typeof value === 'string' ? Buffer.from(value) : value);
	append(
		`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n`,
	);
	append(JSON.stringify(wire));
	append('\r\n');

	for (const [index, file] of files.entries()) {
		const key = `files[${index}]`;
		const filename = escapeDisposition(file.filename);
		append(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${filename}"\r\n`);
		append(`Content-Type: ${safeContentType(file.contentType)}\r\n\r\n`);
		append(fileDataToBuffer(file.data));
		append('\r\n');
	}
	append(`--${boundary}--\r\n`);
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function decodeRawRequest(raw: unknown): DecodedProxyRequest | undefined {
	if (isRecord(raw) && raw.token !== undefined) {
		return { tokenOverride: true, ...(isRequestId(raw.requestId) ? { requestId: raw.requestId } : {}) };
	}
	return parseWireRequest(raw);
}

async function parseMultipart(
	body: Buffer,
	contentType: string,
): Promise<(WireApiRequest & { files: RawFile[] }) | TokenOverrideRequest | undefined> {
	const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
	const payload = form.get('payload_json');
	if (typeof payload !== 'string') return;
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return;
	}
	const request = decodeRawRequest(raw);
	if (!request || 'tokenOverride' in request) return request;

	const files: RawFile[] = [];
	for (const [key, value] of form.entries()) {
		if (key === 'payload_json' || typeof value === 'string') continue;
		// FormData iteration preserves insertion order, which pairs each part with its original RawFile key.
		const originalKey = request.fileKeys?.[files.length];
		files.push({
			...(originalKey === null ? {} : { key: originalKey ?? key }),
			filename: value.name,
			contentType: value.type || undefined,
			data: await value.arrayBuffer(),
		});
	}
	if (request.fileKeys && request.fileKeys.length !== files.length) return;
	return { ...request, files };
}

export async function decodeProxyRequest(
	body: Buffer,
	headers: IncomingHttpHeaders,
): Promise<DecodedProxyRequest | undefined> {
	const contentType = headers['content-type'];
	if (contentType?.toLowerCase().startsWith('multipart/form-data')) {
		return parseMultipart(body, contentType);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(body.toString());
	} catch {
		return;
	}
	if (!isRecord(raw)) return;
	return decodeRawRequest(raw);
}
