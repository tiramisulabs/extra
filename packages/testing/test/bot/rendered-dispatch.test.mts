import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
	Label,
	Middlewares,
	Modal,
	TextInput,
} from 'seyfert';
import { TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot, RenderedOutputError, rendered } from '../../src';
import { GreetCommand, SearchCommand, testMiddlewares } from './_setup';

@Declare({ name: 'dispatch-boom', description: 'Throws an unhandled error' })
class BoomCommand extends Command {
	async run(_ctx: CommandContext) {
		throw new Error('kaboom');
	}
}

@Declare({ name: 'dispatch-twice', description: 'Writes twice' })
class WritesTwice extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'first' });
		await ctx.write({ content: 'second' });
	}
}

@Declare({ name: 'dispatch-blocked', description: 'Denied by middleware, renders nothing' })
@Middlewares(['blocker'])
class BlockedCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'never' });
	}
}

@Declare({
	name: 'dispatch-needs-ban',
	description: 'Needs member ban permission',
	defaultMemberPermissions: ['BanMembers'],
})
class NeedsBanCommand extends Command {
	async onPermissionsFail(ctx: CommandContext) {
		await ctx.editOrReply({ content: 'missing member perms' });
	}
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'member ok' });
	}
}

@Declare({ name: 'dispatch-defer-only', description: 'Defers without visible output' })
class DeferOnlyCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.deferReply();
	}
}

@Declare({ name: 'dispatch-slow', description: 'Defers, edits, and follows up' })
class SlowDispatchCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.deferReply();
		await ctx.editOrReply({ content: 'done' });
		await ctx.followup({ content: 'extra' });
	}
}

@Declare({ name: 'dispatch-modal', description: 'Opens a modal' })
class ModalOnlyCommand extends Command {
	async run(ctx: CommandContext) {
		const modal = new Modal()
			.setCustomId('dispatch-modal-form')
			.setTitle('Dispatch Modal')
			.setComponents([
				new Label()
					.setLabel('Reason')
					.setComponent(new TextInput({ custom_id: 'reason', style: TextInputStyle.Short })),
			]);
		await ctx.interaction.modal(modal);
	}
}

class DeferUpdateButton extends ComponentCommand {
	componentType = 'Button' as const;
	filter(ctx: ComponentContext<'Button'>) {
		return ctx.customId === 'dispatch-ack';
	}
	async run(ctx: ComponentContext<'Button'>) {
		await ctx.deferUpdate();
	}
}

