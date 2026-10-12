import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { ComponentPayload, Guild, ModalAttachment, ModalFieldValue, PendingModal } from '../bridge';
import { maxUploadLabel } from '../format';
import { CloseIcon, UploadIcon } from '../icons';
import { attachmentReference, ComponentType, componentTree } from '../messages';
import { usePendingAction } from '../usePendingAction';
import { selectOptions } from './Component';
import { Markdown, type NameMap } from './Markdown';
import { countSpan, SelectMenu, selectionHint } from './SelectMenu';

export type ModalValues = Record<string, ModalFieldValue>;

const PARAGRAPH_STYLE = 2;

const SELECT_MENUS = new Set<number>([
	ComponentType.StringSelect,
	ComponentType.UserSelect,
	ComponentType.RoleSelect,
	ComponentType.MentionableSelect,
	ComponentType.ChannelSelect,
]);

const isSelectMenu = (type: number) => SELECT_MENUS.has(type);

/** A select in a modal is required unless marked otherwise, and takes one value unless it says more. */
function selectBounds(input: ComponentPayload): { min: number; max: number } {
	return {
		min: input.min_values ?? (input.required === false ? 0 : 1),
		max: input.max_values ?? (input.type === ComponentType.CheckboxGroup ? (input.options?.length ?? 1) : 1),
	};
}

function fileBounds(input: ComponentPayload): { min: number; max: number } {
	return {
		min: input.min_files ?? (input.required === false ? 0 : 1),
		max: input.max_files ?? 1,
	};
}

