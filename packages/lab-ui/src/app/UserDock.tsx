import { useState } from 'react';
import type { LabSnapshot } from '../bridge';
import { ChevronIcon } from '../icons';
import { Avatar } from '../render/Avatar';

type Actor = LabSnapshot['actors'][number];

/** The actor the conversation is seen as, with a switcher to view as another. */
export function UserDock({
	viewer,
	actors,
	onViewAs,
}: {
	viewer: Actor;
	actors: Actor[];
	onViewAs: (key: string) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="user-dock">
			<button
				type="button"
				className="viewer-button"
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={`Viewing as ${viewer.name}. Switch actor`}
				onClick={() => setOpen(!open)}>
				<Avatar name={viewer.name} user={{ id: viewer.userId }} size={32} />
				<span>
					<strong>{viewer.name}</strong>
					<small>{viewer.key}</small>
				</span>
				<ChevronIcon />
			</button>
			{open && (
				<ul className="actor-switcher" role="listbox" aria-label="Actors">
					{actors.map(item => (
						<li key={item.key}>
							<button
								type="button"
								role="option"
								aria-selected={item.key === viewer.key}
								onClick={() => {
									onViewAs(item.key);
									setOpen(false);
								}}>
								<Avatar name={item.name} user={{ id: item.userId }} size={24} />
								<span>{item.name}</span>
								<code>{item.key}</code>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
