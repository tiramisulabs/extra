import type { BlobPart } from 'node:buffer';
import type { IncomingHttpHeaders } from 'node:http';
import type { RawFile } from 'seyfert';
import { isRecord, PayloadTooLargeError } from './internal';
import { parseWireRequest, type WireApiRequest } from './protocol';

export interface EncodedRequest {
	body: Buffer;
	contentType: string;
}

type DecodedProxyRequest = WireApiRequest & { files?: RawFile[] };

interface ProxyPayloadLimits {
	maxFiles?: number;
	maxMetadataBytes?: number;
}

function fileDataToBlobPart(data: RawFile['data']): BlobPart {
	return typeof data === 'boolean' || typeof data === 'number' ? String(data) : (data as BlobPart);
}

export async function encodeProxyRequest(
	request: WireApiRequest,
	files: readonly RawFile[] | undefined,
): Promise<EncodedRequest> {
	const wire: WireApiRequest = {
		...request,
		...(files?.length ? { fileKeys: files.map(file => file.key ?? null) } : {}),
	};
	if (!files?.length) {
		return { body: Buffer.from(JSON.stringify(wire)), contentType: 'application/json' };
	}

	const form = new FormData();
	form.append('payload_json', JSON.stringify(wire));
	for (const [index, file] of files.entries()) {
		form.append(
			`files[${index}]`,
			new Blob([fileDataToBlobPart(file.data)], { type: file.contentType }),
			file.filename,
		);
	}
	const response = new Response(form);
	const contentType = response.headers.get('content-type');
	if (!contentType) throw new Error('FormData response is missing its content type.');
	return { body: Buffer.from(await response.arrayBuffer()), contentType };
}

async function parseMultipart(
	body: Buffer,
	contentType: string,
	limits: ProxyPayloadLimits,
): Promise<(WireApiRequest & { files: RawFile[] }) | undefined> {
	const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
	const payload = form.get('payload_json');
	if (typeof payload !== 'string') return;
	if (limits.maxMetadataBytes !== undefined && Buffer.byteLength(payload) > limits.maxMetadataBytes) {
		throw new PayloadTooLargeError('Proxy request metadata exceeds maxMetadataBytes.');
	}
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return;
	}
	const request = parseWireRequest(raw);
	if (!request) return;

	const files: RawFile[] = [];
	for (const [key, value] of form.entries()) {
		if (key === 'payload_json' || typeof value === 'string') continue;
		if (limits.maxFiles !== undefined && files.length >= limits.maxFiles) {
			throw new PayloadTooLargeError('Proxy request exceeds maxFiles.');
		}
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
	limits: ProxyPayloadLimits = {},
): Promise<DecodedProxyRequest | undefined> {
	const contentType = headers['content-type'];
	if (contentType?.toLowerCase().startsWith('multipart/form-data')) {
		return parseMultipart(body, contentType, limits);
	}
	if (limits.maxMetadataBytes !== undefined && body.byteLength > limits.maxMetadataBytes) {
		throw new PayloadTooLargeError('Proxy request metadata exceeds maxMetadataBytes.');
	}
	let raw: unknown;
	try {
		raw = JSON.parse(body.toString());
	} catch {
		return;
	}
	if (!isRecord(raw)) return;
	return parseWireRequest(raw);
}
