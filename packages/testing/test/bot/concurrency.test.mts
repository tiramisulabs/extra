import { Command, type CommandContext, ComponentCommand, type ComponentContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

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

		const [a, b] = await Promise.all([bot.slash({ name: 'claim' }), bot.clickButton('claim:123')]);

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
});
