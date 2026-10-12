import { defineProject, defineScenario, param } from '@slipher/lab';
import { project as sharedProject } from './project.js';

// Optional preview preparation: no copied bot startup, guild, roles, channels or actors.
export const missingPermissions = defineScenario({
	id: 'missing-permissions',
	version: 1,
	title: 'Support without Manage Roles',
	params: { botCanManageRoles: param.boolean({ default: false, label: 'Bot can manage roles' }) },
});

export const project = defineProject({ ...sharedProject, scenarios: [missingPermissions] });
export default project;
