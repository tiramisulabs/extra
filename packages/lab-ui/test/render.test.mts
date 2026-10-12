import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResumeForms, unreachableForms } from '../src/app/ResumeForms';
import type { PendingModal } from '../src/bridge';
import { messageText } from '../src/messages';
import { Component, selectOptions } from '../src/render/Component';
import { avatarUrl, mediaUrl } from '../src/render/cdn';
import { Emoji } from '../src/render/Emoji';
import { continues } from '../src/render/grouping';
import { Markdown } from '../src/render/Markdown';
import { Message } from '../src/render/Message';
import { Modal, modalFieldError } from '../src/render/Modal';

test('modal prefill and StringSelect defaults survive rendering; multi-select waits for a valid choice', () => {
	const modal: PendingModal = {
		userId: 'alice',
		interactionId: 'interaction-2',
		customId: 'review',
		payload: {
			custom_id: 'review',
			title: 'Review',
			components: [
				{
					type: 18,
					label: 'Reason',
					description: 'Why this needs review',
					component: { type: 4, custom_id: 'reason', value: 'Prefilled' },
				},
				{
					type: 18,
					label: 'Tags',
					component: {
						type: 3,
						custom_id: 'tags',
						min_values: 2,
						max_values: 2,
						options: [
							{ label: 'One', value: 'one', default: true },
							{ label: 'Two', value: 'two' },
						],
					},
				},
			],
		},
	};
	const html = renderToStaticMarkup(createElement(Modal, { modal, onClose() {}, onSubmit() {} }));
	assert.match(html, /value="Prefilled"/);
	assert.match(html, /id="reason-description"[^>]*>Why this needs review<\/p>/);
	assert.match(
		html,
		/<form\b[^>]*>[\s\S]*<input\b[^>]*>[\s\S]*<button\b[^>]*type="submit"[^>]*>Submit<\/button>[\s\S]*<\/form>/,
	);
	const trigger = /<button\b[^>]*id="tags"[^>]*>/.exec(html)?.[0];
	assert.ok(trigger);
	assert.match(trigger, /type="button"/);
	assert.match(trigger, /aria-haspopup="listbox"/);
	assert.match(trigger, /aria-expanded="false"/);
	assert.match(html, />One<\/span>/);
	assert.doesNotMatch(html, /type="checkbox"/);
	assert.doesNotMatch(html, /class="field-error"/);
	assert.equal(modalFieldError({ type: 3, min_values: 2, max_values: 2 }, ['one']), 'Select 2.');
	assert.equal(modalFieldError({ type: 3, min_values: 2, max_values: 2 }, ['one', 'two']), undefined);

	const select = renderToStaticMarkup(
		createElement(Component, {
			component: {
				type: 3,
				custom_id: 'tags',
				min_values: 2,
				max_values: 2,
				options: [
					{ label: 'One', value: 'one', default: true },
					{ label: 'Two', value: 'two' },
				],
			},
			messageId: 'message-1',
			onIntent() {},
		}),
	);
	assert.match(select, /aria-haspopup="listbox"/);
	assert.match(select, />One<\/span>/);
});

test('the text that identifies a message is its content, then an embed, then the first text display it shows', () => {
	assert.equal(messageText({ content: 'Hello', embeds: [{ title: 'Embed' }] }), 'Hello');
	assert.equal(messageText({ embeds: [{ color: 1 }, { description: 'Second embed' }] }), 'Second embed');
	assert.equal(
		messageText({
			components: [
				{
					type: 17,
					components: [
						{ type: 9, components: [{ type: 10, content: 'Inside a section' }] },
						{ type: 10, content: 'After the section' },
					],
				},
			],
		}),
		'Inside a section',
	);
	assert.equal(
		messageText({ components: [{ type: 1, components: [{ type: 2, label: 'Only a button' }] }] }),
		undefined,
	);
});

