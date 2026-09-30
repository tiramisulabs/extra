import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { LabHost } from '../src/host';

const dataDirs: string[] = [];

/** A fresh host data directory, removed by the next `closeHosts`. */
export async function tempDataDir(): Promise<string> {
	const dataDir = await mkdtemp(resolve(tmpdir(), 'slipher-lab-'));
	dataDirs.push(dataDir);
	return dataDir;
}

/** Closes and forgets `hosts`, then removes every data directory created since the last call. */
export async function closeHosts(hosts: LabHost[]): Promise<void> {
	try {
		for (const host of hosts.splice(0)) await host.close();
	} finally {
		for (const dataDir of dataDirs.splice(0)) await rm(dataDir, { recursive: true, force: true });
	}
}
