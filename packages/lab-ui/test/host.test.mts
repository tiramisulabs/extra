import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type HostedOptions, type LabHost, startHost } from '@slipher/lab/host';
import type { LabSnapshot } from '../src/bridge';
import { HostClient, modalKey, shortRevision } from '../src/HostClient';

test('HostClient drives a child session through HTTP and exposes action failures', async () => {
	const host = await startHost({ projectModule: resolve(process.cwd(), '../lab/test/fixtures/project.cjs') });
	try {
		const client = new HostClient(host.url);
		const initial = await client.connect();
		assert.equal(initial.connection, 'disconnected');
		assert.equal(initial.project.name, 'fixture');
		const snapshots: LabSnapshot[] = [];
		const unsubscribe = client.subscribe(snapshot => snapshots.push(snapshot));
		const events = await fetch(`${host.url}/api/events`);
		const eventReader = events.body?.getReader();
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'support', subcommand: 'open' });
		await client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow', channel: 'channel' });
		const current = snapshots.at(-1);
		assert.ok(current);
		assert.equal(current?.connection, 'connected');
		assert.equal(current.session?.refs.guild, current.session?.guilds[0].id);
		const messageId = current.conversations[`alice:${current.session?.refs.channel}`].messages.find(
			item => item.payload.content === 'Panel',
		)?.id;
		assert.ok(messageId);
		await client.act({
			kind: 'user',
			actor: 'alice',
			verb: 'click',
			customId: 'open',
			source: { channel: 'channel', messageRef: messageId, customId: 'open' },
		});
		const recordedClick = snapshots.at(-1)?.log?.entries.at(-1)?.action;
		assert.equal(recordedClick?.kind, 'user');
		if (recordedClick?.kind === 'user' && recordedClick.verb === 'click') {
			assert.equal(recordedClick.source.messageRef, undefined);
			assert.equal(recordedClick.source.contains, 'Panel');
		}
		const modal = snapshots.at(-1)?.pending.modals.find(item => item.userId === current.session?.refs.alice);
		assert.ok(modal);
		client.closeModal('alice', modal.customId);
		assert.ok(snapshots.at(-1)?.pending.modals.some(item => item.customId === modal.customId));
		assert.ok(snapshots.at(-1)?.closedModals?.includes(modal.interactionId ?? `${modal.userId}:${modal.customId}`));
		await new Promise<void>((done, reject) => {
			const timeout = setTimeout(() => reject(new Error('local action was not logged')), 1000);
			const stop = client.subscribe(snapshot => {
				if (snapshot.inspector.actions.some(item => item.label === 'LOCAL · closeModal')) {
					clearTimeout(timeout);
					stop();
					done();
				}
			});
		});
		await client.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'alice', role: 'ban' });
		assert.ok(
			snapshots
				.at(-1)
				?.actors.find(actor => actor.key === 'alice')
				?.roles[current.session?.refs.guild ?? ''].includes(current.session?.refs.ban ?? ''),
		);
		await assert.rejects(
			client.act({ kind: 'user', actor: 'carol', verb: 'slash', command: 'flow', channel: 'channel' }),
			/cannot view channel/,
		);
		await assert.rejects(
			client.act({
				kind: 'user',
				actor: 'carol',
				verb: 'click',
				customId: 'open',
				source: { channel: 'channel', messageRef: messageId, customId: 'open' },
			}),
			/cannot view channel/,
		);
		assert.match(snapshots.at(-1)?.error ?? '', /cannot view channel/);
		assert.match(new TextDecoder().decode((await eventReader?.read())?.value), /session-started/);
		await eventReader?.cancel();
		unsubscribe();
	} finally {
		await host.close();
	}
});

