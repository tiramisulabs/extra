import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiMessage } from '../../src/bot/payloads';

const DISCORD_EPOCH = 1420070400000n;

function snowflakeCreatedAt(id: string): Date {
	return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

describe('timestamped snowflake ids', () => {
	test('a replied message id decodes to a modern createdAt and a non-epoch timestamp', async () => {
		let id: string | undefined;

		@Declare({ name: 'stamp', description: 'Reply' })
		class StampCommand extends Command {
			async run(ctx: CommandContext) {
				const message = await ctx.editOrReply({ content: 'hi' }, true);
				id = message.id;
			}
		}

		const bot = await createMockBot({ commands: [StampCommand] });
		await bot.slash({ name: 'stamp' });
		await bot.close();

		expect(typeof id).toBe('string');
		const createdAt = snowflakeCreatedAt(id as string);
		expect(createdAt.getUTCFullYear()).toBeGreaterThanOrEqual(2020);
		expect(createdAt.getTime()).toBeGreaterThan(0);
	});

	test('apiMessage/apiMember timestamps are deterministic and not epoch', () => {
		const message = apiMessage();
		const member = apiMember();

		expect(message.timestamp).not.toBe(new Date(0).toISOString());
		expect(new Date(message.timestamp).getUTCFullYear()).toBeGreaterThanOrEqual(2020);
		expect(member.joined_at).not.toBe(new Date(0).toISOString());
		expect(new Date(member.joined_at).getUTCFullYear()).toBeGreaterThanOrEqual(2020);
	});

	test('consecutive mock ids strictly increase and decode in order', async () => {
		const bot = await createMockBot();
		await bot.close();

		const a = apiMessage().id;
		const b = apiMessage().id;
		expect(BigInt(b)).toBeGreaterThan(BigInt(a));
		expect(snowflakeCreatedAt(b).getTime()).toBeGreaterThanOrEqual(snowflakeCreatedAt(a).getTime());
	});
});
