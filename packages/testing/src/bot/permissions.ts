import { PermissionFlagsBits } from 'seyfert/lib/types';

export type PermissionInput = string | bigint | (keyof typeof PermissionFlagsBits)[];

export function permissionBits(input: PermissionInput): string {
	if (typeof input === 'string') return input;
	if (typeof input === 'bigint') return input.toString();
	let bits = 0n;
	for (const name of input) {
		const bit = PermissionFlagsBits[name];
		if (bit === undefined) {
			throw new TypeError(
				`permissionBits: unknown permission "${String(name)}". Valid names: ${Object.keys(PermissionFlagsBits).join(', ')}`,
			);
		}
		bits |= bit;
	}
	return bits.toString();
}

export function combineRolePermissions(roles: { permissions: string }[]): string {
	let bits = 0n;
	for (const role of roles) bits |= BigInt(role.permissions);
	return bits.toString();
}

export const ALL_PERMISSIONS = (() => {
	let bits = 0n;
	for (const bit of Object.values(PermissionFlagsBits)) bits |= bit;
	return bits;
})();

export interface ChannelOverwriteLike {
	id: string;
	type: number;
	allow: string;
	deny: string;
}

export interface ComputePermissionsInput {
	guild: { id: string; owner_id: string };
	roles: { id: string; permissions: string }[];
	member: {
		userId: string;
		roles: string[];
		communicationDisabledUntil?: string | null;
	};
	channel?: { permission_overwrites?: ChannelOverwriteLike[] };
}

export function computeChannelPermissions(input: ComputePermissionsInput): string {
	if (input.guild.owner_id === input.member.userId) return ALL_PERMISSIONS.toString();

	const roleById = new Map(input.roles.map(role => [role.id, role]));
	const everyoneRole = roleById.get(input.guild.id);
	if (!everyoneRole) {
		throw new TypeError(
			`computeChannelPermissions: @everyone role (id === guild.id "${input.guild.id}") is missing. ` +
				`Roles given: ${input.roles.map(role => role.id).join(', ') || '(none)'}. ` +
				`registerGuild() auto-creates it - manual calls must include it.`,
		);
	}

	let bits = BigInt(everyoneRole.permissions);
	for (const roleId of input.member.roles) {
		bits |= BigInt(roleById.get(roleId)?.permissions ?? '0');
	}
	if (bits & PermissionFlagsBits.Administrator) return ALL_PERMISSIONS.toString();

	const ow = (value: string) => BigInt(value) & ~PermissionFlagsBits.Administrator;
	const overwrites = input.channel?.permission_overwrites ?? [];
	const everyone = overwrites.find(overwrite => overwrite.id === input.guild.id);
	if (everyone) {
		bits &= ~ow(everyone.deny);
		bits |= ow(everyone.allow);
	}

	let allow = 0n;
	let deny = 0n;
	for (const overwrite of overwrites) {
		if (overwrite.type === 0 && overwrite.id !== input.guild.id && input.member.roles.includes(overwrite.id)) {
			allow |= ow(overwrite.allow);
			deny |= ow(overwrite.deny);
		}
	}
	bits &= ~deny;
	bits |= allow;

	const memberOverwrite = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === input.member.userId);
	if (memberOverwrite) {
		bits &= ~ow(memberOverwrite.deny);
		bits |= ow(memberOverwrite.allow);
	}

	if (input.member.communicationDisabledUntil && Date.parse(input.member.communicationDisabledUntil) > Date.now()) {
		bits &= PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
	}

	return bits.toString();
}