test('a reloaded tab shows the session the host is still running', async () => {
	const host = await startHost({ projectModule: resolve(process.cwd(), '../lab/test/fixtures/project.cjs') });
	try {
		const first = new HostClient(host.url);
		await first.connect();
		await first.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await first.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow', channel: 'channel' });

		const reloaded = await new HostClient(host.url).connect();
		assert.equal(reloaded.connection, 'connected');
		const channelId = reloaded.session?.refs.channel;
		assert.ok(reloaded.conversations[`alice:${channelId}`].messages.some(item => item.payload.content === 'Panel'));

		await fetch(`${host.url}/api/session`, { method: 'DELETE' });
		const idle = await new HostClient(host.url).connect();
		assert.equal(idle.connection, 'disconnected');
		assert.equal(idle.error, undefined);
	} finally {
		await host.close();
	}
});

test('UI checkpoint replays a recorded click and modal submission in a new session', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'lab-ui-replay-'));
	try {
		const host = await startHost({
			projectModule: resolve(process.cwd(), '../lab/test/fixtures/project.cjs'),
			dataDir,
		});
		try {
			const client = new HostClient(host.url);
			await client.connect();
			await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
			await client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow', channel: 'channel' });
			const snapshot = await client.connect();
			const messageId = snapshot.conversations[`alice:${snapshot.session?.refs.channel}`].messages.find(
				item => item.payload.content === 'Panel',
			)?.id;
			assert.ok(messageId);
			await client.act({
				kind: 'user',
				actor: 'alice',
				verb: 'click',
				customId: 'open',
				source: { channel: 'channel', messageRef: messageId, customId: 'open' },
			});
			await client.act({
				kind: 'user',
				actor: 'alice',
				verb: 'submitModal',
				customId: 'answer',
				fields: { value: 'yes' },
			});
			const checkpoint = await client.saveCheckpoint('ui-replay', [
				{ view: { actor: 'alice', channel: 'channel' }, contains: 'saved:yes' },
			]);
			const click = checkpoint.actions.find(item => item.kind === 'user' && item.verb === 'click');
			assert.ok(click && click.kind === 'user' && click.verb === 'click');
			assert.equal(click.source.messageRef, undefined);
			assert.deepEqual(click.source, { channel: 'channel', customId: 'open', contains: 'Panel' });
			await client.replayCheckpoint('ui-replay');
		} finally {
			await host.close();
		}
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	await new Promise(done => server.close(done));
	return port;
}
/** A browser tab: same-origin Origin header and its own cookie jar. */
function browser(origin: string): typeof fetch {
	let cookie = '';
	return async (input, init = {}) => {
		const headers = new Headers(init.headers);
		headers.set('origin', origin);
		if (cookie) headers.set('cookie', cookie);
		const response = await fetch(input, { ...init, headers });
		for (const value of response.headers.getSetCookie()) {
			const pair = value.split(';')[0];
			cookie = /max-age=0/i.test(value) ? '' : pair;
		}
		return response;
	};
}
async function hostedHost(
	port: number,
	revision: string,
	hosted: Partial<HostedOptions> = {},
	fixture = 'project.cjs',
) {
	const origin = `http://127.0.0.1:${port}`;
	const host = await startHost({
		projectModule: resolve(process.cwd(), '../lab/test/fixtures', fixture),
		port,
		hosted: { publicOrigin: origin, access: { mode: 'trusted-proxy' }, ...hosted },
		build: { revision, ref: 'pr-1' },
	});
	return { host, origin };
}
function waitFor(
	client: HostClient,
	check: (snapshot: LabSnapshot) => boolean,
	timeoutMs = 3000,
): Promise<LabSnapshot> {
	return new Promise((done, reject) => {
		const timeout = setTimeout(() => reject(new Error('snapshot condition not reached')), timeoutMs);
		const stop = client.subscribe(snapshot => {
			if (!check(snapshot)) return;
			clearTimeout(timeout);
			stop();
			done(snapshot);
		});
		// The condition may already hold before anything else is emitted.
		void client.connect().then(snapshot => {
			if (!check(snapshot)) return;
			clearTimeout(timeout);
			stop();
			done(snapshot);
		});
	});
}
const panelIn = (snapshot: LabSnapshot) =>
	snapshot.conversations[`alice:${snapshot.session?.refs.channel}`]?.messages.some(
		item => item.payload.content === 'Panel',
	);

