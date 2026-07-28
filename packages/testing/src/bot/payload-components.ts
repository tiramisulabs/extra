/**
 * Wire-shape component factories, the counterpart to `apiMessage`/`apiEmbed` for the one part of a message
 * payload that had none.
 *
 * A component test has to seed the message that carries the component — the source-validation guard refuses a
 * click whose component was never rendered — so `{ type: 1, components: [{ type: 2, style: 4, ... }] }` had to
 * be hand-written at every such call site, snake_case and magic numbers included. These are `api*`, not
 * `mock*`: like every other payload factory they return plain data that `structuredClone` accepts, so they can
 * be seeded into a world.
 */

/** A component payload. Open-ended on purpose: Discord adds component types faster than a union can track. */
export interface ApiComponent {
	type: number;
	[key: string]: unknown;
}

const BUTTON_STYLE = {
	primary: 1,
	secondary: 2,
	success: 3,
	danger: 4,
	link: 5,
} as const;

const SELECT_TYPE = {
	string: 3,
	user: 5,
	role: 6,
	mentionable: 7,
	channel: 8,
} as const;

export type ApiButtonStyle = keyof typeof BUTTON_STYLE | number;
export type ApiSelectType = keyof typeof SELECT_TYPE;

export interface ApiButtonOptions {
	customId?: string;
	label?: string;
	/** `'primary' | 'secondary' | 'success' | 'danger' | 'link'`, or the raw Discord number. */
	style?: ApiButtonStyle;
	/** Link buttons carry a url instead of a custom_id; passing one defaults the style to `link`. */
	url?: string;
	disabled?: boolean;
	emoji?: { id?: string; name?: string; animated?: boolean };
}

export interface ApiSelectOption {
	label: string;
	value: string;
	description?: string;
	default?: boolean;
}

export interface ApiSelectOptions {
	customId?: string;
	/** Defaults to `'string'`; the other kinds carry no `options` array. */
	type?: ApiSelectType;
	placeholder?: string;
	options?: ApiSelectOption[];
	minValues?: number;
	maxValues?: number;
	disabled?: boolean;
}

export interface ApiTextInputOptions {
	customId?: string;
	label?: string;
	/** 1 = short, 2 = paragraph. */
	style?: 1 | 2;
	placeholder?: string;
	value?: string;
	required?: boolean;
	minLength?: number;
	maxLength?: number;
}

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function apiButton(options: ApiButtonOptions = {}): ApiComponent {
	const style = options.style ?? (options.url ? 'link' : 'primary');
	return {
		type: 2,
		style: typeof style === 'number' ? style : BUTTON_STYLE[style],
		...(options.url === undefined ? { custom_id: options.customId ?? 'test-button' } : { url: options.url }),
		label: options.label ?? 'Test',
		...opt('disabled', options.disabled),
		...opt('emoji', options.emoji),
	};
}

export function apiSelect(options: ApiSelectOptions = {}): ApiComponent {
	const type = SELECT_TYPE[options.type ?? 'string'];
	return {
		type,
		custom_id: options.customId ?? 'test-select',
		...(type === SELECT_TYPE.string ? { options: options.options ?? [] } : {}),
		...opt('placeholder', options.placeholder),
		...opt('min_values', options.minValues),
		...opt('max_values', options.maxValues),
		...opt('disabled', options.disabled),
	};
}

export function apiTextInput(options: ApiTextInputOptions = {}): ApiComponent {
	return {
		type: 4,
		custom_id: options.customId ?? 'test-input',
		style: options.style ?? 1,
		label: options.label ?? 'Test',
		...opt('placeholder', options.placeholder),
		...opt('value', options.value),
		...opt('required', options.required),
		...opt('min_length', options.minLength),
		...opt('max_length', options.maxLength),
	};
}

/** Wraps components in an action row (type 1) — the container a seeded message's `components` array holds. */
export function apiActionRow(...components: ApiComponent[]): ApiComponent {
	return { type: 1, components };
}
