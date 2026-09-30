import { defineProject, defineScenario, param } from '@slipher/lab';
import { apiUser } from '@slipher/testing';

export const supportScenario = defineScenario({
	id: 'support-request',
	version: 1,
	title: 'Open and claim a support request',
	params: {
		topic: param.enum({ default: 'bug', values: ['question', 'bug'] as const }),
		botCanManageRoles: param.boolean({ default: true }),
	},
	world(world, { params, ref }) {
		const botUser = world.bot({ id: ref('member.bot'), username: 'support-bot', globalName: 'Support Bot' });
		const guild = world.guild('guild', {
			name: 'Support lab',
			everyonePermissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'UseApplicationCommands'],
		});
		const staff = world.role('role.staff', guild, { name: 'Staff', position: 5 });
		world.role('role.requester', guild, { name: 'Requester', position: 1 });
		const botRole = world.role('role.bot', guild, {
			name: 'Bot',
			position: 10,
			permissions: params.botCanManageRoles
				? ['ManageRoles', 'ViewChannel', 'SendMessages']
				: ['ViewChannel', 'SendMessages'],
		});
		world.role('role.manage-roles', guild, { name: 'Manage Roles', position: 2, permissions: ['ManageRoles'] });
		const support = world.channel('channel.support', guild, { name: 'support' });
		world.message('message.welcome', support, { author: botUser, content: 'Support is ready.' });
		world.channel('channel.staff', guild, {
			name: 'staff',
			overwrites: [
				{ id: guild, type: 'role', deny: ['ViewChannel'] },
				{ id: staff, type: 'role', allow: ['ViewChannel'] },
				{ id: botRole, type: 'role', allow: ['ViewChannel'] },
			],
		});
		world.member('member.member', guild, { user: apiUser({ id: ref('member.member'), username: 'Member' }) });
		world.member('member.staff', guild, {
			user: apiUser({ id: ref('member.staff'), username: 'Staffer' }),
			roles: [staff],
		});
		world.builder.registerBotMember(guild, { roles: [botRole] });
	},
	actors: refs => ({
		member: { userId: refs['member.member'], guildId: refs.guild, channelId: refs['channel.support'] },
		staff: { userId: refs['member.staff'], guildId: refs.guild, channelId: refs['channel.staff'] },
	}),
});

export const project = defineProject({
	name: 'lab-reference-bot',
	scenarios: [supportScenario],
	bot: () => ({ loadFromConfig: true, loadModule: path => import(path) }),
});

export default project;