test('hosted browsers get isolated runs and the catalogue needs none', async () => {
	const { host, origin } = await hostedHost(await freePort(), '0123456789abcdef');
	try {
		const tabA = browser(origin);
		const tabB = browser(origin);
		const a = new HostClient(host.url, tabA);
		const b = new HostClient(host.url, tabB);
		const catalogue = await a.connect();
		assert.equal(catalogue.connection, 'disconnected');
		assert.equal(catalogue.project.name, 'fixture');
		assert.equal(catalogue.host?.mode, 'hosted');
		assert.deepEqual(catalogue.host?.run, { state: 'none' });
		assert.equal(catalogue.host?.build?.revision, '0123456789abcdef');
		assert.deepEqual(await a.listCheckpoints(), []);
		await b.connect();
		await a.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await b.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await a.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow', channel: 'channel' });
		assert.ok(panelIn(await a.connect()));
		// A reload in B's tab adopts B's run, which never saw A's command.
		const reloadedB = await new HostClient(host.url, tabB).connect();
		assert.equal(reloadedB.connection, 'connected');
		assert.equal(panelIn(reloadedB), false);
		await a.saveCheckpoint('mine', []);
		assert.deepEqual(await a.listCheckpoints(), ['mine']);
		assert.deepEqual(await b.listCheckpoints(), []);
		assert.equal(shortRevision('0123456789abcdef'), '0123456');
		assert.equal(shortRevision('0123456789ab-dirty-00ff00ff'), '0123456-dirty-00ff00ff');
		assert.equal(shortRevision('content-0123456789abcdef'), 'content-0123456');
	} finally {
		await host.close();
	}
});

test('an expired hosted run ends with a notice and Start creates a new one', async () => {
	const { host, origin } = await hostedHost(await freePort(), 'rev-a', { idleTtlMs: 150 });
	try {
		const client = new HostClient(host.url, browser(origin));
		await client.connect();
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await new Promise(done => setTimeout(done, 500));
		await assert.rejects(
			client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow', channel: 'channel' }),
		);
		const ended = await client.connect();
		assert.equal(ended.connection, 'disconnected');
		assert.equal(ended.notice, 'Run expired after inactivity.');
		assert.equal(ended.error, undefined);
		assert.deepEqual(ended.host?.run, { state: 'ended', reason: 'expired' });
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		assert.equal((await client.connect()).connection, 'connected');
	} finally {
		await host.close();
	}
});

test('a redeployed preview reports the new revision and never reattaches the old run', async () => {
	const port = await freePort();
	const first = await hostedHost(port, 'aaaaaaa1111');
	const tab = browser(first.origin);
	const client = new HostClient(first.host.url, tab);
	await client.connect();
	await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
	await first.host.close();
	const second = await hostedHost(port, 'bbbbbbb2222');
	try {
		await assert.rejects(
			client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow', channel: 'channel' }),
		);
		const updated = await waitFor(client, snapshot => /updated/.test(snapshot.notice ?? ''));
		assert.equal(updated.notice, 'The preview was updated to bbbbbbb.');
		assert.equal(updated.connection, 'disconnected');
		assert.equal(updated.host?.build?.revision, 'bbbbbbb2222');
		assert.equal((await new HostClient(second.host.url, tab).connect()).connection, 'disconnected');
	} finally {
		await second.host.close();
	}
});