test('markdown and buttons load custom emojis from the CDN; invalid data falls back without building URLs', () => {
	const html = renderToStaticMarkup(
		createElement(Markdown, {
			text: '### 21. Age\n<a:Arrow_Green:1304880812281434212> Click **Accept** in [the guide](https://example.com/g) snake_case_name\n> quoted\n- one\n- two',
		}),
	);
	assert.match(html, /<h3[^>]*>21\. Age<\/h3>/);
	assert.match(
		html,
		/<img[^>]*src="https:\/\/cdn\.discordapp\.com\/emojis\/1304880812281434212\.webp\?size=64&amp;animated=true" alt=":Arrow_Green:"/,
	);
	assert.doesNotMatch(html, /&lt;a:Arrow_Green/);
	assert.match(html, /<a href="https:\/\/example\.com\/g"[^>]*>the guide<\/a>/);
	assert.match(html, /snake_case_name/);
	assert.doesNotMatch(html, /<em>case<\/em>/);
	assert.match(html, /<blockquote[^>]*>/);
	assert.match(html, /<ul[^>]*><li>one<\/li><li>two<\/li><\/ul>/);

	const button = renderToStaticMarkup(
		createElement(Component, {
			component: {
				type: 2,
				style: 5,
				url: 'https://example.com',
				label: 'Get started',
				emoji: { name: 'MoneySoaring', id: '1349674855439532043' },
			},
			messageId: 'm',
			onIntent() {},
		}),
	);
	assert.match(
		button,
		/<img[^>]*src="https:\/\/cdn\.discordapp\.com\/emojis\/1349674855439532043\.webp[^"]*" alt=":MoneySoaring:"/,
	);

	// The size variant must not reuse the generic `.button` control class (padding/background).
	assert.ok(!/<img class="([^"]*)"/.exec(button)?.[1].split(' ').includes('button'));
	const invalid = renderToStaticMarkup(createElement(Emoji, { emoji: { name: 'broken', id: 'not-a-snowflake' } }));
	assert.match(invalid, /:broken:/);
	assert.doesNotMatch(invalid, /<img/);
	assert.equal(
		avatarUrl({ id: '1349674855439532043', avatar: '../../etc' }),
		'https://cdn.discordapp.com/embed/avatars/5.png',
	);
	assert.equal(mediaUrl('http://example.com/x.png'), undefined);
	assert.equal(mediaUrl('javascript:alert(1)'), undefined);
	assert.equal(mediaUrl('https://i.imgur.com/icon.png'), 'https://i.imgur.com/icon.png');
});

test('ephemeral responses never merge into a previous message; public ones still group', () => {
	const bot = { id: '2181717408122346670', username: 'bot', bot: true };
	const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
	const message = (
		id: string,
		seconds: number,
		extra: { visibility?: 'public' | 'ephemeral'; flags?: number } = {},
	) => ({
		id,
		channelId: 'c',
		sequence: seconds,
		visibility: extra.visibility ?? ('public' as const),
		payload: { id, author: bot, content: id, timestamp: at(seconds), flags: extra.flags },
	});
	assert.equal(continues(message('a', 0), message('b', 30)), true);
	assert.equal(continues(message('a', 0), message('b', 30, { visibility: 'ephemeral' })), false);
	assert.equal(
		continues(message('a', 0, { visibility: 'ephemeral' }), message('b', 30, { visibility: 'ephemeral' })),
		false,
	);
	assert.equal(continues(message('a', 0, { flags: 64 }), message('b', 30)), false);
	assert.equal(continues(message('a', 0), message('b', 8 * 60)), false);
});

test('a reopened modal shows the draft the user left, text and selections, over the bot prefill', () => {
	const modal: PendingModal = {
		userId: 'alice',
		interactionId: 'interaction-3',
		customId: 'prefs',
		payload: {
			custom_id: 'prefs',
			title: 'Preferences',
			components: [
				{ type: 18, label: 'Email', component: { type: 4, custom_id: 'email', value: 'bot@example.com' } },
				{
					type: 18,
					label: 'Delivery',
					component: {
						type: 3,
						custom_id: 'delivery',
						options: [
							{ label: 'Direct message', value: 'dm', default: true },
							{ label: 'Email', value: 'email' },
						],
					},
				},
			],
		},
	};
	const html = renderToStaticMarkup(
		createElement(Modal, {
			modal,
			draft: { email: 'draft@example.com', delivery: ['email'] },
			onClose: () => undefined,
			onSubmit: () => undefined,
		}),
	);
	assert.match(html, /value="draft@example\.com"/);
	assert.doesNotMatch(html, /bot@example\.com/);
	assert.match(html, />Email<\/span>/);
	assert.doesNotMatch(html, />Direct message</);
});

test("only the viewer's own ephemeral messages offer Dismiss message", () => {
	const message = {
		id: 'm1',
		channelId: 'c1',
		sequence: 1,
		visibility: 'ephemeral' as const,
		ownerId: 'alice',
		payload: { id: 'm1', content: 'Saved', flags: 64, author: { id: 'bot', username: 'Bot', bot: true } },
	};
	const own = renderToStaticMarkup(
		createElement(Message, { message, onIntent: () => undefined, onDismiss: () => undefined }),
	);
	assert.match(own, /Only you can see this/);
	assert.match(own, /Dismiss message/);
	const other = renderToStaticMarkup(createElement(Message, { message, onIntent: () => undefined }));
	assert.match(other, /Only you can see this/);
	assert.doesNotMatch(other, /Dismiss message/);
});

