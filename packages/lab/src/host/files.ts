import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DiscordEpoch } from 'seyfert/lib/common';
import type { Checkpoint, LabAction, ModalAttachment } from '../index';
import { HttpError, isErrnoCode } from './http';
import { assertActive, type Run } from './run';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ASSET_ID = /^[a-f0-9]{64}$/;
export const FILE_PREFIX = '/api/files/';

function fileUrl(origin: string, run: Run, asset: string, filename: string): string {
	return `${origin}${FILE_PREFIX}${run.id || 'local'}/${asset}/${encodeURIComponent(filename)}`;
}

/** Files live beside checkpoints, outside the JSON/RPC payload. */
export async function uploadFile(run: Run, req: IncomingMessage, origin: string): Promise<ModalAttachment> {
	let filename: string;
	try {
		filename = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
	} catch {
		throw new HttpError(400, 'Invalid filename');
	}
	if (!filename || filename.length > 255 || /[\/\x00-\x1f]/.test(filename))
		throw new HttpError(400, 'Invalid filename');
	const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
	if (!/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(contentType)) throw new HttpError(400, 'Invalid content type');
	if (Number(req.headers['content-length']) > MAX_FILE_BYTES) throw new HttpError(413, 'File exceeds 25 MiB');
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > MAX_FILE_BYTES) throw new HttpError(413, 'File exceeds 25 MiB');
		chunks.push(bytes);
	}
	assertActive(run);
	const asset = randomBytes(32).toString('hex');
	const dir = resolve(run.checkpointsDir, 'files');
	await mkdir(dir, { recursive: true });
	assertActive(run);
	const file: ModalAttachment = {
		id: String(((BigInt(Date.now()) - DiscordEpoch) << 22n) | BigInt(randomBytes(3).readUIntBE(0, 3) & 0x3fffff)),
		asset,
		filename,
		size,
		content_type: contentType,
		url: fileUrl(origin, run, asset, filename),
	};
	const bytesPath = resolve(dir, `${asset}.bin`),
		metadataPath = resolve(dir, `${asset}.json`);
	try {
		await writeFile(bytesPath, Buffer.concat(chunks), { flag: 'wx' });
		assertActive(run);
		await writeFile(metadataPath, JSON.stringify(file), { flag: 'wx' });
		assertActive(run);
		return file;
	} catch (error) {
		await Promise.all([unlink(bytesPath).catch(() => undefined), unlink(metadataPath).catch(() => undefined)]);
		throw error;
	}
}

async function readFileMetadata(run: Run, asset: string): Promise<ModalAttachment> {
	if (!ASSET_ID.test(asset)) throw new HttpError(404, 'File not found');
	try {
		const handle = await open(
			resolve(run.checkpointsDir, 'files', `${asset}.json`),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			return JSON.parse(await handle.readFile('utf8')) as ModalAttachment;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ELOOP')) throw new HttpError(404, 'File not found');
		throw error;
	}
}

/** The random asset URL is the download capability, so bot fetches need no browser cookie. */
export async function downloadFile(run: Run, asset: string, res: ServerResponse, head: boolean): Promise<void> {
	const file = await readFileMetadata(run, asset);
	let handle;
	try {
		handle = await open(
			resolve(run.checkpointsDir, 'files', `${asset}.bin`),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
	} catch (error) {
		if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ELOOP')) throw new HttpError(404, 'File not found');
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new HttpError(404, 'File not found');
		res.writeHead(200, {
			'content-type': file.content_type ?? 'application/octet-stream',
			'content-length': stat.size,
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		});
		if (head) {
			res.end();
			return;
		}
		await pipeline(handle.createReadStream({ autoClose: false }), res);
	} finally {
		await handle.close();
	}
}

/** Resolve saved assets on this host/run, including after a local host changes port. */
export async function resolveActionFiles(run: Run, action: LabAction, origin: string): Promise<void> {
	if (action.kind !== 'user' || action.verb !== 'submitModal') return;
	for (const value of Object.values(action.fields)) {
		if (!Array.isArray(value)) continue;
		for (let i = 0; i < value.length; i++) {
			const file = value[i];
			if (typeof file === 'string' || !file.asset) continue;
			const stored = await readFileMetadata(run, file.asset);
			value[i] = { ...stored, url: fileUrl(origin, run, file.asset, stored.filename) };
		}
	}
}
export async function resolveCheckpointFiles(run: Run, checkpoint: Checkpoint, origin: string): Promise<void> {
	for (const action of checkpoint.actions) await resolveActionFiles(run, action, origin);
}