/** Stands in for the browser EventSource so a test can drop the stream or deliver host events. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	onerror: (() => void) | null = null;
	closed = false;
	private listeners = new Map<string, ((event: { data: string }) => void)[]>();
	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, listener: (event: { data: string }) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	emit(type: string, data: unknown) {
		for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
	}
	close() {
		this.closed = true;
	}
}

test('a lost stream followed by a restart or an expiry leaves only the launcher notice', async () => {
	const globals = globalThis as { EventSource?: unknown };
	globals.EventSource = FakeEventSource;
	const port = await freePort();
	try {
		const first = await hostedHost(port, 'aaaaaaa1111');
		const client = new HostClient(first.host.url, browser(first.origin));
		await client.connect();
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		const stream = FakeEventSource.instances.at(-1);
		assert.ok(stream && !stream.closed);
		await first.host.close();
		const second = await hostedHost(port, 'aaaaaaa1111');
		try {
			stream.onerror?.();
			const restarted = await waitFor(client, snapshot => snapshot.notice === 'The preview restarted.');
			assert.equal(restarted.error, undefined);
			assert.equal(restarted.connection, 'disconnected');
			assert.ok(stream.closed);

			await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
			const next = FakeEventSource.instances.at(-1);
			assert.ok(next && next !== stream);
			next.onerror?.();
			next.emit('session-stopped', { reason: 'expired' });
			const expired = await client.connect();
			assert.equal(expired.notice, 'Run expired after inactivity.');
			assert.equal(expired.error, undefined);
			assert.ok(next.closed);
		} finally {
			await second.host.close();
		}
	} finally {
		delete globals.EventSource;
	}
});

/** A streaming EventSource over a tab's fetch: real host events arrive over the wire; the end of the stream is an error. */
class WireEventSource {
	static request: typeof fetch = fetch;
	static instances: WireEventSource[] = [];
	onerror: (() => void) | null = null;
	closed = false;
	private listeners = new Map<string, ((event: { data: string }) => void)[]>();
	private readonly abort = new AbortController();
	constructor(url: string) {
		WireEventSource.instances.push(this);
		void this.read(url);
	}
	private async read(url: string) {
		try {
			const response = await WireEventSource.request(url, { signal: this.abort.signal });
			if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
			const decoder = new TextDecoder();
			let buffer = '';
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk, { stream: true });
				for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const type = /^event: (.*)$/m.exec(block)?.[1];
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (type && data !== undefined) for (const listener of this.listeners.get(type) ?? []) listener({ data });
				}
			}
		} catch {
			// Aborted by close() or refused while no host listens.
		}
		if (!this.closed) this.onerror?.();
	}
	addEventListener(type: string, listener: (event: { data: string }) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	close() {
		this.closed = true;
		this.abort.abort();
	}
}

test('a graceful redeploy ends the run and the replacement host is found with its build and catalogue', async () => {
	const globals = globalThis as { EventSource?: unknown };
	globals.EventSource = WireEventSource;
	const port = await freePort();
	const tab = browser(`http://127.0.0.1:${port}`);
	WireEventSource.request = tab;
	const live: LabHost[] = [];
	const client = new HostClient(`http://127.0.0.1:${port}`, tab);
	// The page keeps listening the whole time, as the UI does.
	const unsubscribe = client.subscribe(() => undefined);
	const replace = async (revision: string, fixture?: string) => {
		const next = await hostedHost(port, revision, {}, fixture);
		live.push(next.host);
		return next.host;
	};
	const shutDown = async (host: LabHost) => {
		await host.close();
		live.splice(live.indexOf(host), 1);
		const stopped = await waitFor(client, snapshot => snapshot.notice === 'The preview stopped.');
		assert.equal(stopped.error, undefined);
		assert.equal(stopped.connection, 'disconnected');
	};
	try {
		const first = await replace('aaaaaaa1111');
		await client.connect();
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		const firstStream = WireEventSource.instances.at(-1);
		assert.ok(firstStream && !firstStream.closed);

		// Same build restarted, after a gap in which nothing listens on the port.
		await shutDown(first);
		assert.ok(firstStream.closed);
		await new Promise(done => setTimeout(done, 1500));
		assert.equal((await client.connect()).notice, 'The preview stopped.');
		assert.equal((await client.connect()).error, undefined);
		const second = await replace('aaaaaaa1111');
		const restarted = await waitFor(client, snapshot => snapshot.notice === 'The preview restarted.', 10000);
		assert.equal(restarted.error, undefined);
		assert.equal(restarted.connection, 'disconnected');
		assert.equal(restarted.session, undefined);
		assert.equal(WireEventSource.instances.at(-1), firstStream, 'nothing reattached or restarted a run');

		// Another build with another catalogue: the watcher reports the revision and the new scenarios.
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await shutDown(second);
		const third = await replace('bbbbbbb2222', 'hosted.cjs');
		const updated = await waitFor(client, snapshot => /updated/.test(snapshot.notice ?? ''), 10000);
		assert.equal(updated.notice, 'The preview was updated to bbbbbbb.');
		assert.equal(updated.error, undefined);
		assert.equal(updated.host?.build?.revision, 'bbbbbbb2222');
		assert.deepEqual(
			updated.project.scenarios.map(item => item.id),
			['hosted'],
		);

		// Start right after a redeploy, before the watcher runs, uses the replacement's catalogue.
		await client.start({ scenarioId: 'hosted', params: {}, services: {} });
		await shutDown(third);
		await replace('ccccccc3333');
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		const current = await client.connect();
		assert.equal(current.connection, 'connected');
		assert.equal(current.host?.build?.revision, 'ccccccc3333');
		assert.deepEqual(
			current.project.scenarios.map(item => item.id),
			['flow'],
		);
	} finally {
		unsubscribe();
		for (const host of live) await host.close();
		delete globals.EventSource;
	}
});

