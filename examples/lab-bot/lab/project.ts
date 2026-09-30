import { defineProject, defineScenario, param } from '@slipher/lab';
import { apiUser } from '@slipher/testing';

export const supportScenario = defineScenario({
	id: 'support',
	version: 1,
	title: 'Send and claim a support request',
	params: {
		botCanManageRoles: param.boolean({ default: true, label: 'Bot can manage roles' }),
	},
	world(world, { params, ref }) {
		const bot = world.bot({ id: ref('bot'), username: 'lab-bot', globalName: 'Lab Bot' });
		const guild = world.guild('guild', {
			name: 'Lab',
			everyonePermissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'UseApplicationCommands'],
		});
		const staff = world.role('role.staff', guild, { name: 'Staff', position: 5 });
		world.role('role.requester', guild, { name: 'Requester', position: 1 });
		world.role('role.manager', guild, { name: 'Manager', position: 2, permissions: ['ManageRoles'] });
		const botRole = world.role('role.bot', guild, {
			name: 'Bot',
			position: 10,
			permissions: params.botCanManageRoles ? ['ManageRoles'] : [],
		});

		const general = world.channel('channel.general', guild, { name: 'general' });
		world.channel('channel.staff', guild, {
			name: 'staff',
			overwrites: [
				{ id: guild, type: 'role', deny: ['ViewChannel'] },
				{ id: staff, type: 'role', allow: ['ViewChannel'] },
				{ id: botRole, type: 'role', allow: ['ViewChannel'] },
			],
		});
		world.message('message.welcome', general, { author: bot, content: 'Use /support to reach the staff.' });

		world.member('member', guild, { user: apiUser({ username: 'Member' }) });
		world.member('staff', guild, { user: apiUser({ username: 'Staffer' }), roles: [staff] });
		world.builder.registerBotMember(guild, { roles: [botRole] });
	},
	actors: refs => ({
		member: { userId: refs.member, guildId: refs.guild, channelId: refs['channel.general'] },
		staff: { userId: refs.staff, guildId: refs.guild, channelId: refs['channel.staff'] },
	}),
});

export const project = defineProject({
	name: 'lab-bot',
	scenarios: [supportScenario],
	// Loads the compiled handlers listed in seyfert.config.mjs.
	bot: () => ({ loadFromConfig: true, loadModule: path => import(path) }),
});

export default project;