test('a closed form whose trigger is no longer visible offers Reopen; a visible trigger or another actor does not', () => {
	const form: PendingModal = {
		userId: 'alice',
		interactionId: 'i-1',
		customId: 'verify:1',
		closed: true,
		source: { channelId: 'c1', messageId: 'm-verify', customId: 'verify' },
		payload: { custom_id: 'verify:1', title: 'Verify email', components: [] },
	};
	const trigger = {
		id: 'm-verify',
		channelId: 'c1',
		sequence: 1,
		visibility: 'ephemeral' as const,
		payload: { id: 'm-verify' },
	};
	assert.deepEqual(unreachableForms([form], ['i-1'], 'alice', []), [form], 'trigger dismissed');
	const live = {
		...trigger,
		payload: {
			id: 'm-verify',
			components: [{ type: 1, components: [{ type: 2, custom_id: 'verify', label: 'Verify' }] }],
		},
	};
	const disabled = {
		...trigger,
		payload: {
			id: 'm-verify',
			components: [{ type: 1, components: [{ type: 2, custom_id: 'verify', label: 'Verify', disabled: true }] }],
		},
	};
	assert.deepEqual(unreachableForms([form], ['i-1'], 'alice', [live]), [], 'trigger still on screen');
	assert.deepEqual(unreachableForms([form], ['i-1'], 'alice', [trigger]), [form], 'message without its button');
	assert.deepEqual(unreachableForms([form], ['i-1'], 'alice', [disabled]), [form], 'button disabled');
	assert.deepEqual(unreachableForms([form], [], 'alice', []), [], 'form is open');
	assert.deepEqual(unreachableForms([form], ['i-1'], 'bob', []), [], "someone else's form");
	const html = renderToStaticMarkup(createElement(ResumeForms, { forms: [form], onReopen: () => undefined }));
	assert.match(html, /Verify email/);
	assert.match(html, />Reopen</);
});

test('attachments render their metadata, image previews and unavailable files without exposing spoilers', () => {
	const message = {
		id: 'attachment-message',
		channelId: 'channel',
		sequence: 1,
		visibility: 'public' as const,
		payload: {
			content: 'Files',
			attachments: [
				{
					id: 'image',
					filename: 'photo.png',
					url: 'https://cdn.discordapp.com/photo.png',
					content_type: 'image/png',
					description: 'A photo',
					size: 20,
				},
				{ id: 'file', filename: 'report.csv', url: 'attachment://report.csv', size: 42 },
				{
					id: 'spoiler',
					filename: 'SPOILER_private.png',
					url: 'https://cdn.discordapp.com/private.png',
					content_type: 'image/png',
				},
			],
		},
	};
	const html = renderToStaticMarkup(createElement(Message, { message, onIntent() {} }));
	assert.match(html, /alt="A photo"/);
	assert.match(html, /report.csv/);
	assert.match(html, /42 bytes/);
	assert.match(html, /File preview unavailable/);
	assert.match(html, /Reveal spoiler attachment/);
	assert.doesNotMatch(html, /src="https:\/\/cdn.discordapp.com\/private.png"/);
});

test('entity select choices stay in the source guild and preserve allowed defaults', () => {
	const guild = {
		id: 'home',
		name: 'Home',
		members: [{ id: 'member', name: 'Member', bot: false }],
		roles: [{ id: 'role', name: 'Role', position: 1, permissions: '0' }],
		channels: [
			{ id: 'text', name: 'general', type: 0, visibleTo: [] },
			{ id: 'voice', name: 'Voice', type: 2, visibleTo: [] },
		],
	};
	const names = {
		users: { foreign: 'Other member' },
		roles: { foreign: 'Other role' },
		channels: { foreign: 'Other channel' },
	};
	assert.deepEqual(
		selectOptions({ type: 8, channel_types: [0], default_values: [{ id: 'text', type: 'channel' }] }, names, guild),
		[{ value: 'text', label: 'general', default: true }],
	);
	assert.deepEqual(
		selectOptions({ type: 7 }, names, guild).map(option => option.value),
		['member', 'role'],
	);
	assert.deepEqual(
		selectOptions({ type: 5 }, names, guild).map(option => option.value),
		['member'],
	);
	assert.deepEqual(
		selectOptions({ type: 6 }, names, guild).map(option => option.value),
		['role'],
	);
});