test('an abruptly killed host is replaced and found without a shutdown event', async () => {
	const globals = globalThis as { EventSource?: unknown };
	globals.EventSource = WireEventSource;
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const tab = browser(origin);
	WireEventSource.request = tab;
	const cli = spawn(
		process.execPath,
		[
			resolve(process.cwd(), '../lab/lib/host/cli.js'),
			...['--project', resolve(process.cwd(), '../lab/test/fixtures/project.cjs')],
			...['--port', String(port), '--public-origin', origin, '--access', 'trusted-proxy'],
			...['--build-revision', 'aaaaaaa1111'],
		],
		{ stdio: ['ignore', 'pipe', 'inherit'] },
	);
	await once(cli.stdout, 'data');
	const client = new HostClient(origin, tab);
	const unsubscribe = client.subscribe(() => undefined);
	let replacement: LabHost | undefined;
	try {
		await client.connect();
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		cli.kill('SIGKILL');
		await once(cli, 'exit');
		const lost = await waitFor(client, snapshot => snapshot.error === 'Event stream lost; reconnecting…');
		assert.equal(lost.notice, undefined);
		replacement = (await hostedHost(port, 'aaaaaaa1111')).host;
		const restarted = await waitFor(client, snapshot => snapshot.notice === 'The preview restarted.', 10000);
		assert.equal(restarted.error, undefined);
		assert.equal(restarted.connection, 'disconnected');
	} finally {
		unsubscribe();
		if (cli.exitCode === null) cli.kill('SIGKILL');
		await replacement?.close();
		delete globals.EventSource;
	}
});

