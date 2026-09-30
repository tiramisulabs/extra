import { useEffect, useState } from 'react';
import type { LabClient, LabSnapshot } from '../bridge';

/** The client's latest snapshot, and why the first connection failed if it did. */
export function useLabSnapshot(client: LabClient) {
	const [snapshot, setSnapshot] = useState<LabSnapshot>();
	const [connectError, setConnectError] = useState('');
	useEffect(() => {
		let active = true;
		const unsubscribe = client.subscribe(next => {
			if (active) setSnapshot(next);
		});
		void client
			.connect()
			.then(next => {
				if (active) setSnapshot(next);
			})
			.catch(reason => {
				if (active) setConnectError(String(reason));
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [client]);
	return { snapshot, connectError };
}

/** Actors the lab can view as: those placed in a channel. */
export const viewableActors = (snapshot: LabSnapshot) => snapshot.actors.filter(item => item.channelId);

/** Whose eyes the conversation is seen through, and which guild and channel are open. */
export function useViewSelection(snapshot: LabSnapshot) {
	const [actor, setActor] = useState('');
	const [guildId, setGuildId] = useState('');
	const [channel, setChannel] = useState('');

	// A running session always shows a view: the first actor in its own channel until the user picks another,
	// and the guild follows the open channel.
	useEffect(() => {
		const session = snapshot.session;
		if (!session) return;
		const actors = viewableActors(snapshot);
		const nextActor = actors.find(item => item.key === actor) ?? actors[0];
		if (!nextActor) return;
		if (nextActor.key !== actor) setActor(nextActor.key);
		const current = snapshot.channels.find(item => item.id === channel);
		if (!current) {
			setChannel(nextActor.channelId);
			setGuildId(
				snapshot.channels.find(item => item.id === nextActor.channelId)?.guildId ?? session.guilds[0]?.id ?? '',
			);
		} else if (current.guildId !== guildId) setGuildId(current.guildId);
	}, [snapshot, actor, channel, guildId]);

	return {
		actor,
		guildId,
		channel,
		openChannel: setChannel,
		/** Opens the guild at the first channel the actor can view. */
		openGuild(id: string) {
			const channels = snapshot.channels.filter(item => item.guildId === id);
			setGuildId(id);
			setChannel((channels.find(item => item.visibleTo.includes(actor)) ?? channels[0])?.id ?? '');
		},
		/** Switches actor and keeps the open channel; with none open, shows the actor's own. */
		viewAs(key: string) {
			const next = viewableActors(snapshot).find(item => item.key === key);
			if (!next) return;
			setActor(key);
			if (!snapshot.channels.some(item => item.id === channel && item.guildId === guildId)) setChannel(next.channelId);
		},
	};
}
