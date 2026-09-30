import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { ComponentPayload, PendingModal } from '../bridge';
import { Markdown } from './Markdown';
import { SelectMenu } from './SelectMenu';

function FieldHeading({
	id,
	label,
	description,
	required,
	group = false,
}: {
	id: string;
	label: string;
	description?: string;
	required: boolean;
	group?: boolean;
}) {
	const text = (
		<>
			{label}
			{required && <span aria-hidden="true"> *</span>}
		</>
	);
	return (
		<>
			{group ? (
				<span className="modal-field-label" id={`${id}-label`}>
					{text}
				</span>
			) : (
				<label htmlFor={id}>{text}</label>
			)}
			{description && (
				<p className="modal-field-description" id={`${id}-description`}>
					{description}
				</p>
			)}
		</>
	);
}

function ModalField({
	label,
	description,
	input,
	values,
	setValues,
}: {
	label: string;
	description?: string;
	input: ComponentPayload;
	values: Record<string, string | string[]>;
	setValues: (next: Record<string, string | string[]>) => void;
}) {
	const id = input.custom_id ?? '';
	if (input.type === 4) {
		const shared = {
			id,
			name: id,
			required: input.required ?? true,
			minLength: input.min_length,
			maxLength: input.max_length,
			placeholder: input.placeholder,
			'aria-describedby': description ? `${id}-description` : undefined,
			value: typeof values[id] === 'string' ? (values[id] as string) : '',
			onChange: (event: { target: { value: string } }) => setValues({ ...values, [id]: event.target.value }),
		};
		return (
			<div className="modal-field">
				<FieldHeading id={id} label={label} description={description} required={shared.required} />
				{input.style === 2 ? <textarea {...shared} rows={4} /> : <input {...shared} type="text" />}
			</div>
		);
	}
	if (input.type === 3) {
		const selected = Array.isArray(values[id]) ? values[id] : [];
		const min = input.min_values ?? (input.required === false ? 0 : 1);
		const max = input.max_values ?? 1;
		return (
			<div className="modal-field">
				<FieldHeading id={id} label={label} description={description} required={min > 0} group />
				<SelectMenu
					id={id}
					labelledBy={`${id}-label`}
					options={input.options ?? []}
					selected={selected}
					onChange={next => setValues({ ...values, [id]: next })}
					min={min}
					max={max}
					placeholder={input.placeholder ?? 'Make a selection'}
				/>
				{(selected.length < min || selected.length > max) && (
					<span className="field-error">Select {min === max ? min : `${min}–${max}`}.</span>
				)}
			</div>
		);
	}
	return <div className="unsupported">Unsupported field type {input.type}</div>;
}

export type ModalValues = Record<string, string | string[]>;

function initialModalValues(modal: PendingModal): ModalValues {
	const values: ModalValues = {};
	for (const component of modal.payload.components) {
		const input = component.component;
		if (!input?.custom_id) continue;
		if (input.type === 3)
			values[input.custom_id] = input.options?.filter(option => option.default).map(option => option.value) ?? [];
		else if (input.value !== undefined) values[input.custom_id] = input.value;
	}
	return values;
}

export function Modal({
	modal,
	draft,
	onDraft,
	onClose,
	onSubmit,
}: {
	modal: PendingModal;
	/** What the user had typed or selected before closing this same modal. */
	draft?: ModalValues;
	onDraft?: (values: ModalValues) => void;
	onClose: () => void;
	onSubmit: (submission: { customId: string; fields: ModalValues }) => void;
}) {
	const [values, setStoredValues] = useState<ModalValues>(() => ({ ...initialModalValues(modal), ...draft }));
	const setValues = (next: ModalValues) => {
		setStoredValues(next);
		onDraft?.(next);
	};
	const dialog = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		(
			dialog.current?.querySelector<HTMLElement>('input, textarea, select') ??
			dialog.current?.querySelector<HTMLElement>('button[type="submit"]')
		)?.focus();
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') close.current();
			if (event.key !== 'Tab' || !dialog.current) return;
			const focusable = Array.from(
				dialog.current.querySelectorAll<HTMLElement>('button, input, textarea, select'),
			).filter(element => !element.hasAttribute('disabled'));
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			}
			if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener('keydown', handleKey);
		return () => {
			document.removeEventListener('keydown', handleKey);
			previous?.focus();
		};
	}, []);
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		for (const component of modal.payload.components) {
			const input = component.component;
			if (input?.type !== 3 || !input.custom_id) continue;
			const count = Array.isArray(values[input.custom_id]) ? values[input.custom_id].length : 0;
			const min = input.min_values ?? (input.required === false ? 0 : 1);
			if (count < min || count > (input.max_values ?? 1)) return;
		}
		onSubmit({ customId: modal.customId, fields: values });
	}
	return (
		<div className="modal-backdrop">
			<div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialog}>
				<div className="modal-heading">
					<h2 id="modal-title">{modal.payload.title}</h2>
					<button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
						<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
						</svg>
					</button>
				</div>
				<form onSubmit={submit}>
					<div className="modal-content">
						{modal.payload.components.map((component, index) => {
							if (component.type === 10) return <Markdown key={component.id ?? index} text={component.content ?? ''} />;
							if (component.type === 18 && component.component)
								return (
									<ModalField
										key={component.id ?? index}
										label={component.label ?? component.component.custom_id ?? ''}
										description={component.description}
										input={component.component}
										values={values}
										setValues={setValues}
									/>
								);
							return (
								<div className="unsupported" key={component.id ?? index}>
									Unsupported component type {component.type}
								</div>
							);
						})}
					</div>
					<div className="modal-actions">
						<button type="button" className="button" onClick={onClose}>
							Cancel
						</button>
						<button type="submit" className="button primary">
							Submit
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