test('all modal field kinds render with defaults and legacy action rows remain editable', () => {
	const guild = { id: 'g', name: 'Guild', roles: [], channels: [], members: [{ id: 'u', name: 'Alice', bot: false }] };
	const modal: PendingModal = {
		userId: 'u',
		interactionId: 'all-fields',
		customId: 'all',
		payload: {
			custom_id: 'all',
			title: 'All fields',
			components: [
				{ type: 1, components: [{ type: 4, custom_id: 'legacy', label: 'Legacy', value: 'Prefilled' }] },
				{
					type: 18,
					label: 'Assignee',
					component: { type: 5, custom_id: 'who', default_values: [{ id: 'u', type: 'user' }] },
				},
				{
					type: 18,
					label: 'Radio',
					component: {
						type: 21,
						custom_id: 'radio',
						options: [
							{ label: 'A', value: 'a', default: true },
							{ label: 'B', value: 'b' },
						],
					},
				},
				{
					type: 18,
					label: 'Checks',
					component: { type: 22, custom_id: 'checks', options: [{ label: 'A', value: 'a', default: true }] },
				},
				{ type: 18, label: 'Confirm', component: { type: 23, custom_id: 'confirm', default: true } },
				{ type: 18, label: 'Files', component: { type: 19, custom_id: 'files', required: false } },
			],
		},
	};
	const html = renderToStaticMarkup(createElement(Modal, { modal, guild, onClose() {}, onSubmit() {} }));
	assert.doesNotMatch(html, /Unsupported/);
	assert.match(html, /type="radio"[^>]*checked=""[^>]*value="a"/);
	assert.match(html, /id="confirm"[^>]*type="checkbox"[^>]*checked=""/);
	assert.match(html, /type="checkbox"[^>]*name="checks"[^>]*checked=""[^>]*value="a"/);
	assert.match(html, /type="file"/);
	assert.match(html, /Alice/);
	assert.match(html, /value="Prefilled"/);
});

test('V2 files and media resolve their attachments only at the component position', () => {
	const message = {
		id: 'v2-media',
		channelId: 'c',
		sequence: 1,
		visibility: 'public' as const,
		payload: {
			flags: 32768,
			content: 'Hidden legacy content',
			embeds: [{ title: 'Hidden legacy embed' }],
			attachments: [
				{ id: 'image', filename: 'photo.png', url: 'https://cdn.discordapp.com/photo.png' },
				{ id: 'file', filename: 'report.csv', url: 'https://cdn.discordapp.com/report.csv', size: 12 },
				{ id: 'unexposed', filename: 'unexposed.txt', url: 'https://cdn.discordapp.com/unexposed.txt' },
			],
			components: [
				{
					type: 17,
					accent_color: 0x123456,
					components: [
						{ type: 10, content: 'Visible V2 content' },
						{ type: 12, items: [{ media: { url: 'attachment://photo.png' }, description: 'Photo' }] },
						{ type: 13, file: { url: 'attachment://report.csv' } },
					],
				},
			],
		},
	};
	const html = renderToStaticMarkup(createElement(Message, { message, onIntent() {} }));
	assert.match(html, /src="https:\/\/cdn.discordapp.com\/photo.png"/);
	assert.match(html, /href="https:\/\/cdn.discordapp.com\/report.csv"/);
	assert.match(html, /Visible V2 content/);
	assert.match(html, /border-left-color:#123456/);
	assert.doesNotMatch(html, /Hidden legacy|unexposed.txt/);
	assert.equal(html.match(/report.csv<\/a>/g)?.length, 1);
});

test('Discord-normalized V2 files render without top-level attachments', () => {
	const message = {
		id: 'normalized-v2',
		channelId: 'c',
		sequence: 1,
		visibility: 'public' as const,
		payload: {
			flags: 32768,
			attachments: [],
			components: [
				{
					type: 13,
					id: 4,
					name: 'lab-parity.txt',
					size: 44,
					file: { url: 'https://cdn.discordapp.com/lab-parity.txt', attachment_id: 'file', content_type: 'text/plain' },
				},
			],
		},
	};
	const html = renderToStaticMarkup(createElement(Message, { message, onIntent() {} }));
	assert.match(html, /href="https:\/\/cdn.discordapp.com\/lab-parity.txt"/);
	assert.match(html, /lab-parity.txt<\/a>/);
	assert.match(html, /44 bytes/);
	assert.doesNotMatch(html, /file-placeholder/);
	assert.equal(messageText(message.payload), 'lab-parity.txt');
});
