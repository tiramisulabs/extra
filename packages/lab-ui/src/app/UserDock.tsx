import { useEffect, useRef, useState } from 'react';
import type { Actor } from '../bridge';
import { ChevronIcon } from '../icons';
import { Avatar } from '../render/Avatar';

/** The actor the conversation is seen as, with a switcher to view as another. */
export function UserDock({
	viewer,
	actors,
	onViewAs,
	navOpen = false,
}: {
	viewer: Actor;
	actors: Actor[];
	onViewAs: (key: string) => void;
	navOpen?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!navOpen) setOpen(false);
	}, [navOpen]);
	return (
		<div
			className="user-dock"
			onKeyDown={event => {
				if (event.key !== 'Escape' || !open) return;
				event.preventDefault();
				event.stopPropagation();
				setOpen(false);
				trigger.current?.focus();
			}}>
			<button
				type="button"
				ref={trigger}
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
									trigger.current?.focus();
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
