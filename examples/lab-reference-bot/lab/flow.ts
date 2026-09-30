import type { LabAction, Session } from '@slipher/lab';

export const preset = (botCanManageRoles = true, topic: 'question' | 'bug' = 'bug') => ({
	scenario: { id: 'support-request', version: 1 },
	params: { topic, botCanManageRoles },
});

export const open = (topic: 'question' | 'bug'): LabAction => ({
	kind: 'user',
	actor: 'member',
	verb: 'slash',
	command: 'support',
	subcommand: 'open',
	options: { topic },
});

export async function submitRequest(session: Session, topic: 'question' | 'bug', details: string) {
	const slash = await session.act(open(topic));
	const click = await session.act({
		kind: 'user',
		actor: 'member',
		verb: 'click',
		customId: `support:open:${topic}`,
		source: { channel: 'channel.support', contains: `Support topic: ${topic}`, customId: `support:open:${topic}` },
	});
	const submit = await session.act({
		kind: 'user',
		actor: 'member',
		verb: 'submitModal',
		customId: `support:submit:${topic}`,
		fields: { details },
	});
	return { slash, click, submit };
}

export async function memberRoles(session: Session): Promise<string[]> {
	const refs = (await session.log()).preset.refs;
	const world = (await session.inspect()).world as {
		members: { userId: string; roles: string[] }[];
	};
	return world.members.find(member => member.userId === refs?.['member.member'])?.roles ?? [];
}

export async function observable(session: Session) {
	const [memberSupport, memberStaff, staffStaff, roles] = await Promise.all([
		session.view('member', 'channel.support'),
		session.view('member', 'channel.staff'),
		session.view('staff', 'channel.staff'),
		memberRoles(session),
	]);
	return {
		memberSupport: memberSupport.messages.map(message => ({
			content: message.payload.content,
			visibility: message.visibility,
		})),
		memberStaff: memberStaff.messages.map(message => message.payload.content),
		memberStaffDiagnostics: memberStaff.diagnostics,
		staffStaff: staffStaff.messages.map(message => message.payload.content),
		roles,
	};
}
