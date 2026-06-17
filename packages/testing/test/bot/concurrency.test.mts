import { Command, type CommandContext, ComponentCommand, type ComponentContext, Declare, Modal } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { chatInputInteraction } from '../../src/bot/interactions';
import { Routes } from '../../src/bot/routes';

describe('concurrent dispatch isolation', () => {
	test('a slash and a button racing through one dedup gate are attributed to themselves', async () => {
		const claimed = new Set<string>();
		const verdict = (key: string): 'won' | 'already' => {
			if (claimed.has(key)) return 'already';
			claimed.add(key);
			return 'won';
		};

		@Declare({ name: 'claim', description: 'Claim the resource' })
		class ClaimCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: `slash:${verdict('resource')}` });
			}
		}

		class ClaimButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'claim:123';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: `button:${verdict('resource')}` });
			}
		}

		const bot = await createMockBot({ commands: [ClaimCommand], components: [ClaimButton] });
		await bot.rest.request('POST', '/channels/claim-channel/messages', {
			body: {
				content: 'claim source',
				components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'claim:123', label: 'Claim' }] }],
			},
		});
		const source = bot.actions.at(-1);
		if (!source) throw new Error('expected source message action');

		const [a, b] = await Promise.all([bot.slash({ name: 'claim' }), bot.clickButton('claim:123', { source })]);

		// (i) neither dispatch reported a spurious missing handler
		const aContent = a.messages.map(message => message.content);
		const bContent = b.messages.map(message => message.content);

		// (ii) each result is attributed to itself
		expect(aContent).toEqual([expect.stringMatching(/^slash:/)]);
		expect(bContent).toEqual([expect.stringMatching(/^button:/)]);
		expect(a.messages).toHaveLength(1);
		expect(b.messages).toHaveLength(1);

		// action sets are disjoint (no shared seq)
		const aSeqs = new Set(a.actions.map(action => action.seq));
		const shared = b.actions.filter(action => aSeqs.has(action.seq));
		expect(shared).toHaveLength(0);
		expect(a.actions.length).toBeGreaterThan(0);
		expect(b.actions.length).toBeGreaterThan(0);

		// (iii) dedup invariant: exactly one "won" and one "already" across the two results
		const verdicts = [aContent[0], bContent[0]].map(content => content?.split(':')[1]).sort();
		expect(verdicts).toEqual(['already', 'won']);

		await bot.close();
	});

	test('5 commands dispatched concurrently each own only their own message', async () => {
		const commandNames = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

		@Declare({ name: 'alpha', description: 'a' })
		class Alpha extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'reply:alpha' });
			}
		}
		@Declare({ name: 'bravo', description: 'b' })
		class Bravo extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'reply:bravo' });
			}
		}
		@Declare({ name: 'charlie', description: 'c' })
		class Charlie extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'reply:charlie' });
			}
		}
		@Declare({ name: 'delta', description: 'd' })
		class Delta extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'reply:delta' });
			}
		}
		@Declare({ name: 'echo', description: 'e' })
		class Echo extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'reply:echo' });
			}
		}

		const bot = await createMockBot({ commands: [Alpha, Bravo, Charlie, Delta, Echo] });

		const results = await Promise.all(commandNames.map(name => bot.slash({ name })));

		results.forEach((result, index) => {
			const name = commandNames[index];
			const contents = result.messages.map(message => message.content);
			expect(contents).toEqual([`reply:${name}`]);
		});

		// no cross-contamination: every dispatch's action set is disjoint from every other's
		const seqSets = results.map(result => result.actions.map(action => action.seq));
		const flat = seqSets.flat();
		expect(new Set(flat).size).toBe(flat.length);

		await bot.close();
	});

	test('until() gate resolves with the owning dispatch action, never a concurrent dispatch matching the same route', async () => {
		// A barrier the test releases AFTER dispatch B has recorded its own matching ban, so a GLOBAL gate
		// (seq >= startSeq && route matches) created by A would see B's ban first and resolve A.until() with it.
		// Dispatch-scoped gates must instead resolve A.until() with A's OWN ban.
		let releaseA!: () => void;
		const aMayBan = new Promise<void>(resolve => {
			releaseA = resolve;
		});

		@Declare({ name: 'ban-a', description: 'Bans user 111 after the barrier opens' })
		class BanA extends Command {
			async run(ctx: CommandContext) {
				await aMayBan;
				await ctx.client.members.ban('guild-a', '111');
				await ctx.write({ content: 'a-done' });
			}
		}

		@Declare({ name: 'ban-b', description: 'Bans user 222 immediately' })
		class BanB extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.ban('guild-b', '222');
				await ctx.write({ content: 'b-done' });
			}
		}

		const bot = await createMockBot({ commands: [BanA, BanB], onUnhandledRest: 'silent' });

		const dispatchA = bot.slash({ name: 'ban-a' });
		// Arm A's gate BEFORE B runs: startSeq is captured now, while A is parked on the barrier.
		const aGate = dispatchA.until(Routes.ban);

		// Run B to completion: its ban (userId 222) records with seq >= A's startSeq. A global gate would grab it.
		const resultB = await bot.slash({ name: 'ban-b' });
		expect(resultB.content).toBe('b-done');
		const bBan = bot.findAction(Routes.ban, { userId: '222' });
		expect(bBan).toBeDefined();
		// A's gate is still parked: B's ban did NOT resolve it (A hasn't banned yet).
		expect(bBan?.dispatchId).not.toBe(dispatchA.dispatchId);

		// Now let A ban. Its gate must resolve with A's OWN ban (userId 111), not B's already-recorded 222.
		releaseA();
		const hit = await aGate;

		// The gate resolved with A's dispatch and A's own ban action (userId 111), not B's (222).
		expect(hit.dispatchId).toBe(dispatchA.dispatchId);
		const aBan = bot.findAction(Routes.ban, { userId: '111' });
		expect(aBan).toBeDefined();
		expect(hit.seq).toBe(aBan?.seq);

		const resultA = await dispatchA;
		expect(resultA.content).toBe('a-done');

		await bot.close();
	});

	test('source-less component dispatch fails while an implicit source owner is still running', async () => {
		let release!: () => void;
		const hold = new Promise<void>(resolve => {
			release = resolve;
		});

		@Declare({ name: 'hold-source', description: 'Sends a component and keeps running' })
		class HoldSourceCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({
					content: 'source',
					components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'claim:123', label: 'Claim' }] }],
				});
				await hold;
			}
		}

		class ClaimButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'claim:123';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'clicked' });
			}
		}

		const bot = await createMockBot({ commands: [HoldSourceCommand], components: [ClaimButton] });
		const active = bot.slash({ name: 'hold-source' });
		await active.until(Routes.interactionCallback);

		expect(() => bot.clickButton('claim:123')).toThrow(/source-less component dispatch.+ambiguous/);
		release();
		await active;
		await bot.close();
	});

	test('an out-of-band action whose route only contains the token as a substring is not attributed', async () => {
		@Declare({ name: 'tokenleak', description: 'Replies; another interaction owns the near-miss action' })
		class TokenLeakCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'reply:tokenleak' });
			}
		}

		const bot = await createMockBot({ commands: [TokenLeakCommand] });

		// Craft a payload with a known token, then record (OUTSIDE any dispatch, so dispatchId 0) a webhook-message
		// action whose token segment is `${token}X` — i.e. the dispatch's token is a SUBSTRING of a longer segment.
		// Substring matching would mis-attribute it; segment-exact matching must not.
		const payload = chatInputInteraction({ name: 'tokenleak' });
		payload.token = 'slipher-mock-interaction-token-attribution-probe';
		// The probe token is never acknowledged, so the edit now 404s (real Discord behavior); the action is still
		// recorded before the rejection, which is what the substring-attribution assertions below check.
		await bot.rest.request('PATCH', `/webhooks/app/${payload.token}X/messages/@original`).catch(() => {});

		const result = await bot.dispatchInteraction(payload);

		expect(result.actions.some(action => action.route.includes(`${payload.token}X`))).toBe(false);
		expect(result.edits).toHaveLength(0);
		expect(result.messages.map(message => message.content)).toEqual(['reply:tokenleak']);

		await bot.close();
	});

	test('explicit RecordedAction source without a message id fails instead of falling back globally', async () => {
		class ClaimButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'claim:source';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'clicked' });
			}
		}

		const bot = await createMockBot({ components: [ClaimButton] });
		await bot.rest.request('POST', '/interactions/no-message/no-message-token/callback', { body: { type: 6 } });
		const action = bot.actions.at(-1)!;

		expect(() => bot.clickButton('claim:source', { source: action })).toThrow(/has no message id/);
		await bot.close();
	});

	test('source-less ComponentCommand dispatch fails loud while a sibling dispatch is unresolved', async () => {
		let release!: () => void;
		const barrier = new Promise<void>(resolve => {
			release = resolve;
		});

		@Declare({ name: 'park', description: 'Parks until released' })
		class Park extends Command {
			async run(ctx: CommandContext) {
				await barrier;
				await ctx.write({ content: 'done' });
			}
		}

		class ClaimButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'claim:fresh';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'clicked' });
			}
		}

		const bot = await createMockBot({ commands: [Park], components: [ClaimButton] });
		const parked = bot.slash({ name: 'park' });
		void parked.until(action => action.route.includes('/never-release')).catch(() => {});

		expect(() => bot.clickButton('claim:fresh')).toThrow(/source-less component dispatch.+ambiguous/s);
		release();
		await parked;
		await bot.close();
	});

	test('concurrent waitFor modals from the same user fail loud instead of sharing the registry key', async () => {
		class ModalButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId.startsWith('modal:');
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.interaction.modal(new Modal().setCustomId(ctx.customId).setTitle(ctx.customId).setComponents([]), {
					waitFor: 30_000,
				});
			}
		}

		const bot = await createMockBot({ components: [ModalButton] });
		await bot.rest.request('POST', '/channels/same-modal-channel/messages', {
			body: {
				content: 'modal source',
				components: [
					{
						type: 1,
						components: [
							{ type: 2, style: 1, custom_id: 'modal:first', label: 'First' },
							{ type: 2, style: 1, custom_id: 'modal:second', label: 'Second' },
						],
					},
				],
			},
		});
		const source = bot.actions.at(-1);
		if (!source) throw new Error('expected source message action');
		const user = {
			id: 'same-modal-user',
			username: 'same-modal-user',
			global_name: null,
			discriminator: '0',
			avatar: null,
			bot: false,
		};
		const first = bot.clickButton('modal:first', { user });
		await first.untilModal();

		const second = bot.clickButton('modal:second', { user, source });
		await expect(second.untilModal()).rejects.toThrow(/already has a pending modal owned by dispatch/);
		await first.timeoutModal();
		await bot.close();
	});
});
