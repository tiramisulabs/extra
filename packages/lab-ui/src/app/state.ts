import { useEffect, useState } from 'react';
import { type LabClient, type LabSnapshot, sessionActors, sessionChannels } from '../bridge';
import { errorText } from '../format';

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
				if (active) setConnectError(errorText(reason));
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [client]);
	return { snapshot, connectError };
}

/** Actors the lab can view as: those placed in a channel. */
export const viewableActors = (snapshot: LabSnapshot) => sessionActors(snapshot.session).filter(item => item.channelId);

/** What the user picked; anything unpicked, or gone from the session, falls back to a default. */
export interface ViewPicks {
	actor?: string;
	channel?: string;
}
export interface View {
	actor: string;
	guildId: string;
	channel: string;
}

/**
 * The view a snapshot shows for the user's picks. A running session always shows one: the picked actor, else the
 * first viewable actor; the picked channel, else the actor's own. The guild is the open channel's.
 */
export function resolveView(snapshot: LabSnapshot, picks: ViewPicks): View {
	const { session } = snapshot;
	if (!session) return { actor: '', guildId: '', channel: '' };
	const actors = viewableActors(snapshot);
	const actor = actors.find(item => item.key === picks.actor) ?? actors[0];
	const channels = sessionChannels(session);
	const channel =
		channels.find(item => item.id === picks.channel) ?? channels.find(item => item.id === actor?.channelId);
	return {
		actor: actor?.key ?? '',
		guildId: channel?.guildId ?? session.guilds[0]?.id ?? '',
		channel: channel?.id ?? '',
	};
}

/** Whose eyes the conversation is seen through, and which guild and channel are open. Derived on every render. */
export function useViewSelection(snapshot: LabSnapshot) {
	const [picks, setPicks] = useState<ViewPicks>({});
	const view = resolveView(snapshot, picks);
	return {
		...view,
		openChannel(id: string) {
			setPicks(existing => ({ ...existing, channel: id }));
		},
		/** Opens the guild at the first channel the actor can view; a guild without channels does not open. */
		openGuild(id: string) {
			const channels = sessionChannels(snapshot.session).filter(item => item.guildId === id);
			const channel = channels.find(item => item.visibleTo.includes(view.actor)) ?? channels[0];
			if (channel) setPicks({ actor: view.actor, channel: channel.id });
		},
		/** Switches actor and keeps the open channel; with none open, shows the actor's own. */
		viewAs(key: string) {
			const next = viewableActors(snapshot).find(item => item.key === key);
			if (next) setPicks({ actor: key, channel: view.channel || next.channelId });
		},
	};
}
