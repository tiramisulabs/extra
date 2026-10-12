import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type PullRequestPreview, pullRequestPreset } from '../host/preview';
import { secret } from './config';

/** @internal */
export interface PreviewSnapshot extends PullRequestPreview {
	repository: string;
	repositoryId: number;
	number: number;
	runUrl: string;
}

/** @internal Stable across commits and workflow retries, distinct across repositories. */
export function previewName(snapshot: Pick<PreviewSnapshot, 'repositoryId' | 'number'>): string {
	for (const number of [snapshot.repositoryId, snapshot.number])
		if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError('Invalid preview identity');
	return `lab-${snapshot.repositoryId}-pr-${snapshot.number}`;
}

/** @internal */
export async function eventIdentity(): Promise<Pick<PreviewSnapshot, 'repositoryId' | 'number'>> {
	const event = JSON.parse(await readFile(secret('GITHUB_EVENT_PATH'), 'utf8'));
	const identity = { repositoryId: event.repository?.id, number: event.pull_request?.number };
	previewName(identity);
	return identity;
}

/** @internal Fetch once: a PR edit after this point cannot mutate the deployed recipe. */
export async function capturePullRequest(source: string): Promise<PreviewSnapshot> {
	const event = JSON.parse(await readFile(secret('GITHUB_EVENT_PATH'), 'utf8'));
	const repository: unknown = event.repository?.full_name;
	if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository))
		throw new TypeError('Invalid GitHub repository');
	const identity = await eventIdentity();
	const pr = await github<{ state: string; head: { sha: string }; body: string | null }>(
		repository,
		`pulls/${identity.number}`,
	);
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
	if (pr.state !== 'open' || head !== pr.head.sha)
		throw new Error('PR closed or changed while the workflow was starting; use the latest run');
	const snapshot: PreviewSnapshot = {
		...identity,
		repository,
		headRefOid: head,
		body: pr.body ?? '',
		runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${secret('GITHUB_RUN_ID')}/attempts/${secret('GITHUB_RUN_ATTEMPT')}`,
	};
	pullRequestPreset(snapshot, head);
	return snapshot;
}

/** @internal */
export async function readSnapshot(source: string): Promise<PreviewSnapshot> {
	const snapshot: PreviewSnapshot = JSON.parse(await readFile(resolve(source, '.slipher-preview/pr.json'), 'utf8'));
	previewName(snapshot);
	pullRequestPreset(snapshot, snapshot.headRefOid);
	if (typeof snapshot.runUrl !== 'string' || !snapshot.runUrl) throw new TypeError('Invalid preview runUrl');
	return snapshot;
}

async function github<T>(repository: string, path: string, body?: Record<string, unknown>): Promise<T> {
	const response = await fetch(
		`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/${path}`,
		{
			method: body ? 'POST' : 'GET',
			headers: {
				authorization: `Bearer ${secret('GITHUB_TOKEN')}`,
				accept: 'application/vnd.github+json',
				'content-type': 'application/json',
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok) throw new Error(`GitHub ${path.split('?')[0]} failed (${response.status})`);
	return response.json() as Promise<T>;
}

/** @internal The recipe stays frozen; only the open state and commit are checked again before deploying. */
export async function assertCurrent(snapshot: PreviewSnapshot): Promise<void> {
	const identity = await eventIdentity();
	if (previewName(identity) !== previewName(snapshot)) throw new Error('Snapshot does not belong to this PR');
	const pr = await github<{ state: string; head: { sha: string } }>(snapshot.repository, `pulls/${snapshot.number}`);
	if (pr.state !== 'open' || pr.head.sha !== snapshot.headRefOid)
		throw new Error('PR closed or changed during the build');
}

/** @internal A delayed closed event must not remove a preview created after the PR was reopened. */
export async function isPullRequestClosed(
	identity: Pick<PreviewSnapshot, 'repositoryId' | 'number'>,
): Promise<boolean> {
	const pr = await github<{ state: string }>(secret('GITHUB_REPOSITORY'), `pulls/${identity.number}`);
	if (!['open', 'closed'].includes(pr.state)) throw new TypeError('Invalid GitHub PR state');
	return pr.state === 'closed';
}

/** @internal */
export async function publishDeployment(snapshot: PreviewSnapshot, url: string): Promise<void> {
	const deployment = await github<{ id: number }>(snapshot.repository, 'deployments', {
		ref: snapshot.headRefOid,
		environment: previewName(snapshot),
		auto_merge: false,
		required_contexts: [],
		transient_environment: true,
		production_environment: false,
		payload: { slipherLab: previewName(snapshot) },
	});
	await github(snapshot.repository, `deployments/${deployment.id}/statuses`, {
		state: 'success',
		environment_url: url,
		log_url: snapshot.runUrl,
		auto_inactive: true,
	});
}

/** @internal */
export async function retireDeployments(identity: Pick<PreviewSnapshot, 'repositoryId' | 'number'>): Promise<void> {
	const repository = secret('GITHUB_REPOSITORY');
	for (let page = 1; ; page++) {
		const deployments = await github<{ id: number; payload?: { slipherLab?: string } }[]>(
			repository,
			`deployments?environment=${previewName(identity)}&per_page=100&page=${page}`,
		);
		for (const deployment of deployments)
			if (deployment.payload?.slipherLab === previewName(identity))
				await github(repository, `deployments/${deployment.id}/statuses`, { state: 'inactive' });
		if (deployments.length < 100) break;
	}
}
