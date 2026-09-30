import { useEffect, useRef, useState } from 'react';
import type { Expectation, LabSnapshot } from '../bridge';
import { Avatar } from '../render/Message';
import { CloseIcon, EyeIcon, PinIcon } from './icons';

type Guild = NonNullable<LabSnapshot['session']>['guilds'][number];

function Profile({
	snapshot,
	guild,
	memberId,
	isBot,
	onClose,
	onRole,
	onPin,
	onViewAs,
}: {
	snapshot: LabSnapshot;
	guild: Guild;
	memberId: string;
	isBot: boolean;
	onClose: () => void;
	onRole: (op: 'addRole' | 'removeRole', roleId: string) => void;
	onPin?: (expectation: Expectation) => void;
	onViewAs?: () => void;
}) {
	const card = useRef<HTMLDivElement>(null);
	const [adding, setAdding] = useState('');
	const member = guild.members.find(item => item.id === memberId);
	const actor = snapshot.actors.find(item => item.userId === memberId);
	const assigned = actor?.roles[guild.id] ?? [];
	const assignable = guild.roles
		.filter(role => role.id !== guild.id && !assigned.includes(role.id))
		.sort((a, b) => b.position - a.position);
	const close = useRef(onClose);
	close.current = onClose;
	// Runs once per opening: the parent re-renders on every host event and must not steal focus back.
	useEffect(() => {
		card.current?.focus();
		const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close.current();
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, []);
	const roleName = (id: string) => guild.roles.find(role => role.id === id)?.name ?? snapshot.names?.roles[id] ?? id;
	return (
		<div
			className="profile-card"
			role="dialog"
			aria-label={`${member?.name ?? memberId} profile`}
			ref={card}
			tabIndex={-1}>
			<div className="profile-banner" />
			<button type="button" className="icon-button profile-close" aria-label="Close profile" onClick={onClose}>
				<CloseIcon />
			</button>
			<div className="profile-head">
				<Avatar name={member?.name ?? memberId} user={{ id: memberId }} size={72} />
				<div>
					<strong>
						{member?.name ?? memberId}
						{isBot && <span className="bot-tag">APP</span>}
					</strong>
					<code className="id-code">{memberId}</code>
				</div>
			</div>
			<section className="profile-section">
				<h3>Roles</h3>
				<ul className="role-chips">
					{assigned.map(roleId => (
						<li key={roleId} className="role-chip">
							<span className="role-dot" aria-hidden="true" />
							{roleName(roleId)}
							{onPin && (
								<button
									type="button"
									className="lab-mini"
									aria-label={`Expect ${roleName(roleId)} present`}
									title="Expect present"
									onClick={() => onPin({ role: { guild: guild.id, member: memberId, role: roleId }, present: true })}>
									<PinIcon size={12} />
								</button>
							)}
							<button
								type="button"
								aria-label={`Remove ${roleName(roleId)}`}
								title="Remove role"
								onClick={() => onRole('removeRole', roleId)}>
								<CloseIcon size={12} />
							</button>
						</li>
					))}
					{actor && !assigned.length && <li className="hint">No roles</li>}
				</ul>
				{actor && assignable.length > 0 && (
					<div className="role-add">
						<select aria-label="Role to add" value={adding} onChange={event => setAdding(event.target.value)}>
							<option value="">Add role…</option>
							{assignable.map(role => (
								<option key={role.id} value={role.id}>
									{role.name}
								</option>
							))}
						</select>
						<button
							type="button"
							className="button small"
							disabled={!adding}
							onClick={() => {
								onRole('addRole', adding);
								setAdding('');
							}}>
							Add
						</button>
						{onPin && (
							<button
								type="button"
								className="button small lab"
								disabled={!adding}
								title="Expect absent"
								onClick={() => onPin({ role: { guild: guild.id, member: memberId, role: adding }, present: false })}>
								Expect absent
							</button>
						)}
					</div>
				)}
			</section>
			{onViewAs && (
				<button type="button" className="button primary wide" onClick={onViewAs}>
					<EyeIcon /> View as {member?.name ?? memberId}
				</button>
			)}
		</div>
	);
}

export function MemberList({
	snapshot,
	guild,
	botIds,
	viewer,
	onRole,
	onPin,
	onViewAs,
}: {
	snapshot: LabSnapshot;
	guild: Guild;
	botIds: Set<string>;
	viewer?: string;
	onRole: (memberId: string, op: 'addRole' | 'removeRole', roleId: string) => void;
	onPin?: (expectation: Expectation) => void;
	onViewAs: (actorKey: string) => void;
}) {
	const [open, setOpen] = useState<string>();
	const actorIds = new Set(snapshot.actors.map(actor => actor.userId));
	const groups = [
		{ title: 'Actors', members: guild.members.filter(member => actorIds.has(member.id) && !botIds.has(member.id)) },
		{ title: 'Bots', members: guild.members.filter(member => botIds.has(member.id)) },
		{ title: 'Members', members: guild.members.filter(member => !actorIds.has(member.id) && !botIds.has(member.id)) },
	].filter(group => group.members.length);
	return (
		<div className="member-list">
			{groups.map(group => (
				<section key={group.title}>
					<h3>
						{group.title} — {group.members.length}
					</h3>
					<ul>
						{group.members.map(member => {
							const actor = snapshot.actors.find(item => item.userId === member.id);
							return (
								<li key={member.id}>
									<button
										type="button"
										className={`member-row ${actor?.key === viewer ? 'viewer' : ''}`}
										aria-expanded={open === member.id}
										onClick={() => setOpen(open === member.id ? undefined : member.id)}>
										<span className="member-avatar">
											<Avatar name={member.name} user={{ id: member.id }} size={32} />
										</span>
										<span className="member-name">
											<span className="member-line">
												<span className="member-label">{member.name}</span>
												{botIds.has(member.id) && <span className="bot-tag">APP</span>}
											</span>
											{actor?.key === viewer && <small>Viewing</small>}
										</span>
									</button>
									{open === member.id && (
										<Profile
											snapshot={snapshot}
											guild={guild}
											memberId={member.id}
											isBot={botIds.has(member.id)}
											onClose={() => setOpen(undefined)}
											onRole={(op, roleId) => onRole(member.id, op, roleId)}
											onPin={onPin}
											onViewAs={
												actor?.channelId && actor.key !== viewer
													? () => {
															onViewAs(actor.key);
															setOpen(undefined);
														}
													: undefined
											}
										/>
									)}
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</div>
	);
}