describe('dispatch reads on the rendered reader', () => {
	test('a dispatch that reached the handler has no denial and no captured error', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'x' } });
		const ui = rendered(result);

		expect(ui.query.denial()).toBeUndefined();
		expect(ui.all.denial()).toEqual([]);
		expect(ui.query.error()).toBeUndefined();
		expect(ui.all.error()).toEqual([]);
		expect(() => ui.get.denial()).toThrow(RenderedOutputError);
		expect(() => ui.get.error()).toThrow(RenderedOutputError);
		expect(ui.get.message().content).toBe('Hello, x!');
		await bot.close();
	});

	test('denial matches kind, middleware, and missing permissions', async () => {
		const middlewareBot = await createMockBot({ commands: [BlockedCommand], middlewares: testMiddlewares });
		const blocked = await middlewareBot.slash({ name: 'dispatch-blocked' });

		const denial = rendered(blocked).get.denial({ kind: 'stop', middleware: 'blocker' });
		expect(denial.kind).toBe('denial');
		expect(denial.denialKind).toBe('stop');
		expect(denial.raw).toBe(blocked.denial);
		expect(rendered(blocked).all.denial()).toHaveLength(1);
		expect(rendered(blocked).query.denial({ kind: 'permissions' })).toBeUndefined();
		expect(() => rendered(blocked).get.denial({ kind: 'permissions' })).toThrow(RenderedOutputError);
		await middlewareBot.close();

		const permissionBot = await createMockBot({ commands: [NeedsBanCommand] });
		const denied = await permissionBot.slash({ name: 'dispatch-needs-ban', memberPermissions: [] });

		expect(rendered(denied).get.denial({ kind: 'permissions', missing: 'BanMembers' }).missing).toEqual(['BanMembers']);
		rendered(denied).get.denial({ kind: 'permissions', missing: ['BanMembers'] as const });
		expect(() => rendered(denied).get.denial({ missing: 'ManageGuild' })).toThrow(RenderedOutputError);
		// The guard replied, so the denial and the rendered output are both readable from the one reader.
		rendered(denied).get.message({ content: /missing member perms/ });
		await permissionBot.close();
	});

	test('error matches captured unhandled errors, and the default throw rejects before a result exists', async () => {
		const captureBot = await createMockBot({ commands: [WritesTwice], onCommandError: 'capture' });
		const captured = await captureBot.slash({ name: 'dispatch-twice' });

		expect(rendered(captured).get.error().error).toBe(captured.error);
		expect(rendered(captured).get.error(/already replied/i).error).toBeInstanceOf(Error);
		expect(rendered(captured).get.error({ match: error => error instanceof Error }).kind).toBe('error');
		expect(rendered(captured).query.error('nope')).toBeUndefined();
		expect(rendered(captured).all.error('nope')).toEqual([]);
		expect(() => rendered(captured).get.error('nope')).toThrow(RenderedOutputError);
		rendered(captured).get.message({ content: 'first' });
		await captureBot.close();

		const throwBot = await createMockBot({ commands: [BoomCommand] });
		await expect(throwBot.slash({ name: 'dispatch-boom' })).rejects.toThrow(/kaboom/);
		await throwBot.close();
	});

	test('unknown query keys are rejected before the read', async () => {
		const bot = await createMockBot({ commands: [GreetCommand, BoomCommand], onCommandError: 'capture' });
		const replied = await bot.slash({ name: 'greet', options: { name: 'x' } });
		const errored = await bot.slash({ name: 'dispatch-boom' });

		expect(() => rendered(replied).get.denial({ permission: 'BanMembers' } as never)).toThrow(TypeError);
		expect(() => rendered(replied).get.denial({ permission: 'BanMembers' } as never)).toThrow(/unknown query key/);
		expect(() => rendered(errored).get.error({ message: /timeout/i } as never)).toThrow(TypeError);
		await bot.close();
	});

	test('a subject that cannot be denied says so instead of matching nothing', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		await bot.slash({ name: 'greet', options: { name: 'x' } });
		const flow = bot.actor({ session: false }).slash({ name: 'greet', options: { name: 'y' } });

		// `all`/`query` would otherwise answer "none" for a subject that can never have one — the vacuous green
		// this reader exists to remove — so the subject mistake fails on every mode, like a bad subject does.
		for (const subject of [bot, flow, { content: 'hello' }]) {
			expect(() => rendered(subject).get.denial()).toThrow(TypeError);
			expect(() => rendered(subject).query.denial()).toThrow(TypeError);
			expect(() => rendered(subject).all.denial()).toThrow(TypeError);
			expect(() => rendered(subject).all.error()).toThrow(TypeError);
		}
		expect(() => rendered(bot).get.denial()).toThrow(/only a DispatchResult/);
		rendered(bot).get.message({ content: 'Hello, x!' });

		await flow;
		await bot.close();
	});

	test('a miss on a denied dispatch names the denial read that passes', async () => {
		const bot = await createMockBot({ commands: [BlockedCommand], middlewares: testMiddlewares });
		const blocked = await bot.slash({ name: 'dispatch-blocked' });

		expect(rendered(blocked).all.message()).toHaveLength(0);
		expect(() => rendered(blocked).get.message()).toThrow(/get\.denial\(\{ kind: "stop" \}\)/);
		expect(rendered(blocked).debug()).toMatch(/denied stop middleware=blocker/);
		await bot.close();
	});

	test('a missing error names the option that captures one', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'x' } });

		expect(() => rendered(result).get.error()).toThrow(/onCommandError/);
		await bot.close();
	});

	test('debug() reports the captured error next to the rendered output', async () => {
		const bot = await createMockBot({ commands: [WritesTwice], onCommandError: 'capture' });
		const captured = await bot.slash({ name: 'dispatch-twice' });

		const dump = rendered(captured).debug();
		expect(dump).toMatch(/^Rendered output:/);
		expect(dump).toMatch(/\n {2}error \w+: /);
		await bot.close();
	});

	// The reader has no `response` kind: every event one would have aggregated is either a rendered message or
	// modal, or a non-optional `DispatchResult` field that cannot satisfy an assertion vacuously. These pin
	// where each of them is read instead.
	test('a defer-only dispatch renders nothing and reports the defer on the result', async () => {
		const bot = await createMockBot({ commands: [DeferOnlyCommand] });
		const result = await bot.slash({ name: 'dispatch-defer-only' });

		expect(rendered(result).all.message()).toHaveLength(0);
		expect(result.deferred).toBe(true);
		expect(result.deferredReply).toBe(true);
		expect(result.deferredUpdate).toBe(false);
		await bot.close();
	});

	test('a component deferUpdate reports the update defer on the result', async () => {
		const bot = await createMockBot({ components: [DeferUpdateButton] });
		const result = await bot.clickButton('dispatch-ack', { allowSyntheticSource: true });

		expect(result.deferred).toBe(true);
		expect(result.deferredUpdate).toBe(true);
		expect(result.deferredReply).toBe(false);
		await bot.close();
	});

	test('a modal-only dispatch is read as a rendered modal', async () => {
		const bot = await createMockBot({ commands: [ModalOnlyCommand] });
		const result = await bot.slash({ name: 'dispatch-modal' });

		expect(rendered(result).get.modal('dispatch-modal-form').title).toBe('Dispatch Modal');
		expect(result.modal).toMatchObject({ customId: 'dispatch-modal-form', title: 'Dispatch Modal' });
		await bot.close();
	});

	test('an autocomplete dispatch is read from choices and still carries a denial slot', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });
		const result = await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });

		expect(result.choices).toEqual([{ name: 'result:sey', value: 'sey' }]);
		expect(rendered(result).query.denial()).toBeUndefined();
		await bot.close();
	});

	test('edits and followups after a defer are rendered messages', async () => {
		const bot = await createMockBot({ commands: [SlowDispatchCommand] });
		const result = await bot.slash({ name: 'dispatch-slow' });

		rendered(result).get.message({ content: 'done' });
		rendered(result).get.message({ content: 'extra' });
		expect(result.deferredReply).toBe(true);
		await bot.close();
	});
});
