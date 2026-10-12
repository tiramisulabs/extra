import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PreviewConfig, secret } from './config';
import { deploymentEnvironment, previewOrigin, waitForPreview } from './deploy';
import { type PreviewSnapshot, previewName } from './github';
import { command } from './process';

type Target = Extract<PreviewConfig['provider'], { type: 'ssh' }>;

async function remote(target: Target, script: string): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), 'slipher-lab-ssh-'));
	try {
		const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', String(target.port)];
		if (process.env.SLIPHER_LAB_SSH_KEY) {
			const key = join(directory, 'key');
			const hosts = join(directory, 'known_hosts');
			await writeFile(
				key,
				process.env.SLIPHER_LAB_SSH_KEY.endsWith('\n')
					? process.env.SLIPHER_LAB_SSH_KEY
					: `${process.env.SLIPHER_LAB_SSH_KEY}\n`,
				{ mode: 0o600 },
			);
			await writeFile(hosts, secret('SLIPHER_LAB_SSH_KNOWN_HOSTS'), { mode: 0o600 });
			args.push('-i', key, '-o', `UserKnownHostsFile=${hosts}`);
		}
		await command('ssh', [...args, target.host, 'sh', '-s'], `set -eu\numask 077\n${script}\n`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function encoded(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64');
}

/** @internal */
export async function deploySsh(config: PreviewConfig, snapshot: PreviewSnapshot, image: string): Promise<string> {
	if (config.provider.type !== 'ssh') throw new TypeError('Expected SSH configuration');
	const name = previewName(snapshot);
	const origin = previewOrigin(config, snapshot);
	const env = deploymentEnvironment(config, snapshot);
	const auth = Buffer.from(
		`${secret('SLIPHER_LAB_REGISTRY_USERNAME')}:${secret('SLIPHER_LAB_REGISTRY_TOKEN')}`,
	).toString('base64');
	const target = config.provider;
	const compose = {
		services: {
			lab: {
				image,
				restart: 'unless-stopped',
				environment: env,
				volumes: ['data:/data'],
				networks: ['proxy'],
				labels: {
					'traefik.enable': 'true',
					'traefik.docker.network': target.proxyNetwork,
					[`traefik.http.routers.${name}.rule`]: `Host(\`${new URL(origin).hostname}\`)`,
					[`traefik.http.routers.${name}.entrypoints`]: 'websecure',
					[`traefik.http.routers.${name}.tls.certresolver`]: target.certificateResolver,
					[`traefik.http.services.${name}.loadbalancer.server.port`]: '8080',
				},
			},
		},
		volumes: { data: {} },
		networks: { proxy: { external: true, name: target.proxyNetwork } },
	};
	await remote(
		target,
		`
root="$HOME/.slipher-lab/${name}"
mkdir -p "$root"
if [ -f "$root/owner" ] && [ "$(cat "$root/owner")" != '${name}' ]; then exit 1; fi
printf '%s' '${name}' > "$root/owner"
printf '%s' '${encoded(compose)}' | base64 -d > "$root/compose.json"
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' '${encoded({ auths: { [image.split('/')[0]]: { auth } } })}' | base64 -d > "$DOCKER_CONFIG/config.json"
docker compose -p '${name}' -f "$root/compose.json" pull
docker compose -p '${name}' -f "$root/compose.json" up -d --remove-orphans
`,
	);
	await waitForPreview(origin, snapshot);
	return origin;
}

/** @internal */
export async function destroySsh(
	config: PreviewConfig,
	identity: Pick<PreviewSnapshot, 'repositoryId' | 'number'>,
): Promise<void> {
	if (config.provider.type !== 'ssh') throw new TypeError('Expected SSH configuration');
	const name = previewName(identity);
	await remote(
		config.provider,
		`
root="$HOME/.slipher-lab/${name}"
if [ ! -d "$root" ]; then exit 0; fi
[ "$(cat "$root/owner")" = '${name}' ]
docker compose -p '${name}' -f "$root/compose.json" down --volumes --remove-orphans
rm -rf "$root"
`,
	);
}

/** @internal Install the proxy once on a dedicated Docker server; existing proxies can use proxyNetwork instead. */
export async function setupSsh(config: PreviewConfig): Promise<void> {
	if (config.provider.type !== 'ssh') throw new TypeError('Proxy setup is only for SSH deployments');
	const proxy = {
		services: {
			proxy: {
				image: 'traefik:v3.7.14',
				restart: 'unless-stopped',
				ports: ['80:80', '443:443'],
				command: [
					'--providers.docker=true',
					'--providers.docker.exposedbydefault=false',
					'--entrypoints.web.address=:80',
					'--entrypoints.websecure.address=:443',
					`--certificatesresolvers.${config.provider.certificateResolver}.acme.httpchallenge.entrypoint=web`,
					`--certificatesresolvers.${config.provider.certificateResolver}.acme.storage=/certificates/acme.json`,
				],
				volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro', 'certificates:/certificates'],
				networks: ['proxy'],
			},
		},
		volumes: { certificates: {} },
		networks: { proxy: { name: config.provider.proxyNetwork } },
	};
	await remote(
		config.provider,
		`
mkdir -p "$HOME/.slipher-lab"
printf '%s' '${encoded(proxy)}' | base64 -d > "$HOME/.slipher-lab/proxy.json"
docker compose -p slipher-lab-proxy -f "$HOME/.slipher-lab/proxy.json" up -d
`,
	);
}
