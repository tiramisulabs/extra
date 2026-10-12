import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { describeChildProject } from '../child';
import { pullRequestPreset } from '../host/preview';
import { validatePreset } from '../protocol';
import { readConfig, secret } from './config';
import { deployDokploy, destroyDokploy } from './dokploy';
import {
	assertCurrent,
	capturePullRequest,
	eventIdentity,
	isPullRequestClosed,
	publishDeployment,
	readSnapshot,
	retireDeployments,
} from './github';
import { deploySsh, destroySsh, setupSsh } from './ssh';

/** @internal */
export async function previewCommand(argv: string[]): Promise<void> {
	const [operation, ...args] = argv;
	const { values } = parseArgs({
		args,
		options: {
			config: { type: 'string', default: 'lab.preview.json' },
			source: { type: 'string', default: '.' },
			image: { type: 'string' },
		},
	});
	const config = await readConfig(values.config!);
	const source = resolve(values.source!);
	if (operation === 'setup') return setupSsh(config);
	if (operation === 'destroy') {
		const identity = await eventIdentity();
		if (!(await isPullRequestClosed(identity))) {
			process.stdout.write('PR is open; skipping stale preview cleanup\n');
			return;
		}
		if (config.provider.type === 'dokploy') await destroyDokploy(config, identity);
		else await destroySsh(config, identity);
		await retireDeployments(identity);
		return;
	}
	if (operation === 'validate') {
		const snapshot = await readSnapshot(source);
		const description = await describeChildProject({
			projectModule: resolve(source, config.cwd, config.project),
			cwd: resolve(source, config.cwd),
		});
		const preset =
			pullRequestPreset(snapshot, snapshot.headRefOid) ??
			(description.setup ? { scenario: description.setup } : undefined);
		if (!preset) throw new Error('A PR without a recipe requires project.setup');
		validatePreset(preset, description);
		return;
	}
	if (operation === 'prepare') {
		const snapshot = await capturePullRequest(source);
		const directory = resolve(source, '.slipher-preview');
		await mkdir(directory, { recursive: true });
		await writeFile(resolve(directory, 'pr.json'), JSON.stringify(snapshot, null, 2));
		await writeFile(resolve(directory, 'config.json'), JSON.stringify(config, null, 2));
		const args = [
			'--project',
			`${config.cwd}/${config.project}`,
			'--cwd',
			config.cwd,
			'--host',
			'0.0.0.0',
			'--port',
			'8080',
			'--access',
			'basic',
			'--data',
			'/data',
			'--pr',
			'/app/.slipher-preview/pr.json',
			'--build-revision',
			snapshot.headRefOid,
			'--build-ref',
			`${snapshot.repository}#${snapshot.number}`,
			'--build-url',
			snapshot.runUrl,
			...config.childEnv.flatMap(name => ['--child-env', name]),
		];
		const dockerfile = [
			'FROM node:24-bookworm-slim',
			'WORKDIR /app',
			'COPY . .',
			'RUN corepack enable',
			`RUN ${JSON.stringify(['sh', '-c', config.install])}`,
			`RUN ${JSON.stringify(['sh', '-c', config.build])}`,
			'COPY .slipher-preview/pr.json .slipher-preview/config.json .slipher-preview/',
			`RUN ${JSON.stringify([`${config.cwd}/node_modules/.bin/slipher-lab`, 'preview', 'validate', '--config', '.slipher-preview/config.json'])}`,
			'RUN mkdir -p /data && chown node:node /data',
			'USER node',
			'EXPOSE 8080',
			`CMD ${JSON.stringify([`${config.cwd}/node_modules/.bin/slipher-lab`, ...args])}`,
			'',
		].join('\n');
		await writeFile(resolve(directory, 'Dockerfile'), dockerfile);
		await writeFile(
			resolve(directory, 'Dockerfile.dockerignore'),
			'.git\n**/node_modules\n.env\n.env.*\n**/.env\n**/.env.*\n**/*.pem\n',
		);
		const image = `ghcr.io/${snapshot.repository.toLowerCase()}-lab:pr-${snapshot.number}-${snapshot.headRefOid}-${secret('GITHUB_RUN_ID')}-${secret('GITHUB_RUN_ATTEMPT')}`;
		await output('image', image);
		return;
	}
	if (operation === 'deploy') {
		const snapshot = await readSnapshot(source);
		await assertCurrent(snapshot);
		const image = values.image;
		if (!image || !/^[a-z0-9][a-z0-9./_:@-]+$/.test(image) || !image.includes('@sha256:'))
			throw new TypeError('--image must be an immutable registry image digest');
		const url =
			config.provider.type === 'dokploy'
				? await deployDokploy(config, snapshot, image)
				: await deploySsh(config, snapshot, image);
		await publishDeployment(snapshot, url);
		await output('url', url);
		if (process.env.GITHUB_STEP_SUMMARY)
			await appendFile(
				process.env.GITHUB_STEP_SUMMARY,
				`### Lab preview\n\n[Open PR #${snapshot.number}](${url})\n\nCommit: ${snapshot.headRefOid}\n`,
			);
		return;
	}
	throw new Error(
		'Usage: slipher-lab preview prepare|validate|deploy|destroy|setup [--config lab.preview.json] [--source dir] [--image digest]',
	);
}

async function output(name: string, value: string): Promise<void> {
	if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	process.stdout.write(`${name}: ${value}\n`);
}
