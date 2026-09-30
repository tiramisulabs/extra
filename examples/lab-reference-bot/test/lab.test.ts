import { fileURLToPath } from 'node:url';
import { createChildSession } from '@slipher/lab/child';
import { createSession, replay } from '@slipher/lab/runtime';
import { describe, expect, test } from 'vitest';
import { memberRoles, observable, open, preset, submitRequest } from '../lab/flow.js';
import { project } from '../lab/project.js';

const projectModule = fileURLToPath(new URL('../dist/lab/project.js', import.meta.url));

describe('reference bot lab', () => {
	test('member request is private to staff and staff can claim it', async () => {
		const session = createSession(project, preset());
		await session.start();
		try {
			const memberSupport = await session.view('member', 'channel.support');
			const description = await session.describe();
			const botId = description.refs['member.bot'];
			expect(description.names.users[botId]).toBe('Support Bot');
			expect(description.guilds[0].members).toContainEqual({ id: botId, name: 'Support Bot', bot: true });
			expect(
				memberSupport.messages.find(message => message.payload.content === 'Support is ready.')?.payload.author,
			).toMatchObject({ id: botId, username: 'support-bot', global_name: 'Support Bot', bot: true });
			const staffStaff = await session.view('staff', 'channel.staff');
			const memberStaff = await session.view('member', 'channel.staff');
			expect(memberSupport.diagnostics).not.toContain('no-view-channel');
			expect(staffStaff.diagnostics).not.toContain('no-view-channel');
			expect(memberStaff.diagnostics).toContain('no-view-channel');
			const result = await submitRequest(session, 'bug', 'The button is broken');
			expect(result.slash.summary).toBe('Form ready in this channel.');
			expect(
				(await session.view('member', 'channel.support')).messages.find(
					message => message.payload.content === 'Support topic: bug',
				)?.payload.author,
			).toMatchObject({ id: botId, username: 'support-bot', global_name: 'Support Bot', bot: true });
			expect(result.click.summary).toBe('Support request');
			expect(result.submit.summary).toBe('Request sent to staff.');
			const refs = (await session.log()).preset.refs;
			expect(await memberRoles(session)).toContain(refs?.['role.requester']);
			const before = await observable(session);
			expect(before.memberSupport).toContainEqual({ content: 'Support topic: bug', visibility: 'public' });
			expect(before.memberSupport).toContainEqual({ content: 'Request sent to staff.', visibility: 'ephemeral' });
			expect(before.staffStaff).toEqual([expect.stringContaining('The button is broken')]);
			expect(before.memberStaff).toEqual([]);
			expect(before.memberStaffDiagnostics).toContain('no-view-channel');
			await expect(
				session.act({
					kind: 'user',
					actor: 'member',
					verb: 'click',
					customId: 'support:claim',
					source: { channel: 'channel.staff', customId: 'support:claim' },
				}),
			).rejects.toThrow('Actor "member" cannot view channel "channel.staff" (ViewChannel)');
			const claim = await session.act({
				kind: 'user',
				actor: 'staff',
				verb: 'click',
				customId: 'support:claim',
				source: { channel: 'channel.staff', customId: 'support:claim' },
			});
			expect(claim.summary).toContain('Claimed by Staffer.');
			expect((await observable(session)).staffStaff).toEqual([expect.stringContaining('Claimed by Staffer.')]);
		} finally {
			await session.dispose();
		}
	});

	test('an external role grant enables the next Requester assignment', async () => {
		const session = createSession(project, preset(false));
		await session.start();
		try {
			const refs = (await session.log()).preset.refs;
			const first = await submitRequest(session, 'bug', 'First request');
			expect(first.submit.summary).toContain('could not assign the Requester role');
			expect(await memberRoles(session)).not.toContain(refs?.['role.requester']);
			expect((await observable(session)).memberSupport).toContainEqual({
				content: expect.stringContaining('could not assign the Requester role'),
				visibility: 'ephemeral',
			});
			await session.act({
				kind: 'admin',
				op: 'addRole',
				guild: 'guild',
				member: 'member.bot',
				role: 'role.manage-roles',
			});
			const second = await submitRequest(session, 'question', 'Second request');
			expect(second.submit.summary).toBe('Request sent to staff.');
			expect(await memberRoles(session)).toContain(refs?.['role.requester']);
		} finally {
			await session.dispose();
		}
	});

	test('log replay checks world and actor views; bad locators and refs fail', async () => {
		const session = createSession(project, preset(true, 'question'));
		await session.start();
		try {
			await submitRequest(session, 'question', 'Can you help?');
			const log = await session.log();
			const requester = log.preset.refs?.['role.requester'];
			if (!requester) throw new Error('Requester ref missing');
			const expectations = [
				{ path: 'world.members.0.roles.0', equals: requester },
				{ view: { actor: 'staff', channel: 'channel.staff' }, contains: 'Can you help?' },
				{ view: { actor: 'member', channel: 'channel.staff' }, contains: 'Can you help?', absent: true },
			] as const;
			const replayed = await replay(project, log, [...expectations]);
			expect(replayed.log.entries).toHaveLength(3);
			await expect(
				session.act({
					kind: 'user',
					actor: 'member',
					verb: 'click',
					customId: 'support:missing',
					source: { channel: 'channel.support', customId: 'support:missing' },
				}),
			).rejects.toThrow('Locator matched 0');
			await session.act(open('question'));
			await expect(
				session.act({
					kind: 'user',
					actor: 'member',
					verb: 'click',
					customId: 'support:open:question',
					source: { channel: 'channel.support', customId: 'support:open:question' },
				}),
			).rejects.toThrow('Locator matched 2');
			await expect(
				session.act({
					kind: 'admin',
					op: 'addRole',
					guild: 'guild',
					member: 'missing.member',
					role: 'role.staff',
				}),
			).rejects.toThrow('Unknown ref "missing.member"');
			await session.reset();
			expect((await session.log()).entries).toEqual([]);
			expect((await session.view('staff', 'channel.staff')).messages).toEqual([]);
			await submitRequest(session, 'question', 'Can you help?');
			expect((await session.log()).preset.refs).toEqual(log.preset.refs);
		} finally {
			await session.dispose();
		}
	});

	test('in-process and child sessions have the same observable result', async () => {
		const inProcess = createSession(project, preset());
		const child = createChildSession({ projectModule, preset: preset() });
		await inProcess.start();
		try {
			await child.start();
			try {
				const first = await submitRequest(inProcess, 'bug', 'Same request');
				const second = await submitRequest(child, 'bug', 'Same request');
				expect(second.submit.summary).toBe(first.submit.summary);
				expect(await observable(child)).toEqual(await observable(inProcess));
			} finally {
				await child.dispose();
			}
		} finally {
			await inProcess.dispose();
		}
	});
});
