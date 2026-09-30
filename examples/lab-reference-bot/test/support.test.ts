import { apiUser, createMockBot, mockWorld, rendered } from '@slipher/testing';
import { afterEach, describe, expect, test } from 'vitest';

const GUILD = 'lab-guild';
const MEMBER = 'lab-member';
const STAFF = 'lab-staff';

function fixture(manageRoles = true) {
	const world = mockWorld();
	const guild = world.registerGuild({ id: GUILD, name: 'Support lab' });
	const staffRole = world.registerRole(guild.id, { id: 'role-staff', name: 'Staff', position: 5 });
	const requesterRole = world.registerRole(guild.id, { id: 'role-requester', name: 'Requester', position: 1 });
	const botRole = world.registerRole(guild.id, {
		id: 'role-bot',
		name: 'Bot',
		position: 10,
		permissions: manageRoles ? ['ManageRoles', 'ViewChannel', 'SendMessages'] : ['ViewChannel', 'SendMessages'],
	});
	const publicChannel = world.registerChannel(guild.id, { id: 'channel-support', name: 'support' });
	const staffChannel = world.registerChannel(guild.id, {
		id: 'channel-staff',
		name: 'staff',
		overwrites: [
			{ id: guild.id, type: 'role', deny: ['ViewChannel'] },
			{ id: staffRole.id, type: 'role', allow: ['ViewChannel'] },
			{ id: botRole.id, type: 'role', allow: ['ViewChannel'] },
		],
	});
	const member = world.registerMember(guild.id, { user: apiUser({ id: MEMBER, username: 'Member' }) });
	const staff = world.registerMember(guild.id, {
		user: apiUser({ id: STAFF, username: 'Staffer' }),
		roles: [staffRole.id],
	});
	world.registerBotMember(guild.id, { roles: [botRole.id] });
	return { world, guild, member, staff, requesterRole, publicChannel, staffChannel };
}

describe('reference support bot from compiled ESM output', () => {
	const bots: Awaited<ReturnType<typeof createMockBot>>[] = [];
	afterEach(async () => {
		for (const bot of bots.splice(0)) await bot.close();
	});

	async function openRequest(manageRoles = true) {
		const seeded = fixture(manageRoles);
		const bot = await createMockBot({ loadFromConfig: true, loadModule: path => import(path), world: seeded.world });
		bots.push(bot);
		const memberActor = bot.actor({ member: seeded.member, channel: seeded.publicChannel });
		const slash = await memberActor.slash({ name: 'support', subcommand: 'open', options: { topic: 'bug' } });
		expect(slash.content).toBe('Form ready in this channel.');
		const formMessage = bot.world.all.message({ channelId: seeded.publicChannel.id })[0];
		expect(formMessage?.content).toBe('Support topic: bug');
		expect(formMessage?.component('support:open:bug')).toBeDefined();
		await memberActor.clickButton('support:open:bug', { source: formMessage?.id });
		rendered(memberActor).get.modal('support:submit:bug');
		const submit = await memberActor.submitModal('support:submit:bug', { details: 'The button is broken' });
		const staffMessage = bot.world.all.message({ channelId: seeded.staffChannel.id })[0];
		expect(staffMessage?.content).toContain('The button is broken');
		return { bot, seeded, memberActor, submit, staffMessage };
	}

	test('member submits a request and Staff claims it', async () => {
		const { bot, seeded, submit, staffMessage } = await openRequest();
		expect(submit.ephemeral).toBe(true);
		expect(submit.content).toBe('Request sent to staff.');
		expect(bot.world.query.member({ guildId: GUILD, userId: MEMBER })?.roles).toContain(seeded.requesterRole.id);
		expect(staffMessage).toBeDefined();
		const staffActor = bot.actor({ member: seeded.staff, channel: seeded.staffChannel });
		const claim = await staffActor.clickButton('support:claim', { source: staffMessage?.id });
		expect(claim.content).toContain('Claimed by Staffer.');
		expect(
			bot.world.query.message({ channelId: seeded.staffChannel.id, id: staffMessage?.id ?? '' })?.content,
		).toContain('Claimed by Staffer.');
	});

	test('a member cannot claim a staff request', async () => {
		const { bot, seeded } = await openRequest();
		const publicClaim = await bot.client.messages.write(seeded.publicChannel.id, {
			content: 'Untrusted Claim control',
			components: [{ type: 1, components: [{ type: 2, custom_id: 'support:claim', label: 'Claim', style: 2 }] }],
		});
		const memberActor = bot.actor({ member: seeded.member, channel: seeded.publicChannel });
		const denied = await memberActor.clickButton('support:claim', { source: publicClaim.id });
		expect(denied.ephemeral).toBe(true);
		expect(denied.content).toBe('Only Staff can claim requests.');
	});

	test('missing ManageRoles reports the failure and leaves Requester absent', async () => {
		const { bot, seeded, submit } = await openRequest(false);
		expect(submit.ephemeral).toBe(true);
		expect(submit.content).toContain('could not assign the Requester role');
		expect(bot.world.query.member({ guildId: GUILD, userId: MEMBER })?.roles).not.toContain(seeded.requesterRole.id);
	});
});
