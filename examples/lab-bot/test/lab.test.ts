import type { Session } from '@slipher/lab';
import { createSession, replay } from '@slipher/lab/runtime';
import { describe, expect, test } from 'vitest';
import { project } from '../lab/project.js';

const preset = (botCanManageRoles = true) => ({
	scenario: { id: 'support', version: 1 },
	params: { botCanManageRoles },
});

async function withSession(botCanManageRoles: boolean, run: (session: Session) => Promise<void>) {
	const session = createSession(project, preset(botCanManageRoles));
	await session.start();
	try {
		await run(session);
	} finally {
		await session.dispose();
	}
}

async function sendRequest(session: Session, details: string) {
	await session.act({ kind: 'user', actor: 'member', verb: 'slash', command: 'support' });
	return session.act({
		kind: 'user',
		actor: 'member',
		verb: 'submitModal',
		customId: 'support:form',
		fields: { details },
	});
}

const claim = (actor: string) =>
	({
		kind: 'user',
		actor,
		verb: 'click',
		customId: 'support:claim',
		source: { channel: 'channel.staff', customId: 'support:claim' },
	}) as const;

const texts = async (session: Session, actor: string, channel: string) =>
	(await session.view(actor, channel)).messages.map(message => message.payload.content);

describe('lab bot', () => {
	test('a request reaches the staff channel and staff can claim it', () =>
		withSession(true, async session => {
			const submit = await sendRequest(session, 'The button is broken');
			expect(submit.summary).toBe('Request sent to staff.');

			const general = await session.view('member', 'channel.general');
			expect(general.messages.at(-1)).toMatchObject({
				visibility: 'ephemeral',
				payload: { content: 'Request sent to staff.' },
			});
			expect(await texts(session, 'staff', 'channel.staff')).toEqual(['Request from Member: The button is broken']);
			expect((await session.view('member', 'channel.staff')).diagnostics).toContain('no-view-channel');
			await expect(session.act(claim('member'))).rejects.toThrow('cannot view channel');

			await session.act(claim('staff'));
			expect(await texts(session, 'staff', 'channel.staff')).toEqual([
				'Request from Member: The button is broken\nClaimed by Staffer.',
			]);
		}));

	test('granting a role during the session changes what the bot can do', () =>
		withSession(false, async session => {
			const first = await sendRequest(session, 'First');
			expect(first.summary).toContain('could not assign the Requester role');

			await session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'bot', role: 'role.manager' });
			const second = await sendRequest(session, 'Second');
			expect(second.summary).toBe('Request sent to staff.');
		}));

	test('a recorded session replays against a fresh bot', () =>
		withSession(true, async session => {
			await sendRequest(session, 'Can you help?');
			const { log } = await replay(project, await session.log(), [
				{ role: { guild: 'guild', member: 'member', role: 'role.requester' }, present: true },
				{ view: { actor: 'staff', channel: 'channel.staff' }, contains: 'Can you help?' },
				{ view: { actor: 'member', channel: 'channel.staff' }, contains: 'Can you help?', absent: true },
			]);
			expect(log.entries).toHaveLength(2);
		}));
});
