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
import { createMockBot, OutcomeError, outcome, rendered } from '../../src';
import { GreetCommand, SearchCommand, testMiddlewares } from './_setup';

@Declare({ name: 'outcome-silent', description: 'Returns without replying' })
class SilentCommand extends Command {
	async run(_ctx: CommandContext) {}
}

@Declare({ name: 'outcome-boom', description: 'Throws an unhandled error' })
class BoomCommand extends Command {
	async run(_ctx: CommandContext) {
		throw new Error('kaboom');
	}
}

@Declare({ name: 'outcome-twice', description: 'Writes twice' })
class WritesTwice extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'first' });
		await ctx.write({ content: 'second' });
	}
}

@Declare({ name: 'outcome-blocked', description: 'Denied by middleware' })
@Middlewares(['blocker'])
class BlockedCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'never' });
	}
}

@Declare({
	name: 'outcome-needs-ban',
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

@Declare({ name: 'outcome-defer-only', description: 'Defers without visible output' })
class DeferOnlyCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.deferReply();
	}
}

@Declare({ name: 'outcome-slow', description: 'Defers, edits, and follows up' })
class SlowOutcomeCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.deferReply();
		await ctx.editOrReply({ content: 'done' });
		await ctx.followup({ content: 'extra' });
	}
}

@Declare({ name: 'outcome-modal', description: 'Opens a modal' })
class ModalOnlyCommand extends Command {
	async run(ctx: CommandContext) {
		const modal = new Modal()
			.setCustomId('outcome-modal-form')
			.setTitle('Outcome Modal')
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
		return ctx.customId === 'outcome-ack';
	}
	async run(ctx: ComponentContext<'Button'>) {
		await ctx.deferUpdate();
	}
}

