import {
	Command,
	type CommandContext,
	createAttachmentOption,
	createIntegerOption,
	createMentionableOption,
	createNumberOption,
	Declare,
	EntryPointCommand,
	Label,
	Modal,
	Options,
	TextInput,
} from 'seyfert';
import { EntryPointCommandHandlerType, TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_USER_ID } from '../../src/bot/constants';
import { attachmentOption, chatInputInteraction, mentionableOption } from '../../src/bot/interactions';
import { apiAttachment, apiUser } from '../../src/bot/payloads';
import { Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('additional command surfaces', () => {
	const attachmentOptions = {
		file: createAttachmentOption({ description: 'Evidence', required: true }),
	};
	const mentionableOptions = {
		target: createMentionableOption({ description: 'Target', required: true }),
	};

	@Declare({ name: 'attachment-check', description: 'Checks attachment option' })
	@Options(attachmentOptions)
	class AttachmentCheckCommand extends Command {
		async run(ctx: CommandContext<typeof attachmentOptions>) {
			await ctx.write({ content: ctx.options.file.filename });
		}
	}

	@Declare({ name: 'mentionable-check', description: 'Checks mentionable option' })
	@Options(mentionableOptions)
	class MentionableCheckCommand extends Command {
		async run(ctx: CommandContext<typeof mentionableOptions>) {
			const target = ctx.options.target;
			await ctx.write({ content: 'username' in target ? `user:${target.id}` : `role:${target.id}` });
		}
	}

	class LaunchEntryPoint extends EntryPointCommand {
		name = 'launch';
		description = 'Launches';
		handler = EntryPointCommandHandlerType.AppHandler;

		async run(ctx: Parameters<NonNullable<EntryPointCommand['run']>>[0]) {
			await ctx.write({ content: 'launched' });
		}
	}

	@Declare({ name: 'identity-check', description: 'Checks stable identity' })
	class IdentityCheckCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: ctx.author.id });
		}
	}

	@Declare({ name: 'ephemeral-check', description: 'Checks ephemeral replies' })
	class EphemeralCheckCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'secret', flags: 64 });
		}
	}

	@Declare({ name: 'open-modal-check', description: 'Opens a modal' })
	class OpenModalCheckCommand extends Command {
		async run(ctx: CommandContext) {
			const modal = new Modal()
				.setCustomId('slash-modal')
				.setTitle('Slash Modal')
				.setComponents([
					new Label()
						.setLabel('Rating')
						.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
				]);
			await ctx.interaction.modal(modal);
		}
	}

	@Declare({ name: 'clone-ban', description: 'Bans in cloned world' })
	class CloneBanCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.members.ban(ctx.guildId ?? '', 'clone-target');
			await ctx.write({ content: 'banned' });
		}
	}

	@Declare({ name: 'route-fetch-guild', description: 'Fetches guild through descriptor route' })
	class RouteFetchGuildCommand extends Command {
		async run(ctx: CommandContext) {
			const guild = await ctx.client.guilds.raw(ctx.guildId ?? '9');
			await ctx.write({ content: guild.name });
		}
	}

	@Declare({ name: 'route-message-write', description: 'Writes a side message' })
	class RouteMessageWriteCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.messages.write('route-channel', { content: 'side' });
			await ctx.write({ content: 'done' });
		}
	}

	const numericOptions = {
		count: createIntegerOption({ description: 'Whole count', required: true, min_value: 1, max_value: 10 }),
		ratio: createNumberOption({ description: 'Decimal ratio', required: true }),
	};
	const numericPayloads: unknown[] = [];

	@Declare({ name: 'numeric-check', description: 'Checks numeric option encoding' })
	@Options(numericOptions)
	class NumericCheckCommand extends Command {
		async run(ctx: CommandContext<typeof numericOptions>) {
			numericPayloads.push(ctx.interaction.data.options);
			await ctx.write({ content: `${ctx.options.count}:${ctx.options.ratio}` });
		}
	}

	test('attachment options resolve through the real option resolver', async () => {
		const bot = await createMockBot({ commands: [AttachmentCheckCommand] });
		const result = await bot.slash({
			name: 'attachment-check',
			options: { file: attachmentOption(apiAttachment({ filename: 'evidence.png' })) },
		});
		expect(result.content).toBe('evidence.png');
		await bot.close();
	});

	test('mentionable options resolve users and roles', async () => {
		const user = apiUser({ id: 'mention-user' });
		const role = { id: 'mention-role', name: 'mod' };
		const bot = await createMockBot({ commands: [MentionableCheckCommand] });

		await expect(
			bot.slash({ name: 'mentionable-check', options: { target: mentionableOption(user) } }),
		).resolves.toMatchObject({ content: `user:${user.id}` });
		await expect(
			bot.slash({ name: 'mentionable-check', options: { target: mentionableOption(role) } }),
		).resolves.toMatchObject({ content: `role:${role.id}` });
		await bot.close();
	});

	test('interaction payloads carry context and integration owners', () => {
		const payload = chatInputInteraction({
			name: 'context-check',
			context: 1,
			guildLocale: 'es-ES',
			integrationOwners: { '1': 'owner-user' },
		});

		expect(payload.context).toBe(1);
		expect(payload.guild_locale).toBe('es-ES');
		expect(payload.authorizing_integration_owners).toEqual({ '1': 'owner-user' });
	});

	test('entry point commands dispatch and capture replies', async () => {
		const bot = await createMockBot({ commands: [LaunchEntryPoint] });
		const result = await bot.entryPoint();

		expect(result.content).toBe('launched');
		await bot.close();
	});

	test('onUnhandledRest modes warn once, throw, or stay silent', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const noisy = await createMockBot();
		await noisy.rest.request('GET', '/applications/missing');
		await noisy.rest.request('GET', '/applications/missing');
		expect(warn).toHaveBeenCalledTimes(1);
		await noisy.close();

		const strict = await createMockBot({ onUnhandledRest: 'error' });
		await expect(strict.rest.request('GET', '/applications/missing')).rejects.toThrow(/no interceptor or world entity/);
		await strict.close();

		warn.mockClear();
		const silent = await createMockBot({ onUnhandledRest: 'silent' });
		await silent.rest.request('GET', '/applications/missing');
		expect(warn).not.toHaveBeenCalled();
		await silent.close();
		warn.mockRestore();
	});

	test('message PATCH fallbacks reuse route ids', async () => {
		const bot = await createMockBot();
		const response = await bot.rest.request<{ id: string; channel_id: string }>('PATCH', '/channels/789/messages/456', {
			body: { content: 'edited' },
		});

		expect(response).toMatchObject({ id: '456', channel_id: '789', content: 'edited' });
		await bot.close();
	});

	test('bare dispatches reuse the stable default user id', async () => {
		const bot = await createMockBot({ commands: [IdentityCheckCommand] });
		const first = await bot.slash({ name: 'identity-check' });
		const second = await bot.slash({ name: 'identity-check' });

		expect(first.content).toBe(TEST_USER_ID);
		expect(second.content).toBe(TEST_USER_ID);
		await bot.close();
	});

	test('ephemeral and modal getters expose semantic reply state', async () => {
		const bot = await createMockBot({ commands: [EphemeralCheckCommand, OpenModalCheckCommand] });
		const ephemeral = await bot.slash({ name: 'ephemeral-check' });
		const modal = await bot.slash({ name: 'open-modal-check' });

		expect(ephemeral.ephemeral).toBe(true);
		expect(ephemeral.reply?.body).toMatchObject({ data: { flags: 64 } });
		expect(modal.modal).toEqual({ customId: 'slash-modal', title: 'Slash Modal' });
		await bot.close();
	});

	test('world mutations do not leak back to the original builder', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'clone-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'clone-actor' }) });
		world.registerMember(guild.id, { user: apiUser({ id: 'clone-target' }) });
		const channel = world.registerChannel(guild.id);

		const bot = await createMockBot({ commands: [CloneBanCommand], world });
		await bot.slash({ name: 'clone-ban', guildId: guild.id, channel, user: actor.user });

		expect(bot.cachedGuild(guild.id)?.member('clone-target')).toBeUndefined();
		expect(world.build().members.some(entry => entry.member.user.id === 'clone-target')).toBe(true);
		await bot.close();
	});

	test('route descriptors intercept and query REST calls without raw endpoints', async () => {
		const bot = await createMockBot({ commands: [RouteFetchGuildCommand] });
		bot.rest.intercept(Routes.fetchGuild, () => ({ id: '9', name: 'Stubbed' }));

		const result = await bot.slash({ name: 'route-fetch-guild', guildId: '9' });
		expect(result.content).toBe('Stubbed');
		expect(bot.findCall(Routes.fetchGuild)?.params).toMatchObject({ guildId: '9' });
		await bot.close();
	});

	test('waitForAction accepts route descriptors for side effects', async () => {
		const bot = await createMockBot({ commands: [RouteMessageWriteCommand] });
		await bot.slash({ name: 'route-message-write' });

		await expect(bot.waitForAction(Routes.createMessage)).resolves.toMatchObject({
			body: { content: 'side' },
			params: { channelId: 'route-channel' },
		});
		await bot.close();
	});

	test('slash accepts array-form option inputs and preserves declared number option types', async () => {
		numericPayloads.length = 0;
		const bot = await createMockBot({ commands: [NumericCheckCommand] });
		const result = await bot.slash({
			name: 'numeric-check',
			options: [
				{ name: 'ratio', value: 1 },
				{ name: 'count', value: 2 },
			],
		});

		expect(result.content).toBe('2:1');
		expect(numericPayloads[0]).toEqual([
			{ name: 'ratio', type: 10, value: 1 },
			{ name: 'count', type: 4, value: 2 },
		]);
		await bot.close();
	});

	test('slash can validate options before dispatching to Seyfert', async () => {
		const bot = await createMockBot({ commands: [NumericCheckCommand], validateOptions: true });

		expect(() => bot.slash({ name: 'numeric-check', options: { count: 11, ratio: 1 } })).toThrow(
			/count.*greater than 10/i,
		);
		await bot.close();
	});

	test('slash throws for an unregistered subcommand target', async () => {
		const bot = await createMockBot({ commands: [NumericCheckCommand] });

		expect(() => bot.slash({ name: 'numeric-check', subcommand: 'missing', options: { count: 2, ratio: 1 } })).toThrow(
			/subcommand "missing" is not registered/i,
		);
		await bot.close();
	});
});
