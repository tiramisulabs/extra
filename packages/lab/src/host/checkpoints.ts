import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isCheckpointName, validateCheckpointName } from '../protocol';
import { HttpError, isErrnoCode, isWithin, validated } from './http';

// Checkpoints are `<name>.json` files in a run's directory. Names are validated and symlinks refused so a request
// can never read or overwrite a file outside that directory.

async function containedCheckpointFile(dir: string, name: string): Promise<string> {
	validated(() => validateCheckpointName(name));
	const file = resolve(dir, `${name}.json`);
	const root = await realpath(dir);
	try {
		if ((await lstat(file)).isSymbolicLink()) throw new HttpError(400, `Checkpoint "${name}" must not be a symlink`);
		if (!isWithin(root, await realpath(file))) throw new HttpError(400, `Checkpoint "${name}" is outside dataDir`);
	} catch (error) {
		if (!isErrnoCode(error, 'ENOENT')) throw error;
	}
	return file;
}

export async function listCheckpoints(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir))
			.filter(name => name.endsWith('.json'))
			.map(name => name.slice(0, -'.json'.length))
			.filter(isCheckpointName)
			.sort();
	} catch (error) {
		if (isErrnoCode(error, 'ENOENT')) return [];
		throw error;
	}
}

/** Returns the parsed, not yet validated, JSON of a checkpoint. */
export async function readCheckpoint(dir: string, name: string): Promise<unknown> {
	try {
		const handle = await open(await containedCheckpointFile(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			return JSON.parse(await handle.readFile('utf8')) as unknown;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isErrnoCode(error, 'ENOENT')) throw new HttpError(404, `Checkpoint "${name}" not found`);
		if (isErrnoCode(error, 'ELOOP')) throw new HttpError(400, `Checkpoint "${name}" must not be a symlink`);
		if (error instanceof SyntaxError) throw new HttpError(400, `Checkpoint "${name}" contains invalid JSON`);
		throw error;
	}
}

/**
 * Writes atomically through a temporary file. `assertActive` runs between steps so a run that ends meanwhile does
 * not leave a checkpoint behind.
 */
export async function writeCheckpoint(
	dir: string,
	checkpoint: { name: string },
	assertActive: () => void,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	assertActive();
	const file = await containedCheckpointFile(dir, checkpoint.name);
	assertActive();
	const temp = resolve(dir, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' });
		assertActive();
		await rename(temp, file);
		assertActive();
	} finally {
		await unlink(temp).catch(error => {
			if (!isErrnoCode(error, 'ENOENT')) throw error;
		});
	}
}
