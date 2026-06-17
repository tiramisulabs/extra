import { MESSAGE_FLAG_COMPONENTS_V2 } from './message-flags';
import { apiError, ErrorCode } from './rest';
import { arrayValue, asRecord, numberValue, stringValue, walkComponents } from './state';

// Server-side message-body validation: the mock simulates Discord's 400s for impossible payloads so an
// over-limit/malformed send fails loud instead of passing a happy-path test. Pure functions (no WorldState
// dependency) — they only borrow state.ts's value/component parsing helpers.

const MAX_MESSAGE_CONTENT = 2000;
const cp = (value: string): number => [...value].length;

/**
 * Reject an embed media/link URL whose scheme Discord forbids (real 50035 "Not a well formed URL"). `url` and
 * `author.url` accept only http/https; image/thumbnail/icon URLs additionally accept `attachment://`. Absent or
 * empty values are fine.
 */
function assertEmbedUrl(value: unknown, label: string, allowAttachment: boolean): void {
	if (typeof value !== 'string' || value.length === 0) return;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
	const ok = scheme === 'http' || scheme === 'https' || (allowAttachment && scheme === 'attachment');
	if (!ok) apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: ${label} is not a valid URL`);
}

/**
 * Validate a message's embeds against Discord's full documented limits (the F4 superset): at most 10 embeds;
 * per-embed title<=256, description<=4096, <=25 fields, each field name 1..256 and value 1..1024, footer
 * text<=2048, author name<=256, color a 0..0xFFFFFF integer, and well-formed media URLs; plus the combined
 * 6000-character cap across all embeds. Throws 50035 so an over-limit embed fails loud.
 */
function assertValidEmbeds(embeds: unknown[]): void {
	if (embeds.length > 10)
		apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: a message can have at most 10 embeds');
	let total = 0;
	for (const entry of embeds) {
		const embed = asRecord(entry);
		const title = stringValue(embed.title);
		if (title !== undefined) {
			if (cp(title) > 256)
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: embed title must be 256 or fewer in length');
			total += cp(title);
		}
		const description = stringValue(embed.description);
		if (description !== undefined) {
			if (cp(description) > 4096) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed description must be 4096 or fewer in length',
				);
			}
			total += cp(description);
		}
		const fields = arrayValue(embed.fields);
		if (fields.length > 25)
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: an embed can have at most 25 fields');
		for (const rawField of fields) {
			const field = asRecord(rawField);
			const name = stringValue(field.name) ?? '';
			const value = stringValue(field.value) ?? '';
			if (cp(name) < 1 || cp(name) > 256) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed field name must be between 1 and 256 in length',
				);
			}
			if (cp(value) < 1 || cp(value) > 1024) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed field value must be between 1 and 1024 in length',
				);
			}
			total += cp(name) + cp(value);
		}
		const footer = asRecord(embed.footer);
		const footerText = stringValue(footer.text);
		if (footerText !== undefined) {
			if (cp(footerText) > 2048) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed footer text must be 2048 or fewer in length',
				);
			}
			total += cp(footerText);
		}
		const author = asRecord(embed.author);
		const authorName = stringValue(author.name);
		if (authorName !== undefined) {
			if (cp(authorName) > 256)
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: embed author name must be 256 or fewer in length');
			total += cp(authorName);
		}
		const color = numberValue(embed.color);
		if (color !== undefined && (!Number.isInteger(color) || color < 0 || color > 0xffffff)) {
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: embed color must be an integer between 0 and 16777215',
			);
		}
		assertEmbedUrl(embed.url, 'embed url', false);
		assertEmbedUrl(author.url, 'embed author url', false);
		assertEmbedUrl(asRecord(embed.image).url, 'embed image url', true);
		assertEmbedUrl(asRecord(embed.thumbnail).url, 'embed thumbnail url', true);
		assertEmbedUrl(footer.icon_url, 'embed footer icon url', true);
		assertEmbedUrl(author.icon_url, 'embed author icon url', true);
	}
	if (total > 6000) {
		apiError(
			400,
			ErrorCode.InvalidFormBody,
			'Invalid Form Body: the combined length of all embeds must be 6000 or fewer in length',
		);
	}
}

/**
 * Validate an outgoing message's components against Discord's documented form limits (F5): every interactive
 * custom_id is <=100 chars and unique across the message, string selects carry 1..25 options, and select
 * min/max_values stay in 0..25 with min<=max. Throws a 50035 MockApiError, so an impossible component tree
 * fails loud instead of passing a happy-path test.
 */
function assertValidComponents(components: unknown): void {
	const customIds = new Set<string>();
	walkComponents(components, node => {
		const type = numberValue(node.type);
		const customId = stringValue(node.custom_id);
		if (customId !== undefined) {
			if ([...customId].length > 100) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: component custom_id must be 100 or fewer in length',
				);
			}
			if (customIds.has(customId))
				apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: duplicate component custom_id "${customId}"`);
			customIds.add(customId);
		}
		if (type !== undefined && type >= 3 && type <= 8) {
			if (type === 3) {
				const options = arrayValue(node.options).length;
				if (options < 1 || options > 25) {
					apiError(
						400,
						ErrorCode.InvalidFormBody,
						'Invalid Form Body: a string select menu must have between 1 and 25 options',
					);
				}
			}
			const min = numberValue(node.min_values);
			const max = numberValue(node.max_values);
			if (min !== undefined && (min < 0 || min > 25)) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: select min_values must be between 0 and 25');
			}
			if (max !== undefined && (max < 1 || max > 25)) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: select max_values must be between 1 and 25');
			}
			if (min !== undefined && max !== undefined && min > max) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: select min_values cannot exceed max_values');
			}
		}
	});
}