test('a closed modal keeps its flow: its trigger reopens it, the submit completes, and dismiss is per actor', async () => {
	const host = await startHost({ projectModule: resolve(process.cwd(), '../lab/test/fixtures/project.cjs') });
	try {
		const client = new HostClient(host.url);
		await client.connect();
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow', channel: 'channel' });
		const channelId = (await client.connect()).session?.refs.channel ?? '';
		const panel = (await client.connect()).conversations[`alice:${channelId}`].messages.find(
			item => item.payload.content === 'Panel',
		);
		assert.ok(panel);
		const click = () =>
			client.act({
				kind: 'user',
				actor: 'alice',
				verb: 'click',
				customId: 'open',
				source: { channel: 'channel', messageRef: panel.id, customId: 'open' },
			});
		await click();
		const opened = (await client.connect()).pending.modals.find(item => item.customId === 'answer');
		assert.ok(opened);
		for (let round = 0; round < 2; round++) {
			client.closeModal('alice', 'answer');
			const closed = await waitFor(client, snapshot =>
				snapshot.pending.modals.some(item => item.customId === 'answer' && item.closed),
			);
			assert.ok(closed.closedModals?.includes(modalKey(opened)));
			await click();
			const reopened = await client.connect();
			const modal = reopened.pending.modals.find(item => item.customId === 'answer');
			assert.equal(modal?.interactionId, opened.interactionId, 'the same modal instance, not a new interaction');
			assert.equal(modal?.closed, false);
			assert.equal(reopened.closedModals?.includes(modalKey(opened)), false);
			assert.deepEqual(reopened.log?.entries.at(-1)?.outcome.dispatchIds, []);
		}
		await client.act({
			kind: 'user',
			actor: 'alice',
			verb: 'submitModal',
			customId: 'answer',
			fields: { value: 'yes' },
		});
		const saved = await client.connect();
		assert.ok(saved.conversations[`alice:${channelId}`].messages.some(item => item.payload.content === 'saved:yes'));
		assert.equal(saved.pending.modals.length, 0);

		await client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'private-panel', channel: 'channel' });
		const privatePanel = (await client.connect()).conversations[`alice:${channelId}`].messages.find(
			item => item.payload.content === 'private panel',
		);
		assert.ok(privatePanel && privatePanel.visibility === 'ephemeral');
		// A double click sends one exact action; the second never targets another message.
		const actionsBefore = (await client.connect()).log?.entries.length ?? 0;
		await Promise.all([
			client.dismissMessage('alice', channelId, privatePanel),
			client.dismissMessage('alice', channelId, privatePanel),
		]);
		assert.equal(((await client.connect()).log?.entries.length ?? 0) - actionsBefore, 1);
		assert.equal((await client.connect()).error, undefined);
		const visible = (snapshot: LabSnapshot, actor: string) =>
			snapshot.conversations[`${actor}:${channelId}`]?.messages.map(item => item.id) ?? [];
		assert.equal(visible(await client.connect(), 'alice').includes(privatePanel.id), false);
		assert.ok(visible(await client.connect(), 'alice').includes(panel.id), 'other messages stay');
		// A reload (a fresh refresh from the host) keeps it dismissed; a new message is visible.
		const reloaded = await new HostClient(host.url).connect();
		assert.equal(visible(reloaded, 'alice').includes(privatePanel.id), false);
		await client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'private-panel', channel: 'channel' });
		const again = visible(await client.connect(), 'alice');
		assert.ok(
			(await client.connect()).conversations[`alice:${channelId}`].messages.some(
				item => item.payload.content === 'private panel' && item.id !== privatePanel.id,
			),
		);
		assert.equal(again.includes(privatePanel.id), false);
		// A new run starts with nothing dismissed or closed.
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		const fresh = await client.connect();
		assert.deepEqual(fresh.closedModals, []);
		assert.deepEqual(
			(fresh.rawInspect as { local?: { dismissed?: Record<string, string[]> } }).local?.dismissed ?? {},
			{},
		);
	} finally {
		await host.close();
	}
});

test('a close the host refuses (the modal timed out meanwhile) undoes the optimistic hide', async () => {
	const host = await startHost({ projectModule: resolve(process.cwd(), '../lab/test/fixtures/project.cjs') });
	try {
		const client = new HostClient(host.url);
		await client.connect();
		await client.start({ scenarioId: 'flow', params: { label: 'Panel' }, services: {} });
		await client.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'short-flow', channel: 'channel' });
		const channelId = (await client.connect()).session?.refs.channel ?? '';
		const panel = (await client.connect()).conversations[`alice:${channelId}`].messages.find(
			item => item.payload.content === 'Short panel',
		);
		assert.ok(panel);
		await client.act({
			kind: 'user',
			actor: 'alice',
			verb: 'click',
			customId: 'open-short',
			source: { channel: 'channel', messageRef: panel.id, customId: 'open-short' },
		});
		const stale = (await client.connect()).pending.modals.find(item => item.customId === 'short-answer');
		assert.ok(stale);
		// The bot stops waiting after 30 ms; this tab has not refreshed yet.
		await new Promise(done => setTimeout(done, 150));
		client.closeModal('alice', 'short-answer');
		assert.ok((await client.connect()).closedModals?.includes(modalKey(stale)), 'hidden at once');
		const settled = await waitFor(client, snapshot => Boolean(snapshot.error));
		assert.equal(settled.closedModals?.includes(modalKey(stale)), false);
		const refreshed = await waitFor(client, snapshot => snapshot.pending.modals.length === 0);
		assert.equal(refreshed.closedModals?.length ?? 0, 0);
	} finally {
		await host.close();
	}
});