describe('outcome reader', () => {
	test('get.response reads an immediate reply and modes keep concrete types', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'x' } });
		const state = outcome(result);

		const response = state.get.response({ kind: 'reply' });
		expect(response.kind).toBe('response');
		expect(response.events.map(event => event.kind)).toEqual(['reply']);
		expect(response.raw.replies).toHaveLength(1);
		expect(state.raw.result()).toBe(result);
		expect(state.query.response({ ephemeral: false })?.deferred).toBe(false);
		expect(state.query.error()).toBeUndefined();
		expect(state.all.response({ kind: 'reply' })).toEqual([response]);
		expect(state.all.denial()).toEqual([]);
		await bot.close();
	});

	test('get.response throws OutcomeError when no response exists', async () => {
		const bot = await createMockBot({ commands: [SilentCommand] });
		const result = await bot.slash({ name: 'outcome-silent' });
		const state = outcome(result);

		expect(state.query.response()).toBeUndefined();
		expect(state.all.response()).toEqual([]);
		expect(() => state.get.response()).toThrow(OutcomeError);
		expect(() => state.get.response()).toThrow(/found 0 responses/);
		await bot.close();
	});

	test('response({ kind: "deferReply" }) passes for defer-only output without rendered messages', async () => {
		const bot = await createMockBot({ commands: [DeferOnlyCommand] });
		const result = await bot.slash({ name: 'outcome-defer-only' });

		const response = outcome(result).get.response({ kind: 'deferReply' });
		expect(response.deferred).toBe(true);
		expect(response.deferredReply).toBe(true);
		expect(
			outcome(result)
				.get.response({ kind: 'defer' })
				.events.map(event => event.kind),
		).toEqual(['deferReply']);
		expect(rendered(result).all.message()).toHaveLength(0);
		await bot.close();
	});

	test('response reads edit and followup events after a defer', async () => {
		const bot = await createMockBot({ commands: [SlowOutcomeCommand] });
		const result = await bot.slash({ name: 'outcome-slow' });
		const state = outcome(result);

		expect(state.get.response({ kind: 'edit' }).events.map(event => event.kind)).toEqual([
			'deferReply',
			'edit',
			'followup',
		]);
		expect(state.get.response({ kind: 'followup' }).raw.followups).toMatchObject([{ content: 'extra' }]);
		rendered(result).get.message({ content: 'done' });
		rendered(result).get.message({ content: 'extra' });
		await bot.close();
	});

	test('response({ kind: "deferUpdate" }) passes for component defer update', async () => {
		const bot = await createMockBot({ components: [DeferUpdateButton] });
		const result = await bot.dispatch.clickButton('outcome-ack', { allowSyntheticSource: true });

		const response = outcome(result).get.response({ kind: 'deferUpdate' });
		expect(response.deferred).toBe(true);
		expect(response.deferredUpdate).toBe(true);
		await bot.close();
	});

	test('response({ kind: "modal" }) passes for modal-only callbacks', async () => {
		const bot = await createMockBot({ commands: [ModalOnlyCommand] });
		const result = await bot.slash({ name: 'outcome-modal' });

		const response = outcome(result).get.response({ kind: 'modal' });
		expect(response.modal).toMatchObject({ customId: 'outcome-modal-form', title: 'Outcome Modal' });
		rendered(result).get.modal('outcome-modal-form');
		await bot.close();
	});

	test('response({ kind: "autocomplete" }) passes for autocomplete dispatches', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });
		const result = await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });

		expect(
			outcome(result)
				.get.response({ kind: 'autocomplete' })
				.events.map(event => event.kind),
		).toEqual(['autocomplete']);
		expect(result.choices).toEqual([{ name: 'result:sey', value: 'sey' }]);
		await bot.close();
	});

	test('denial matches kind, middleware, and missing permissions', async () => {
		const middlewareBot = await createMockBot({ commands: [BlockedCommand], middlewares: testMiddlewares });
		const blocked = await middlewareBot.slash({ name: 'outcome-blocked' });
		expect(outcome(blocked).get.denial({ kind: 'stop', middleware: 'blocker' }).denialKind).toBe('stop');
		expect(() => outcome(blocked).get.denial({ kind: 'permissions' })).toThrow(OutcomeError);
		await middlewareBot.close();

		const permissionBot = await createMockBot({ commands: [NeedsBanCommand] });
		const denied = await permissionBot.slash({ name: 'outcome-needs-ban', memberPermissions: [] });
		expect(outcome(denied).get.denial({ kind: 'permissions', missing: 'BanMembers' }).missing).toEqual(['BanMembers']);
		outcome(denied).get.denial({ kind: 'permissions', missing: ['BanMembers'] as const });
		outcome(denied).get.response({ kind: 'reply' });
		rendered(denied).get.message({ content: /missing member perms/ });
		await permissionBot.close();
	});

	test('error matches captured unhandled errors and default throw rejects before outcome exists', async () => {
		const captureBot = await createMockBot({ commands: [WritesTwice], onCommandError: 'capture' });
		const captured = await captureBot.slash({ name: 'outcome-twice' });

		outcome(captured).get.response({ kind: 'reply' });
		expect(outcome(captured).get.error(/already replied/i).error).toBeInstanceOf(Error);
		expect(outcome(captured).get.error({ match: error => error instanceof Error }).kind).toBe('error');
		expect(() => outcome(captured).get.error('nope')).toThrow(OutcomeError);
		rendered(captured).get.message({ content: 'first' });
		await captureBot.close();

		const throwBot = await createMockBot({ commands: [BoomCommand] });
		await expect(throwBot.slash({ name: 'outcome-boom' })).rejects.toThrow(/kaboom/);
		await throwBot.close();
	});

	test('unknown query keys throw directed OutcomeErrors', async () => {
		const bot = await createMockBot({ commands: [GreetCommand, BoomCommand], onCommandError: 'capture' });
		const replied = await bot.slash({ name: 'greet', options: { name: 'x' } });
		const errored = await bot.slash({ name: 'outcome-boom' });

		expect(() => outcome(replied).get.response({ deferredReply: true } as never)).toThrow(OutcomeError);
		expect(() => outcome(replied).get.response({ deferredReply: true } as never)).toThrow(
			/unknown query key "deferredReply"/,
		);
		expect(() => outcome(replied).get.denial({ permission: 'BanMembers' } as never)).toThrow(
			/unknown query key "permission"/,
		);
		expect(() => outcome(errored).get.error({ message: /timeout/i } as never)).toThrow(/unknown query key "message"/);
		await bot.close();
	});
});