/**
 * Validate an outgoing message body against Discord's documented limits, throwing a MockApiError (which the
 * REST layer surfaces like a real 400) so an over-limit send fails loud instead of passing a happy-path test.
 * `create` additionally rejects a fully empty body (real code 50006).
 */
export function assertSendableMessage(raw: Record<string, unknown>, mode: 'create' | 'edit'): void {
	const content = typeof raw.content === 'string' ? raw.content : undefined;
	if (content !== undefined && [...content].length > MAX_MESSAGE_CONTENT) {
		apiError(
			400,
			ErrorCode.InvalidFormBody,
			`Invalid Form Body: content must be ${MAX_MESSAGE_CONTENT} or fewer in length`,
		);
	}
	const embeds = Array.isArray(raw.embeds) ? raw.embeds : [];
	assertValidEmbeds(embeds);
	// F19: a Components-v2 body forbids top-level content/embeds and requires a non-empty components tree.
	if (((numberValue(raw.flags) ?? 0) & MESSAGE_FLAG_COMPONENTS_V2) !== 0) {
		if (content !== undefined && content !== '') {
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: content is not allowed with the IsComponentsV2 flag',
			);
		}
		if (embeds.length > 0)
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: embeds are not allowed with the IsComponentsV2 flag',
			);
		if (!Array.isArray(raw.components) || raw.components.length === 0) {
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: the IsComponentsV2 flag requires a non-empty components array',
			);
		}
	}
	if (Array.isArray(raw.components)) assertValidComponents(raw.components);
	// F20: at most 3 stickers per message.
	if (Array.isArray(raw.sticker_ids) && raw.sticker_ids.length > 3) {
		apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: a message can have at most 3 stickers');
	}
	// F21: poll create caps.
	if (raw.poll !== undefined) {
		const poll = asRecord(raw.poll);
		const question = stringValue(asRecord(poll.question).text);
		if (question !== undefined && [...question].length > 300) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: poll question must be 300 or fewer in length');
		}
		const answers = arrayValue(poll.answers);
		if (answers.length > 10)
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: a poll can have at most 10 answers');
		for (const entry of answers) {
			const text = stringValue(asRecord(asRecord(entry).poll_media).text);
			if (text !== undefined && [...text].length > 55) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: poll answer text must be 55 or fewer in length');
			}
		}
		const duration = numberValue(poll.duration);
		if (duration !== undefined && (duration < 1 || duration > 768)) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: poll duration must be between 1 and 768 hours');
		}
	}
	if (mode === 'create') {
		const empty =
			(content === undefined || content === '') &&
			embeds.length === 0 &&
			(!Array.isArray(raw.components) || raw.components.length === 0) &&
			raw.poll === undefined &&
			raw.message_reference === undefined &&
			(!Array.isArray(raw.sticker_ids) || raw.sticker_ids.length === 0) &&
			(!Array.isArray(raw.attachments) || raw.attachments.length === 0);
		if (empty) apiError(400, ErrorCode.CannotSendEmptyMessage, 'Cannot send an empty message');
	}
}

/**
 * F22: validate a name/topic field against Discord's documented bounds (and optional charset), throwing a
 * 50035 when out of range. No-ops for absent (undefined/null) values so partial patches stay valid.
 */
export function assertNameBounds(value: unknown, min: number, max: number, label: string, charset?: RegExp): void {
	if (typeof value !== 'string') return;
	const length = [...value].length;
	if (length < min || length > max) {
		apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: ${label} must be between ${min} and ${max} in length`);
	}
	if (charset && value.length > 0 && !charset.test(value)) {
		apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: ${label} contains invalid characters`);
	}
}

const ATTACHMENT_SCHEME = 'attachment://';

function collectAttachmentRefs(value: unknown, out: Set<string>): void {
	if (typeof value === 'string') {
		if (value.startsWith(ATTACHMENT_SCHEME)) out.add(value.slice(ATTACHMENT_SCHEME.length));
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectAttachmentRefs(entry, out);
		return;
	}
	if (value && typeof value === 'object') {
		for (const entry of Object.values(value)) collectAttachmentRefs(entry, out);
	}
}

/**
 * F23: every `attachment://<filename>` reference in a message body (embed images, component-v2 media, etc.)
 * must be backed by a file uploaded in the SAME request — otherwise Discord drops the media silently. Reject
 * a reference with no matching uploaded filename so the missing-file mistake fails loud instead of passing green.
 */
export function assertAttachmentRefs(body: unknown, files: unknown): void {
	const refs = new Set<string>();
	collectAttachmentRefs(body, refs);
	if (refs.size === 0) return;
	const uploaded = new Set<string>();
	for (const file of arrayValue(files)) {
		const name = stringValue(asRecord(file).filename) ?? stringValue(asRecord(file).name);
		if (name !== undefined) uploaded.add(name);
	}
	for (const ref of refs) {
		if (!uploaded.has(ref)) {
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				`Invalid Form Body: references attachment://${ref} but no file named "${ref}" was uploaded in this request`,
			);
		}
	}
}
