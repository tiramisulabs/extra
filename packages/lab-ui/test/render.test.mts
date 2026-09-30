import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResumeForms, unreachableForms } from '../src/app/ResumeForms';
import type { PendingModal } from '../src/bridge';
import { FixtureClient } from '../src/dev/FixtureClient';
import { semanticAction } from '../src/HostClient';
import { avatarUrl, mediaUrl } from '../src/render/cdn';
import { Emoji } from '../src/render/Emoji';
import { continues } from '../src/render/grouping';
import { Markdown } from '../src/render/Markdown';
import { Component, Message } from '../src/render/Message';
import { Modal } from '../src/render/Modal';

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
	assert.match(html, /<p class="modal-field-description" id="reason-description">Why this needs review<\/p>/);
	assert.match(html, /<form><div class="modal-content">[\s\S]*<input[^>]*type="text"/);
	assert.match(html, /<button type="submit"[^>]*>Submit<\/button>/);
	assert.match(
		html,
		/<button id="tags" type="button" class="select-trigger"[^>]*aria-haspopup="listbox" aria-expanded="false"/,
	);
	assert.match(html, /<span class="select-chip">One<\/span>/);
	assert.doesNotMatch(html, /type="checkbox"/);
	assert.match(html, /Select 2\./);

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
	assert.match(select, /<span class="select-chip">One<\/span>/);
});

test('fixture closeModal only hides presentation and keeps pending inspector state', async () => {
	const client = new FixtureClient();
	const before = await client.connect();
	const modal = before.pending.modals[0];
	client.closeModal('alice', modal.customId);
	const after = await client.connect();
	assert.equal(after.pending.modals.length, 1);
	assert.deepEqual(after.closedModals, [modal.interactionId]);
});

test('UI clicks use a semantic locator and reject a missing visible source', async () => {
	const snapshot = await new FixtureClient().connect();
	const action = semanticAction(
		{
			kind: 'user',
			verb: 'click',
			actor: 'alice',
			customId: 'approve',
			source: { channel: 'general', messageRef: 'm1', customId: 'approve' },
		},
		snapshot,
	);
	assert.equal(action.kind, 'user');
	if (action.kind !== 'user' || action.verb !== 'click') return;
	assert.equal(action.source.messageRef, undefined);
	assert.equal(action.source.customId, 'approve');
	assert.match(action.source.contains ?? '', /Hi/);
	assert.throws(
		() =>
			semanticAction(
				{ ...action, source: { channel: 'general', messageRef: 'stale-id', customId: 'approve' } },
				snapshot,
			),
		/Visible source message stale-id is unavailable/,
	);
});

test('markdown and buttons load custom emojis from the CDN; invalid data falls back without building URLs', () => {
	const html = renderToStaticMarkup(
		createElement(Markdown, {
			text: '### 21. Age\n<a:Arrow_Green:1304880812281434212> Click **Accept** in [the guide](https://example.com/g) snake_case_name\n> quoted\n- one\n- two',
		}),
	);
	assert.match(html, /<h3 class="md-heading">21\. Age<\/h3>/);
	assert.match(
		html,
		/<img class="emoji emoji--inline" src="https:\/\/cdn\.discordapp\.com\/emojis\/1304880812281434212\.webp\?size=64&amp;animated=true" alt=":Arrow_Green:"/,
	);
	assert.doesNotMatch(html, /&lt;a:Arrow_Green/);
	assert.match(html, /<a href="https:\/\/example\.com\/g"[^>]*>the guide<\/a>/);
	assert.match(html, /snake_case_name/);
	assert.doesNotMatch(html, /<em>case<\/em>/);
	assert.match(html, /<blockquote class="md-quote">/);
	assert.match(html, /<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>/);

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
		/<img class="emoji emoji--button" src="https:\/\/cdn\.discordapp\.com\/emojis\/1349674855439532043\.webp[^"]*" alt=":MoneySoaring:"/,
	);

	// The size variant must not reuse the generic `.button` control class (padding/background).
	assert.ok(!/<img class="([^"]*)"/.exec(button)?.[1].split(' ').includes('button'));
	const invalid = renderToStaticMarkup(createElement(Emoji, { emoji: { name: 'broken', id: 'not-a-snowflake' } }));
	assert.equal(invalid, '<span class="custom-emoji-fallback" title=":broken:">:broken:</span>');
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
	const trigger = { id: 'm-verify', channelId: 'c1', visibility: 'ephemeral' as const, payload: { id: 'm-verify' } };
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
