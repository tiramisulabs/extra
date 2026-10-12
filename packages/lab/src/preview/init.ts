import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { previewConfig } from './config';
import { previewWorkflow } from './workflow';

/** @internal */
export async function initializePreview(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: Object.fromEntries(
			[
				'provider',
				'project',
				'cwd',
				'domain',
				'install',
				'build',
				'dokploy-url',
				'environment-id',
				'server-id',
				'ssh-host',
			].map(key => [key, { type: 'string' as const }]),
		),
	});
	const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
	async function ask(key: string, prompt: string, fallback?: string): Promise<string> {
		if (values[key]) return String(values[key]);
		if (!terminal) {
			if (fallback) return fallback;
			throw new Error(`Pass --${key} when initializing without a terminal`);
		}
		const answer = (await terminal.question(`${prompt}${fallback ? ` [${fallback}]` : ''}: `)).trim();
		return answer || fallback || ask(key, prompt);
	}
	try {
		const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
		const manager = typeof packageJson.packageManager === 'string' ? packageJson.packageManager.split('@')[0] : 'npm';
		const install =
			manager === 'npm' ? 'npm ci' : `${manager} install ${manager === 'yarn' ? '--immutable' : '--frozen-lockfile'}`;
		const provider = await ask('provider', 'Hosting (dokploy or ssh)', 'dokploy');
		if (!['dokploy', 'ssh'].includes(provider)) throw new TypeError('Choose dokploy or ssh');
		const config = previewConfig({
			cwd: await ask('cwd', 'Bot directory inside the repository', '.'),
			project: await ask('project', 'Compiled lab project', 'dist/lab/project.js'),
			install: await ask('install', 'Install command', install),
			build: await ask('build', 'Build command', `${manager} run build`),
			domain: await ask('domain', 'Preview base domain (wildcard DNS points at your server)'),
			childEnv: [],
			provider:
				provider === 'dokploy'
					? {
							type: 'dokploy',
							url: await ask('dokploy-url', 'Dokploy URL'),
							environmentId: await ask('environment-id', 'Dokploy environment ID'),
							...(values['server-id'] ? { serverId: values['server-id'] } : {}),
						}
					: { type: 'ssh', host: await ask('ssh-host', 'SSH destination (user@hostname)') },
		});
		const files = [
			['lab.preview.json', `${JSON.stringify(config, null, 2)}\n`],
			['.github/workflows/lab-preview.yml', previewWorkflow()],
		];
		for (const [path] of files) {
			try {
				await access(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
			throw new Error(`${path} already exists; initialization never overwrites it`);
		}
		await mkdir('.github/workflows', { recursive: true });
		const written: string[] = [];
		try {
			for (const [path, content] of files) {
				await writeFile(path, content, { flag: 'wx' });
				written.push(path);
			}
		} catch (error) {
			await Promise.all(written.map(path => unlink(path)));
			throw error;
		}
		process.stdout.write(
			'Created lab.preview.json and .github/workflows/lab-preview.yml.\nConfigure the GitHub secrets listed in @slipher/lab/README.md before opening a PR.\n',
		);
		if (provider === 'ssh')
			process.stdout.write('On a dedicated server, run slipher-lab preview setup once to install its proxy.\n');
	} finally {
		terminal?.close();
	}
}