/** Selection counts that native HTML validation cannot check. */
export function modalFieldError(input: ComponentPayload, value: ModalFieldValue | undefined): string | undefined {
	const counted =
		input.type === ComponentType.FileUpload || isSelectMenu(input.type) || input.type === ComponentType.CheckboxGroup;
	if (!counted) return;
	const count = Array.isArray(value) ? value.length : 0;
	const { min, max } = input.type === ComponentType.FileUpload ? fileBounds(input) : selectBounds(input);
	if (count >= min && count <= max) return;
	return input.type === ComponentType.FileUpload
		? `Choose ${countSpan(min, max)} file(s).`
		: `${selectionHint(min, max)}.`;
}

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
	disabled,
	onFiles,
	label,
	description,
	input,
	values,
	setValues,
	error,
	guild,
	names,
}: {
	disabled: boolean;
	onFiles?: (id: string, files: File[]) => void;
	label: string;
	description?: string;
	input: ComponentPayload;
	values: ModalValues;
	setValues: (next: ModalValues) => void;
	error?: string;
	guild?: Guild;
	names?: NameMap;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	const id = input.custom_id ?? '';
	const value = values[id];
	const describedBy =
		[description ? `${id}-description` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(' ') ||
		undefined;
	const fieldError = error && (
		<span className="field-error" id={`${id}-error`} role="alert">
			{error}
		</span>
	);
	if (input.type === ComponentType.TextInput) {
		const shared = {
			id,
			name: id,
			required: input.required ?? true,
			minLength: input.min_length,
			maxLength: input.max_length,
			placeholder: input.placeholder,
			'aria-describedby': description ? `${id}-description` : undefined,
			value: typeof value === 'string' ? value : '',
			onChange: (event: { target: { value: string } }) => setValues({ ...values, [id]: event.target.value }),
		};
		return (
			<div className="modal-field">
				<FieldHeading id={id} label={label} description={description} required={shared.required} />
				{input.style === PARAGRAPH_STYLE ? <textarea {...shared} rows={4} /> : <input {...shared} type="text" />}
			</div>
		);
	}
	if (isSelectMenu(input.type)) {
		const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
		const { min, max } = selectBounds(input);
		return (
			<div className="modal-field">
				<FieldHeading id={id} label={label} description={description} required={min > 0} group />
				<SelectMenu
					id={id}
					labelledBy={`${id}-label`}
					invalid={Boolean(error)}
					describedBy={describedBy}
					options={selectOptions(input, names, guild)}
					selected={selected}
					onChange={next => setValues({ ...values, [id]: next })}
					min={min}
					max={max}
					placeholder={input.placeholder ?? 'Make a selection'}
				/>
				{fieldError}
			</div>
		);
	}
	if (input.type === ComponentType.Checkbox)
		return (
			<div className="modal-field">
				<label className="modal-choice">
					<input
						id={id}
						aria-describedby={describedBy}
						type="checkbox"
						checked={value === true}
						onChange={event => setValues({ ...values, [id]: event.target.checked })}
					/>
					<span>{label}</span>
				</label>
				{description && (
					<p className="modal-field-description" id={`${id}-description`}>
						{description}
					</p>
				)}
			</div>
		);
	if (input.type === ComponentType.RadioGroup || input.type === ComponentType.CheckboxGroup) {
		const radio = input.type === ComponentType.RadioGroup;
		const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
		const { max } = selectBounds(input);
		return (
			<div
				className="modal-field"
				id={id}
				role="group"
				aria-labelledby={`${id}-label`}
				aria-invalid={Boolean(error) || undefined}
				aria-describedby={describedBy}>
				<FieldHeading id={id} label={label} description={description} required={input.required !== false} group />
				{input.options?.map(option => (
					<label className="modal-choice" key={option.value}>
						<input
							type={radio ? 'radio' : 'checkbox'}
							name={id}
							value={option.value}
							required={radio && input.required !== false}
							checked={radio ? value === option.value : selected.includes(option.value)}
							disabled={!radio && !selected.includes(option.value) && selected.length >= max}
							onChange={event =>
								setValues({
									...values,
									[id]: radio
										? option.value
										: event.target.checked
											? [...selected, option.value]
											: selected.filter(item => item !== option.value),
								})
							}
						/>
						<span>
							{option.label}
							{option.description && <small>{option.description}</small>}
						</span>
					</label>
				))}
				{radio && input.required === false && (
					<button type="button" className="button small" onClick={() => setValues({ ...values, [id]: null })}>
						Clear selection
					</button>
				)}
				{fieldError}
			</div>
		);
	}
	if (input.type === ComponentType.FileUpload) {
		const files = Array.isArray(value) ? value.filter(item => typeof item !== 'string') : [];
		const multiple = fileBounds(input).max > 1;
		function chooseFiles(selected: File[]) {
			if (disabled || selected.length === 0) return;
			if (onFiles) {
				onFiles(id, selected);
				return;
			}
			const chosen = selected.map((file, index) => ({
				id: `${Date.now()}${String(index).padStart(5, '0')}`,
				filename: file.name,
				size: file.size,
				content_type: file.type || undefined,
				url: attachmentReference(file.name),
			}));
			setValues({ ...values, [id]: chosen });
		}
		return (
			<div className="modal-field">
				<FieldHeading id={id} label={label} description={description} required={input.required !== false} />
				<input
					hidden
					ref={fileInput}
					type="file"
					multiple={multiple}
					onChange={event => {
						const selected = Array.from(event.target.files ?? []);
						event.target.value = '';
						chooseFiles(selected);
					}}
				/>
				<button
					type="button"
					id={id}
					className="modal-file-picker"
					disabled={disabled}
					data-file-picker
					aria-label={`Choose file${multiple ? 's' : ''} for ${label}`}
					aria-invalid={Boolean(error) || undefined}
					aria-describedby={describedBy}
					onClick={() => fileInput.current?.click()}
					onDragOver={event => event.preventDefault()}
					onDrop={event => {
						event.preventDefault();
						chooseFiles(Array.from(event.dataTransfer.files));
					}}>
					<UploadIcon />
					<span>
						Drop {multiple ? 'files' : 'a file'} here or <span className="text-link">browse</span>
					</span>
					<small>{onFiles ? `Maximum ${maxUploadLabel} per file.` : 'Metadata preview'}</small>
				</button>
				{files.map(file => (
					<span className="modal-file" key={file.id}>
						{file.filename} · {file.size.toLocaleString()} bytes
					</span>
				))}
				{files.length > 0 && (
					<button
						type="button"
						className="button small"
						onClick={() => {
							if (fileInput.current) fileInput.current.value = '';
							setValues({ ...values, [id]: [] });
						}}>
						Clear files
					</button>
				)}
				{fieldError}
				<p className="modal-field-description">
					{onFiles
						? `Files are uploaded to the lab host and remain available for checkpoint replay. ` +
							`Maximum ${maxUploadLabel} per file.`
						: 'This preview sends file metadata only.'}
				</p>
			</div>
		);
	}
	return <div className="unsupported">Unsupported field type {input.type}</div>;
}

function initialModalValues(modal: PendingModal, names?: NameMap, guild?: Guild): ModalValues {
	const values: ModalValues = {};
	for (const input of componentTree(modal.payload.components)) {
		if (!input.custom_id) continue;
		if (isSelectMenu(input.type) || input.type === ComponentType.CheckboxGroup)
			values[input.custom_id] = selectOptions(input, names, guild)
				.filter(option => option.default)
				.map(option => option.value);
		else if (input.type === ComponentType.RadioGroup)
			values[input.custom_id] = input.options?.find(option => option.default)?.value ?? null;
		else if (input.type === ComponentType.Checkbox) values[input.custom_id] = input.default ?? false;
		else if (input.type === ComponentType.FileUpload) values[input.custom_id] = [];
		else if (input.type === ComponentType.TextInput) values[input.custom_id] = input.value ?? '';
	}
	return values;
}

export function Modal({
	uploadFiles,
	modal,
	draft,
	onDraft,
	onClose,
	onSubmit,
	expired = false,
	guild,
	names,
}: {
	uploadFiles?: (files: File[]) => Promise<ModalAttachment[]>;
	modal: PendingModal;
	expired?: boolean;
	guild?: Guild;
	names?: NameMap;
	/** What the user had typed or selected before closing this same modal. */
	draft?: ModalValues;
	onDraft?: (values: ModalValues) => void;
	onClose: () => void;
	onSubmit: (submission: { customId: string; fields: ModalValues }) => void | Promise<void>;
}) {
	const { pending, error, run } = usePendingAction();
	const [attempted, setAttempted] = useState(false);
	const [values, setStoredValues] = useState<ModalValues>(() => ({
		...initialModalValues(modal, names, guild),
		...draft,
	}));
	const setValues = (next: ModalValues) => {
		setStoredValues(next);
		onDraft?.(next);
	};
	const dialog = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = () => {
		if (!pending) onClose();
	};
	useEffect(() => {
		const { messageId, customId } = modal.source ?? {};
		const opener =
			messageId && customId
				? document.querySelector<HTMLElement>(
						`[data-message-id="${CSS.escape(messageId)}"] [data-custom-id="${CSS.escape(customId)}"]`,
					)
				: null;
		const previous =
			opener ??
			(document.activeElement instanceof HTMLElement && document.activeElement !== document.body
				? document.activeElement
				: null);
		(
			dialog.current?.querySelector<HTMLElement>(
				'input:not([hidden]), textarea, select, button[aria-haspopup="listbox"], button[data-file-picker]',
			) ?? dialog.current?.querySelector<HTMLElement>('button[type="submit"]')
		)?.focus();
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') close.current();
			if (event.key !== 'Tab' || !dialog.current) return;
			const focusable = Array.from(
				dialog.current.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex="0"]'),
			).filter(element => !element.matches(':disabled, [hidden]'));
			if (!focusable.includes(document.activeElement as HTMLElement)) {
				event.preventDefault();
				focusable[0]?.focus();
				return;
			}
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
			requestAnimationFrame(() => {
				if (document.querySelector('[role="dialog"]')) return;
				const target =
					previous?.isConnected && !previous.matches(':disabled')
						? previous
						: document.querySelector<HTMLElement>('.composer [role="combobox"]');
				target?.focus();
			});
		};
	}, []);
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (expired) return;
		setAttempted(true);
		for (const input of componentTree(modal.payload.components)) {
			if (!input.custom_id || !modalFieldError(input, values[input.custom_id])) continue;
			const field = document.getElementById(input.custom_id);
			(field?.querySelector<HTMLElement>('input, button') ?? field)?.focus();
			return;
		}
		void run(() => onSubmit({ customId: modal.customId, fields: values }));
	}
	function renderField(input: ComponentPayload, label: string, key: string | number, description?: string) {
		return (
			<ModalField
				disabled={pending || expired}
				key={key}
				label={label}
				description={description}
				input={input}
				error={attempted ? modalFieldError(input, values[input.custom_id ?? '']) : undefined}
				values={values}
				onFiles={
					uploadFiles
						? (id, files) => {
								void run(async () => setValues({ ...values, [id]: await uploadFiles(files) }));
							}
						: undefined
				}
				setValues={setValues}
				guild={guild}
				names={names}
			/>
		);
	}
	return (
		<div className="modal-backdrop">
			<div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialog}>
				<div className="modal-heading">
					<h2 id="modal-title">{modal.payload.title}</h2>
					<button type="button" className="icon-button" aria-label="Close" disabled={pending} onClick={onClose}>
						<CloseIcon size={20} />
					</button>
				</div>
				{expired && (
					<p className="interaction-error modal-error" role="alert">
						The bot is no longer waiting for this form. Your draft is kept here; close it when you are done.
					</p>
				)}
				<form onSubmit={submit} aria-busy={pending}>
					<div className="modal-scroll">
						<fieldset className="modal-content" disabled={pending}>
							{modal.payload.components.map((component, index) => {
								if (component.type === ComponentType.TextDisplay)
									return <Markdown key={component.id ?? index} text={component.content ?? ''} />;
								if (component.type === ComponentType.Label && component.component)
									return renderField(
										component.component,
										component.label ?? component.component.custom_id ?? '',
										component.id ?? index,
										component.description,
									);
								if (component.type === ComponentType.ActionRow)
									return component.components?.map((input, fieldIndex) =>
										renderField(input, input.label ?? input.custom_id ?? '', input.custom_id ?? fieldIndex),
									);
								return (
									<div className="unsupported" key={component.id ?? index}>
										Unsupported component type {component.type}
									</div>
								);
							})}
						</fieldset>
						{error && (
							<p className="interaction-error modal-error" role="alert">
								{error}
							</p>
						)}
					</div>
					<div className="modal-actions">
						<button type="button" className="button" disabled={pending} onClick={onClose}>
							Cancel
						</button>
						<button type="submit" className="button primary" disabled={pending || expired}>
							{pending && <span className="action-spinner" aria-hidden="true" />}
							{pending ? 'Submitting…' : 'Submit'}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
