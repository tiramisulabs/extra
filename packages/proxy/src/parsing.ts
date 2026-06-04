import type { RawFile } from 'seyfert';

export interface MultipartFieldLike {
	name: string;
	data: ArrayBuffer;
	filename?: string;
}

export interface BadRequestResult {
	ok: false;
	status: 400;
	message: string;
}

export type JsonObjectResult = { ok: true; value: Record<string, unknown> } | BadRequestResult;
export type MultipartBodyResult =
	| { ok: true; body: Record<string, unknown> | undefined; files: RawFile[] }
	| BadRequestResult;

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(input: string | Buffer | ArrayBuffer): JsonObjectResult {
	const raw =
		typeof input === 'string'
			? input
			: Buffer.isBuffer(input)
				? input.toString()
				: Buffer.from(new Uint8Array(input)).toString();
	let value: unknown;

	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, status: 400, message: 'Malformed JSON body.' };
	}

	if (!isJsonObject(value)) return { ok: false, status: 400, message: 'Expected a JSON object body.' };
	return { ok: true, value };
}

export function parseMultipartBody(fields: MultipartFieldLike[]): MultipartBodyResult {
	let body: Record<string, unknown> | undefined;
	const files: RawFile[] = [];

	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.name === 'payload_json') {
			const parsed = parseJsonObject(field.data);
			if (!parsed.ok) return parsed;
			body = parsed.value;
			continue;
		}

		files.push({
			filename: field.filename || field.name || `file-${i}`,
			data: field.data,
		});
	}

	return { ok: true, body, files };
}
