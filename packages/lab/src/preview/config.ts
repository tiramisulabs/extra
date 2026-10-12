import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isRecord } from '../protocol';

/** @internal */
export interface PreviewConfig {
	project: string;
	cwd: string;
	install: string;
	build: string;
	domain: string;
	childEnv: string[];
	provider:
		| { type: 'dokploy'; url: string; environmentId: string; serverId?: string }
		| { type: 'ssh'; host: string; port: number; proxyNetwork: string; certificateResolver: string };
}

/** @internal */
export async function readConfig(path: string): Promise<PreviewConfig> {
	return previewConfig(JSON.parse(await readFile(path, 'utf8')));
}

/** @internal */
export function previewConfig(value: unknown): PreviewConfig {
	if (!isRecord(value) || !isRecord(value.provider)) throw new TypeError('Expected a preview configuration');
	const project = text(value.project, 'project');
	if (isAbsolute(project) || project.split(/[\\/]/).includes('..'))
		throw new TypeError('project must be a path inside the repository');
	const cwd = text(value.cwd ?? '.', 'cwd');
	if (isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..') || /[\r\n]/.test(cwd))
		throw new TypeError('cwd must be a path inside the repository');
	const domain = text(value.domain, 'domain');
	if (!/^(?=.{1,200}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..'))
		throw new TypeError('domain must be a DNS hostname');
	const childEnv = value.childEnv ?? [];
	if (
		!Array.isArray(childEnv) ||
		childEnv.some(
			name => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('SLIPHER_LAB_'),
		)
	)
		throw new TypeError('childEnv must name the bot environment variables');
	const provider = value.provider;
	let target: PreviewConfig['provider'];
	if (provider.type === 'dokploy') {
		const url = new URL(text(provider.url, 'provider.url'));
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		)
			throw new TypeError('provider.url must be the Dokploy origin');
		target = {
			type: 'dokploy',
			url: url.origin,
			environmentId: text(provider.environmentId, 'provider.environmentId'),
			...(provider.serverId ? { serverId: text(provider.serverId, 'provider.serverId') } : {}),
		};
	} else if (provider.type === 'ssh') {
		const host = text(provider.host, 'provider.host');
		if (!/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
			throw new TypeError('provider.host must be [user@]hostname');
		const port = provider.port ?? 22;
		if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
			throw new TypeError('provider.port must be between 1 and 65535');
		target = {
			type: 'ssh',
			host,
			port,
			proxyNetwork: text(provider.proxyNetwork ?? 'slipher-lab-proxy', 'provider.proxyNetwork'),
			certificateResolver: text(provider.certificateResolver ?? 'letsencrypt', 'provider.certificateResolver'),
		};
	} else throw new TypeError('provider.type must be dokploy or ssh');
	return {
		project,
		cwd,
		domain,
		install: text(value.install, 'install'),
		build: text(value.build, 'build'),
		childEnv,
		provider: target,
	};
}

function text(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Missing preview ${label}`);
	return value;
}

/** @internal */
export function secret(name: string): string {
	return text(process.env[name], name);
}
