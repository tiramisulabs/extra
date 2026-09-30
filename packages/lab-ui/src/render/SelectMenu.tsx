import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ComponentPayload } from '../bridge';
import { EmojiLabel } from './Markdown';

export type SelectOption = NonNullable<ComponentPayload['options']>[number];

/**
 * Discord's select menu: a closed trigger that summarises the choice and a listbox that opens below it.
 * Controlled, so a message can send on confirm while a modal only updates its form until Submit.
 */
export function SelectMenu({
	id,
	options,
	selected,
	onChange,
	min,
	max,
	placeholder,
	disabled = false,
	onConfirm,
	labelledBy,
}: {
	id: string;
	options: SelectOption[];
	selected: string[];
	onChange: (values: string[]) => void;
	min: number;
	max: number;
	placeholder: string;
	disabled?: boolean;
	/** Messages send the interaction here; modals omit it and submit with the form. */
	onConfirm?: (values: string[]) => void;
	labelledBy?: string;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const multiple = max > 1;
	useEffect(() => {
		if (!open) return;
		root.current?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')?.focus();
		const onPointer = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Close only the menu: a modal around it must stay open.
			event.stopImmediatePropagation();
			setOpen(false);
			trigger.current?.focus();
		};
		document.addEventListener('mousedown', onPointer);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('mousedown', onPointer);
			document.removeEventListener('keydown', onKey, true);
		};
	}, [open]);
	const valid = selected.length >= min && selected.length <= max;
	const chosen = options.filter(option => selected.includes(option.value));
	function choose(value: string) {
		if (!multiple) {
			onChange([value]);
			setOpen(false);
			trigger.current?.focus();
			onConfirm?.([value]);
			return;
		}
		onChange(
			selected.includes(value)
				? selected.filter(item => item !== value)
				: selected.length < max
					? [...selected, value]
					: selected,
		);
	}
	function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? [])];
		const index = items.indexOf(document.activeElement as HTMLElement);
		items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
	}
	const listId = `${id}-listbox`;
	return (
		<div className={`select-menu ${open ? 'open' : ''}`} ref={root}>
			<button
				ref={trigger}
				id={id}
				type="button"
				className="select-trigger"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listId}
				aria-labelledby={labelledBy ? `${labelledBy} ${id}` : undefined}
				onClick={() => setOpen(!open)}>
				<span className={chosen.length ? 'select-value' : 'select-placeholder'}>
					{chosen.length
						? chosen.map(option => (
								<span key={option.value} className="select-chip">
									{option.emoji && <EmojiLabel emoji={option.emoji} />}
									{option.label}
								</span>
							))
						: placeholder}
				</span>
				<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
					<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</svg>
			</button>
			{open && (
				<div className="select-popover">
					<ul id={listId} role="listbox" aria-multiselectable={multiple} aria-label={placeholder} onKeyDown={moveFocus}>
						{options.map(option => {
							const checked = selected.includes(option.value);
							return (
								<li key={option.value}>
									<button
										type="button"
										role="option"
										aria-selected={checked}
										className={checked ? 'selected' : ''}
										disabled={multiple && !checked && selected.length >= max}
										onClick={() => choose(option.value)}>
										{option.emoji && <EmojiLabel emoji={option.emoji} />}
										<span className="option-text">
											<span>{option.label}</span>
											{option.description && <small>{option.description}</small>}
										</span>
										{multiple && <span className={`option-check ${checked ? 'on' : ''}`} aria-hidden="true" />}
									</button>
								</li>
							);
						})}
						{options.length === 0 && <li className="select-empty">No options</li>}
					</ul>
					{multiple && (
						<div className="select-footer">
							<span className={valid ? 'select-count' : 'field-error'}>
								{valid ? `${selected.length}/${max}` : `Select ${min === max ? min : `${min}–${max}`}`}
							</span>
							{selected.length > 0 && min === 0 && (
								<button type="button" className="button link small" onClick={() => onChange([])}>
									Clear
								</button>
							)}
							{onConfirm && (
								<button
									type="button"
									className="component-button button-style-1"
									disabled={disabled || !valid}
									onClick={() => {
										setOpen(false);
										onConfirm(selected);
									}}>
									Confirm
								</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
