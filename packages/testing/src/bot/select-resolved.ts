import { DEFAULT_PERMISSIONS, type SelectMenuInteractionOptions } from './interactions';
import type { MockWorld } from './world';

export function normalizedSelectType(componentType: SelectMenuInteractionOptions['componentType']): 3 | 5 | 6 | 7 | 8 {
	if (componentType === undefined || componentType === 'string') return 3;
	if (componentType === 'user') return 5;
	if (componentType === 'role') return 6;
	if (componentType === 'mentionable') return 7;
	if (componentType === 'channel') return 8;
	return componentType;
}

function unknownSelectId(kind: string, customId: string, value: string, seeded: string[]): never {
	throw new TypeError(
		`selectMenu: unknown ${kind} id "${value}" for "${customId}". Seeded ${kind}s: ${seeded.join(', ') || '(none)'}.`,
	);
}

export function resolveSelectResolved(
	world: MockWorld | undefined,
	customId: string,
	values: string[],
	options: Omit<SelectMenuInteractionOptions, 'customId' | 'values' | 'message'>,
): SelectMenuInteractionOptions['resolved'] {
	if (options.resolved) return options.resolved;
	const type = normalizedSelectType(options.componentType);
	if (type === 3) return undefined;
	if (!world) {
		throw new TypeError(`selectMenu: "${customId}" is an entity select but no world or resolved data was provided.`);
	}

	if (type === 6) {
		const roles = world.roles.map(entry => entry.role);
		return {
			roles: Object.fromEntries(
				values.map(value => {
					const role = roles.find(entry => entry.id === value);
					if (!role)
						unknownSelectId(
							'role',
							customId,
							value,
							roles.map(entry => entry.id),
						);
					return [value, role];
				}),
			),
		};
	}

	if (type === 8) {
		const channels = world.channels;
		return {
			channels: Object.fromEntries(
				values.map(value => {
					const channel = channels.find(entry => entry.id === value);
					if (!channel)
						unknownSelectId(
							'channel',
							customId,
							value,
							channels.map(entry => entry.id),
						);
					return [value, { ...channel, permissions: DEFAULT_PERMISSIONS }];
				}),
			),
		};
	}

	const users: Record<string, unknown> = {};
	const members: Record<string, unknown> = {};
	const roles: Record<string, unknown> = {};
	for (const value of values) {
		const role = world.roles.find(entry => entry.role.id === value)?.role;
		const user = world.users.find(entry => entry.id === value);
		const member = world.members.find(
			entry =>
				entry.member.user.id === value &&
				(options.guildId === undefined || options.guildId === null || entry.guildId === options.guildId),
		);
		if (type === 5) {
			const resolvedUser = user ?? member?.member.user;
			if (!resolvedUser)
				unknownSelectId(
					'user',
					customId,
					value,
					world.users.map(entry => entry.id),
				);
			users[value] = resolvedUser;
			if (member) members[value] = { permissions: DEFAULT_PERMISSIONS, ...member.member };
			continue;
		}
		if (role) {
			roles[value] = role;
			continue;
		}
		const resolvedUser = user ?? member?.member.user;
		if (resolvedUser) {
			users[value] = resolvedUser;
			if (member) members[value] = { permissions: DEFAULT_PERMISSIONS, ...member.member };
			continue;
		}
		unknownSelectId('mentionable', customId, value, [
			...world.roles.map(entry => entry.role.id),
			...world.users.map(entry => entry.id),
			...world.members.map(entry => entry.member.user.id),
		]);
	}

	return {
		...(Object.keys(users).length ? { users } : {}),
		...(Object.keys(members).length ? { members } : {}),
		...(Object.keys(roles).length ? { roles } : {}),
	};
}
