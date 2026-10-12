import { type PreviewConfig, secret } from './config';
import { deploymentEnvironment, previewOrigin, waitForPreview } from './deploy';
import { type PreviewSnapshot, previewName } from './github';

type Target = Extract<PreviewConfig['provider'], { type: 'dokploy' }>;
interface Application {
	applicationId: string;
	name: string;
	description?: string | null;
}

async function api<T>(target: Target, route: string, body?: Record<string, unknown>): Promise<T> {
	const response = await fetch(`${target.url}/api/${route}`, {
		method: body ? 'POST' : 'GET',
		headers: { 'x-api-key': secret('SLIPHER_LAB_DOKPLOY_KEY'), 'content-type': 'application/json' },
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Dokploy ${route.split('?')[0]} failed (${response.status})`);
	return response.json() as Promise<T>;
}

async function findApplication(
	target: Target,
	identity: Pick<PreviewSnapshot, 'repositoryId' | 'number'>,
): Promise<Application | undefined> {
	const environment = await api<{ applications: Application[] }>(
		target,
		`environment.one?environmentId=${encodeURIComponent(target.environmentId)}`,
	);
	if (!Array.isArray(environment.applications)) throw new Error('Dokploy environment.one did not return applications');
	const matching = environment.applications.filter(app => app.name === previewName(identity));
	if (matching.length > 1) throw new Error('Multiple Dokploy applications use this preview identity');
	const app = matching[0];
	if (app && (app.description !== owner(identity) || typeof app.applicationId !== 'string'))
		throw new Error('Dokploy resource is not owned by this lab preview');
	return app;
}

function owner(identity: Pick<PreviewSnapshot, 'repositoryId' | 'number'>): string {
	return `slipher-lab:${previewName(identity)}`;
}

/** @internal */
export async function deployDokploy(config: PreviewConfig, snapshot: PreviewSnapshot, image: string): Promise<string> {
	if (config.provider.type !== 'dokploy') throw new TypeError('Expected Dokploy configuration');
	const target = config.provider;
	const env = deploymentEnvironment(config, snapshot);
	const username = secret('SLIPHER_LAB_REGISTRY_USERNAME');
	const password = secret('SLIPHER_LAB_REGISTRY_TOKEN');
	let app = await findApplication(target, snapshot);
	const created = !app;
	if (!app) {
		app = await api<Application>(target, 'application.create', {
			name: previewName(snapshot),
			appName: previewName(snapshot),
			description: owner(snapshot),
			environmentId: target.environmentId,
			sourceType: 'docker',
			...(target.serverId ? { serverId: target.serverId } : {}),
		});
		if (typeof app.applicationId !== 'string') throw new Error('Dokploy did not return an applicationId');
	}
	const applicationId = app.applicationId;
	try {
		await api(target, 'application.saveDockerProvider', {
			applicationId,
			dockerImage: image,
			username,
			password,
			registryUrl: image.split('/')[0],
		});
		await api(target, 'application.saveEnvironment', {
			applicationId,
			env: Object.entries(env)
				.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
				.join('\n'),
			buildArgs: null,
			buildSecrets: null,
			createEnvFile: false,
		});
		const domains = await api<{ host: string }[]>(
			target,
			`domain.byApplicationId?applicationId=${encodeURIComponent(applicationId)}`,
		);
		if (!Array.isArray(domains)) throw new Error('Dokploy did not return application domains');
		const origin = previewOrigin(config, snapshot);
		const host = new URL(origin).hostname;
		if (!domains.some(domain => domain.host === host))
			await api(target, 'domain.create', {
				applicationId,
				host,
				port: 8080,
				https: true,
				certificateType: 'letsencrypt',
				path: '/',
				stripPath: false,
			});
		await api(target, 'application.deploy', {
			applicationId,
			title: `Lab PR #${snapshot.number}`,
			description: snapshot.headRefOid,
		});
		await waitForPreview(origin, snapshot);
		return origin;
	} catch (error) {
		if (created) {
			try {
				await api(target, 'application.delete', { applicationId });
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], 'Deployment failed; cleanup of the new Dokploy preview also failed');
			}
		}
		throw error;
	}
}

/** @internal A retry after deletion is a no-op; same-named resources without our marker are never deleted. */
export async function destroyDokploy(
	config: PreviewConfig,
	identity: Pick<PreviewSnapshot, 'repositoryId' | 'number'>,
): Promise<void> {
	if (config.provider.type !== 'dokploy') throw new TypeError('Expected Dokploy configuration');
	const app = await findApplication(config.provider, identity);
	if (app) await api(config.provider, 'application.delete', { applicationId: app.applicationId });
}
