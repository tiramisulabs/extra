import { type HostInfo, isRecord, validateHostInfo } from '../protocol';
import { type PreviewConfig, secret } from './config';
import { type PreviewSnapshot, previewName } from './github';

/** @internal */
export function deploymentEnvironment(config: PreviewConfig, snapshot: PreviewSnapshot): Record<string, string> {
	const given = environmentValues(process.env.SLIPHER_LAB_ENV || '{}');
	const env: Record<string, string> = {
		SLIPHER_LAB_PASSWORD: secret('SLIPHER_LAB_PASSWORD'),
		SLIPHER_LAB_PUBLIC_ORIGIN: previewOrigin(config, snapshot),
	};
	for (const name of config.childEnv) {
		if (typeof given[name] !== 'string') throw new Error(`Missing bot environment variable ${name}`);
		env[name] = given[name];
	}
	return { SLIPHER_LAB_DEPLOY_ENV: Buffer.from(JSON.stringify(env)).toString('base64') };
}

/** @internal */
export function previewOrigin(
	config: PreviewConfig,
	snapshot: Pick<PreviewSnapshot, 'repositoryId' | 'number'>,
): string {
	return `https://${previewName(snapshot)}.${config.domain}`;
}

/** @internal Readiness includes the workflow identity: an old deployment on the same SHA cannot pass. */
export async function waitForPreview(origin: string, snapshot: PreviewSnapshot): Promise<void> {
	const authorization = `Basic ${Buffer.from(`lab:${secret('SLIPHER_LAB_PASSWORD')}`).toString('base64')}`;
	const deadline = Date.now() + 5 * 60_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${origin}/api/host`, {
				headers: { authorization },
				signal: AbortSignal.timeout(10_000),
			});
			if (response.ok) {
				const info = (await response.json()) as HostInfo;
				validateHostInfo(info);
				if (info.build?.revision === snapshot.headRefOid && info.build.url === snapshot.runUrl) return;
			}
		} catch {
			/* The proxy may still be obtaining its certificate or replacing the container. */
		}
		await new Promise(done => setTimeout(done, 1000));
	}
	throw new Error('Preview did not become ready on the captured commit and workflow');
}

/** @internal One encoding across provider dotenv and Compose, preserving quotes, newlines and dollar signs. */
export function applyDeploymentEnvironment(): void {
	const packet = process.env.SLIPHER_LAB_DEPLOY_ENV;
	if (!packet) return;
	const env = environmentValues(Buffer.from(packet, 'base64').toString());
	if (
		!isRecord(env) ||
		Object.entries(env).some(
			([name, value]) =>
				!/^[A-Z_][A-Z0-9_]*$/.test(name) ||
				typeof value !== 'string' ||
				(name.startsWith('SLIPHER_LAB_') && !['SLIPHER_LAB_PASSWORD', 'SLIPHER_LAB_PUBLIC_ORIGIN'].includes(name)),
		)
	)
		throw new TypeError('Invalid lab deployment environment');
	Object.assign(process.env, env);
	delete process.env.SLIPHER_LAB_DEPLOY_ENV;
}

function environmentValues(json: string): Record<string, string> {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new TypeError('Lab deployment environment must contain valid JSON');
	}
	if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'string'))
		throw new TypeError('Lab deployment environment must be a JSON object of strings');
	return value as Record<string, string>;
}
