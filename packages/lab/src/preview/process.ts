import { spawn } from 'node:child_process';

/** @internal Arguments are never interpreted by a local shell. Input can contain deployment credentials. */
export function command(bin: string, args: string[], input?: string): Promise<void> {
	return new Promise((done, reject) => {
		const child = spawn(bin, args, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
		child.once('error', reject);
		child.once('exit', code => (code === 0 ? done() : reject(new Error(`${bin} exited with ${code}`))));
		if (input !== undefined) {
			child.stdin!.on('error', reject);
			child.stdin!.end(input);
		}
	});
}
