import {
	type Actor,
	type ApiChannel,
	apiUser,
	type ChatInputInteractionOptions,
	createMockBot,
	type DispatchResult,
	type MockBot,
	type MockBotEvent,
	mockWorld,
	type PendingModal,
	type VisibleMessage,
	type WorldBuilder,
} from '@slipher/testing';
import type {
	ActionOutcome,
	Checkpoint,
	Expectation,
	InspectorSnapshot,
	JsonValue,
	LabAction,
	Locator,
	Params,
	Preset,
	Project,
	Ref,
	Scenario,
	ScenarioContext,
	ScenarioWorld,
	Session,
	SessionDescription,
	SessionEvent,
	SessionLog,
	VisibleConversation,
} from '../index';
import { PROTOCOL_VERSION, validateCheckpoint, validateLabAction } from '../protocol';

export { createCheckpoint, exportTest } from './checkpoint';

import { createCheckpoint } from './checkpoint';

const LAB_VERSION: string = require('../../package.json').version;

const json = (value: unknown): JsonValue =>
	JSON.parse(
		JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)),
	) as JsonValue;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const normalizedOptions = (value: unknown): string => {
	if (value === undefined || value === null) return '{}';
	if (Array.isArray(value)) {
		if (value.length === 0) return '{}';
		if (value.every(item => item && typeof item === 'object' && 'name' in item && 'value' in item))
			return normalizedOptions(Object.fromEntries(value.map(item => [item.name, item.value])));
		return JSON.stringify(value.map(normalizedOptions));
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		if ('__slipherOption' in value && 'value' in value) return normalizedOptions(value.value);
		return JSON.stringify(
			Object.fromEntries(
				entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalizedOptions(item)]),
			),
		);
	}
	return JSON.stringify(value ?? null);
};
const deadline = async (task: Promise<void>, ms: number, label: string): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			task,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${ms}ms; external cleanup may be pending`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

function visibleMessageText(payload: VisibleConversation['messages'][number]['payload']): string[] {
	const text: string[] = payload.content ? [payload.content] : [];
	for (const value of payload.embeds) {
		if (!value || typeof value !== 'object') continue;
		const embed = value as Record<string, unknown>;
		for (const key of ['title', 'description']) if (typeof embed[key] === 'string') text.push(embed[key]);
		if (Array.isArray(embed.fields))
			for (const value of embed.fields) {
				if (!value || typeof value !== 'object') continue;
				const field = value as Record<string, unknown>;
				if (typeof field.name === 'string') text.push(field.name);
				if (typeof field.value === 'string') text.push(field.value);
			}
		for (const [key, field] of [
			['footer', 'text'],
			['author', 'name'],
		] as const) {
			const value = embed[key];
			if (value && typeof value === 'object' && field in value) {
				const label = (value as Record<string, unknown>)[field];
				if (typeof label === 'string') text.push(label);
			}
		}
	}
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const component = value as Record<string, unknown>;
		if (component.type === 10 && typeof component.content === 'string') text.push(component.content);
		if (component.type === 2 && typeof component.label === 'string') text.push(component.label);
		if (typeof component.type === 'number' && [3, 5, 6, 7, 8].includes(component.type)) {
			if (typeof component.placeholder === 'string') text.push(component.placeholder);
			if (Array.isArray(component.options))
				for (const option of component.options) {
					if (option && typeof option === 'object' && 'label' in option && typeof option.label === 'string')
						text.push(option.label);
				}
		}
		visit(component.components);
		visit(component.accessory);
	};
	visit(payload.components);
	return text;
}

export function createSession<R>(
	project: Project<R>,
	preset: Preset,
	options: { disposeTimeoutMs?: number } = {},
): Session {
	let bot: MockBot | undefined;
	let resources: R | undefined;
	let hasResources = false;
	let refs: Record<string, string> = Object.create(null) as Record<string, string>;
	let actors: Record<string, Actor> = {};
	let actorSpecs: Record<string, { userId: string; guildId?: string; channelId: string }> = {};
	const closedModals = new Set<string>();
	const dismissed = new Map<string, Set<string>>();
	let context: ScenarioContext<R> | undefined;
	let unsubscribeBot: (() => void) | undefined;
	let active = false;
	let state: 'idle' | 'starting' | 'active' | 'stopping' = 'idle';
	let startTask: Promise<void> | undefined;
	let stopTask: Promise<void> | undefined;
	const listeners = new Set<(event: SessionEvent) => void>();
	const diagnostics: string[] = [];
	let sessionLog: SessionLog = {
		labVersion: LAB_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		preset: json(preset) as unknown as Preset,
		entries: [],
	};
	const emit = (event: SessionEvent) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (error) {
				const detail = `Observer failed: ${errorText(error)}`;
				diagnostics.push(detail);
				if (event.type !== 'error' || event.origin !== 'observer')
					for (const other of listeners) {
						if (other === listener) continue;
						try {
							other({ type: 'error', origin: 'observer', detail });
						} catch (observerError) {
							diagnostics.push(`Observer failed: ${errorText(observerError)}`);
						}
					}
			}
		}
	};
	const observeBot = (event: MockBotEvent) => {
		switch (event.type) {
			case 'rest':
				emit({
					type: 'rest',
					phase: event.phase,
					detail: json({
						method: event.action.method,
						route: event.action.route,
						...(event.phase === 'settled'
							? {
									status:
										typeof (event.action.response as { status?: unknown } | null)?.status === 'number'
											? (event.action.response as { status: number }).status
											: null,
									...(event.action.error ? { error: errorText(event.action.error) } : {}),
								}
							: {}),
					}),
				});
				break;
			case 'dispatch':
				emit({
					type: 'dispatch',
					phase: event.phase,
					detail: json({
						dispatchId: event.dispatchId,
						kind: event.kind,
						sessionKey: event.sessionKey,
						...(event.error ? { error: errorText(event.error) } : {}),
					}),
				});
				break;
			case 'world':
				emit({ type: 'world', detail: json(event.diff) });
				break;
			case 'interaction':
				emit({ type: 'interaction', detail: json(event.change) });
				break;
		}
	};
	const scenario = (): Scenario<R> => {
		const found = project.scenarios.find(
			item => item.id === preset.scenario.id && item.version === preset.scenario.version,
		);
		if (!found) throw new Error(`Scenario ${preset.scenario.id}@${preset.scenario.version} is not defined`);
		return found;
	};
	const resolve = (name: string): string => {
		const id = refs[name] ?? name;
		if (bot) {
			const world = bot.world.snapshot();
			if (
				world.guilds.some(item => item.id === id) ||
				world.channels.some(item => item.id === id) ||
				world.roles.some(item => item.id === id) ||
				world.members.some(item => item.userId === id) ||
				world.messages.some(item => item.id === id)
			)
				return id;
		} else if (refs[name] || Object.values(refs).includes(name)) return id;
		throw new Error(
			`Unknown ref "${name}"; available refs: ${
				Object.entries(refs)
					.map(([key, id]) => `${key}=${id}`)
					.join(', ') || '(none)'
			}`,
		);
	};
	const ref: Ref = (name, override) => {
		const presetOverride = preset.refs?.[name];
		if (override && presetOverride && override !== presetOverride)
			throw new Error(`Ref "${name}" override conflicts with preset`);
		const id = override ?? presetOverride ?? deterministicId(`${project.name}:${preset.scenario.id}:${name}`);
		if (refs[name] && refs[name] !== id) throw new Error(`Ref "${name}" already resolves to ${refs[name]}`);
		refs[name] = id;
		return id;
	};
	const paramsFor = (item: Scenario<R>): Params => {
		const result: Params = {};
		for (const [name, definition] of Object.entries(item.params ?? {})) {
			const value = (
				Object.hasOwn(preset.params ?? {}, name) ? preset.params?.[name] : definition.default
			) as Params[string];
			if (
				definition.kind === 'enum'
					? !definition.values?.includes(value)
					: typeof value !== definition.kind || (definition.kind === 'number' && !Number.isFinite(value))
			) {
				throw new TypeError(`Invalid parameter "${name}": expected ${definition.kind}`);
			}
			result[name] = value;
		}
		for (const name of Object.keys(preset.params ?? {}))
			if (!(name in (item.params ?? {}))) throw new TypeError(`Unknown parameter "${name}"`);
		return result;
	};
	const servicesFor = (): Record<string, string> => {
		const selected: Record<string, string> = {};
		for (const [name, service] of Object.entries(project.services ?? {})) {
			const variant = preset.services?.[name] ?? service.default;
			if (!service.variants[variant]) throw new Error(`Unknown service variant "${name}:${variant}"`);
			selected[name] = variant;
		}
		for (const name of Object.keys(preset.services ?? {}))
			if (!(name in (project.services ?? {}))) throw new Error(`Unknown service "${name}"`);
		return selected;
	};
	const cleanup = async (): Promise<void> => {
		const failures: unknown[] = [];
		unsubscribeBot?.();
		unsubscribeBot = undefined;
		if (bot) {
			const previous = bot;
			bot = undefined;
			try {
				await deadline(previous.close(), options.disposeTimeoutMs ?? project.resources?.timeoutMs ?? 5000, 'bot close');
			} catch (error) {
				failures.push(error);
			}
		}
		if (hasResources && project.resources) {
			const previous = resources as R;
			hasResources = false;
			resources = undefined;
			try {
				await deadline(
					Promise.resolve(project.resources.dispose(previous)),
					options.disposeTimeoutMs ?? project.resources.timeoutMs ?? 5000,
					'resources dispose',
				);
			} catch (error) {
				failures.push(error);
			}
		}
		active = false;
		state = 'idle';
		actors = {};
		actorSpecs = {};
		closedModals.clear();
		dismissed.clear();
		context = undefined;
		emit({ type: 'disposed' });
		if (failures.length)
			throw new AggregateError(failures, `Session cleanup failed: ${failures.map(errorText).join('; ')}`);
	};
	const requireBot = (): MockBot => {
		if (!active || !bot) throw new Error('Session is not started');
		return bot;
	};
	const snapshot = async (): Promise<InspectorSnapshot> => {
		const current = requireBot();
		const pending = current.pendingInteractions();
		const live = new Set(pending.modals.map(modal => modal.interactionId));
		for (const id of closedModals) if (!live.has(id)) closedModals.delete(id);
		return {
			world: json(current.world.snapshot()),
			rest: json(
				current.restCalls().map(call => ({ ...call, ...(call.error ? { error: errorText(call.error) } : {}) })),
			),
			pending: json({
				...pending,
				modals: pending.modals.map(modal => ({ ...modal, closed: closedModals.has(modal.interactionId) })),
			}),
			diagnostics: [...diagnostics],
			local: { dismissed: Object.fromEntries([...dismissed].map(([actor, ids]) => [actor, [...ids]])) },
		};
	};
	const pendingModal = (current: MockBot, actor: string, customId: string): PendingModal | undefined => {
		const modals = current.pendingInteractions().modals;
		const live = new Set(modals.map(modal => modal.interactionId));
		for (const id of closedModals) if (!live.has(id)) closedModals.delete(id);
		return modals.find(modal => modal.userId === resolve(actorSpecs[actor].userId) && modal.customId === customId);
	};
	const conversation = (current: MockBot, actor: string, channelId: string): VisibleConversation => {
		const spec = actorSpecs[actor];
		if (!spec) throw new Error(`Unknown actor "${actor}"`);
		const view = current.conversation({ userId: resolve(spec.userId), channelId });
		return { ...view, messages: view.messages.filter(message => !dismissed.get(actor)?.has(message.id)) };
	};
	const hasCustomId = (value: unknown, id: string): boolean => {
		if (!value || typeof value !== 'object') return false;
		if (Array.isArray(value)) return value.some(item => hasCustomId(item, id));
		const item = value as Record<string, unknown>;
		return item.custom_id === id || hasCustomId(item.components, id);
	};
	const locate = (current: MockBot, actorName: string, locator: Locator): string => {
		const channelId = resolve(locator.channel);
		const all = conversation(current, actorName, channelId).messages;
		const candidates = all.filter(
			message =>
				(!locator.messageRef || message.id === resolve(locator.messageRef)) &&
				(!locator.contains ||
					visibleMessageText(message.payload).some(text => text.includes(locator.contains as string))) &&
				(!locator.author ||
					message.payload.author?.id === (locator.author === 'bot' ? current.client.botId : resolve(locator.author))) &&
				(!locator.customId || hasCustomId(message.payload.components, locator.customId)),
		);
		if (candidates.length !== 1)
			throw new Error(
				`Locator matched ${candidates.length} messages in ${channelId}; candidates: ${all.map(item => `${item.id}:${item.payload.content ?? ''}`).join(', ') || '(none)'}`,
			);
		return candidates[0].id;
	};
	const dismissTarget = (current: MockBot, actor: string, source: Locator): VisibleMessage => {
		const all = conversation(current, actor, resolve(source.channel)).messages;
		let message: VisibleMessage | undefined;
		if (source.messageRef) {
			message = all.find(item => item.id === (refs[source.messageRef as string] ?? source.messageRef));
			if (!message) throw new Error('Message is no longer visible');
		} else if (source.contains)
			message = [...all]
				.reverse()
				.find(
					item =>
						item.visibility === 'ephemeral' &&
						item.ownerId === resolve(actorSpecs[actor].userId) &&
						visibleMessageText(item.payload).some(text => text.includes(source.contains as string)) &&
						(!source.customId || hasCustomId(item.payload.components, source.customId)),
				);
		if (!message) throw new Error('No visible message matches the dismiss source');
		if (message.visibility !== 'ephemeral' || message.ownerId !== resolve(actorSpecs[actor].userId))
			throw new Error('Only your ephemeral messages can be dismissed');
		return message;
	};
	const actionChannel = (current: MockBot, actorName: string, channelRef: string) => {
		const channelId = resolve(channelRef);
		const channel = current.world.query.channel({ id: channelId });
		if (!channel) throw new Error(`Unknown channel "${channelRef}"`);
		const spec = actorSpecs[actorName];
		if (!spec) throw new Error(`Unknown actor "${actorName}"`);
		if (spec.guildId && channel.guildId !== resolve(spec.guildId))
			throw new Error(`Actor "${actorName}" does not belong to channel "${channelRef}" guild`);
		const view = current.conversation({ userId: resolve(spec.userId), channelId });
		if (view.diagnostics.includes('no-view-channel'))
			throw new Error(`Actor "${actorName}" cannot view channel "${channelRef}" (ViewChannel)`);
		return {
			id: channel.id,
			type: channel.type,
			name: channel.name ?? '',
			...(channel.guildId ? { guild_id: channel.guildId } : {}),
			...(channel.parentId ? { parent_id: channel.parentId } : {}),
			position: channel.position,
			permission_overwrites: channel.overwrites,
			nsfw: channel.nsfw,
			...(channel.topic !== undefined ? { topic: channel.topic } : {}),
			...(channel.rateLimitPerUser !== undefined ? { rate_limit_per_user: channel.rateLimitPerUser } : {}),
			...(channel.threadMetadata ? { thread_metadata: channel.threadMetadata } : {}),
		} satisfies ApiChannel;
	};
	const instance: Session = {
		start() {
			if (state !== 'idle' || bot || hasResources)
				return Promise.reject(new Error(`Session is ${state}; cannot start`));
			state = 'starting';
			startTask = (async () => {
				try {
					const item = scenario();
					const params = paramsFor(item);
					const services = servicesFor();
					await project.configure?.();
					if (project.resources) {
						resources = await project.resources.setup({ preset });
						hasResources = true;
					}
					refs = Object.create(null) as Record<string, string>;
					const builder: WorldBuilder = mockWorld();
					const world: ScenarioWorld = {
						builder,
						ref,
						bot: options => builder.botUser(options),
						guild: (name, opts) => builder.registerGuild({ ...opts, id: ref(name, opts?.id) }).id,
						role: (name, guild, opts) => builder.registerRole(resolve(guild), { ...opts, id: ref(name, opts?.id) }).id,
						channel: (name, guild, opts) =>
							builder.registerChannel(resolve(guild), { ...opts, id: ref(name, opts?.id) }).id,
						member: (name, guild, opts) => {
							const id = ref(name);
							return builder.registerMember(resolve(guild), {
								...opts,
								user: { ...apiUser({ id }), ...opts?.user, id },
							}).user.id;
						},
						message: (name, channel, opts) =>
							builder.registerMessage(resolve(channel), { ...opts, id: ref(name, opts?.id) }).id,
					};
					item.world?.(world, { params, ref });
					for (const name of Object.keys(preset.refs ?? {}))
						if (!refs[name]) throw new Error(`Preset overrides unknown ref "${name}"`);
					const result = (await project.bot?.({ world: builder, resources: resources as R })) ?? {
						loadFromConfig: true,
					};
					bot = 'actor' in result ? (result as MockBot) : await createMockBot({ ...result, world: builder });
					unsubscribeBot = bot.observe(observeBot);
					context = { params, refs: { ...refs }, resources: resources as R, services };
					for (const [name, variant] of Object.entries(services))
						await project.services?.[name].variants[variant](context);
					const missing = (await item.requires?.(context)) ?? [];
					if (missing.length) throw new Error(`Missing requirements: ${missing.join(', ')}`);
					await item.seed?.(context);
					actorSpecs = item.actors?.(context.refs) ?? {};
					for (const [name, spec] of Object.entries(actorSpecs)) {
						const channel = bot.world.query.channel({ id: resolve(spec.channelId) });
						if (!channel) throw new Error(`Actor "${name}" channel ${spec.channelId} is missing`);
						const guildId = spec.guildId ? resolve(spec.guildId) : undefined;
						const userId = resolve(spec.userId);
						const member = guildId
							? builder.build().members.find(entry => entry.guildId === guildId && entry.member.user.id === userId)
									?.member
							: undefined;
						if (guildId && !member)
							throw new Error(`Actor "${name}" member ${userId} is missing from guild ${guildId}`);
						actors[name] = bot.actor({
							...(member ? { member } : { user: apiUser({ id: userId }) }),
							guildId,
							channel: builder.build().channels.find(entry => entry.id === channel.id),
						});
					}
					sessionLog.preset = { scenario: { ...preset.scenario }, params, services, refs: { ...refs } };
					active = true;
					state = 'active';
					emit({ type: 'started' });
				} catch (error) {
					emit({ type: 'error', detail: errorText(error) });
					try {
						await cleanup();
					} catch (cleanupError) {
						throw new AggregateError([error, cleanupError], 'Session start and cleanup failed');
					}
					throw error;
				}
			})();
			return startTask;
		},
		dispose() {
			if (stopTask) return stopTask;
			stopTask = (async () => {
				if (state === 'starting') {
					try {
						await startTask;
					} catch {
						// start already ran its partial cleanup
					}
				}
				if (state === 'idle') return;
				state = 'stopping';
				await cleanup();
			})();
			return stopTask.finally(() => {
				stopTask = undefined;
			});
		},
		async reset() {
			await instance.dispose();
			sessionLog = {
				labVersion: LAB_VERSION,
				protocolVersion: PROTOCOL_VERSION,
				preset: json(preset) as unknown as Preset,
				entries: [],
			};
			await instance.start();
		},
		async act(action) {
			const current = requireBot();
			let outcome: ActionOutcome;
			let recordedAction: LabAction = action;
			try {
				validateLabAction(action);
				let result: DispatchResult | undefined;
				let summary: string | undefined;
				if (action.kind === 'local' && !actors[action.actor]) throw new Error(`Unknown actor "${action.actor}"`);
				if (action.kind === 'local') {
					if (action.op === 'dismissMessage') {
						const message = dismissTarget(current, action.actor, action.source);
						const ids = dismissed.get(action.actor) ?? new Set<string>();
						ids.add(message.id);
						dismissed.set(action.actor, ids);
						const text = visibleMessageText(message.payload);
						const contains =
							action.source.contains && text.some(item => item.includes(action.source.contains as string))
								? action.source.contains
								: text[0];
						recordedAction = {
							...action,
							source: { ...action.source, contains },
						};
						summary = 'message dismissed';
					} else {
						const modal = pendingModal(current, action.actor, action.customId);
						if (!modal) throw new Error(`No pending modal "${action.customId}" for ${action.actor}`);
						if (action.op === 'closeModal') closedModals.add(modal.interactionId);
						else closedModals.delete(modal.interactionId);
						summary = action.op === 'closeModal' ? 'modal closed locally' : 'modal reopened';
					}
				}
				if (action.kind === 'admin') {
					const input = {
						guildId: resolve(action.guild),
						userId: resolve(action.member),
						roleId: resolve(action.role),
					};
					switch (action.op) {
						case 'addRole':
							await current.admin.addMemberRole(input);
							break;
						case 'removeRole':
							await current.admin.removeMemberRole(input);
							break;
						default:
							throw new Error(`Unknown admin operation "${String((action as { op: unknown }).op)}"`);
					}
				}
				if (action.kind === 'user') {
					const actor = actors[action.actor];
					if (!actor) throw new Error(`Unknown actor "${action.actor}"`);
					const pending = current
						.pendingInteractions()
						.modals.find(modal => modal.userId === resolve(actorSpecs[action.actor].userId));
					const opener = pending?.source as
						| (PendingModal['source'] & {
								channelId?: string;
								values?: string[];
								group?: string;
								subcommand?: string;
								options?: JsonValue;
						  })
						| undefined;
					let sourceId: string | undefined;
					let channelId: string | undefined;
					if (action.verb === 'click' || action.verb === 'select') {
						channelId = actionChannel(current, action.actor, action.source.channel).id;
						sourceId = locate(current, action.actor, action.source);
					} else if (action.verb === 'slash') {
						channelId = actionChannel(current, action.actor, action.channel ?? actorSpecs[action.actor].channelId).id;
					}
					if (
						pending &&
						opener?.channelId &&
						opener.channelId === channelId &&
						((action.verb === 'slash' &&
							!opener.messageId &&
							opener.commandName === action.command &&
							opener.group === action.group &&
							opener.subcommand === action.subcommand &&
							normalizedOptions(opener.options) === normalizedOptions(action.options)) ||
							((action.verb === 'click' || action.verb === 'select') &&
								opener.customId === action.customId &&
								opener.messageId === sourceId &&
								(action.verb === 'click' ||
									(opener.values !== undefined && JSON.stringify(opener.values) === JSON.stringify(action.values)))))
					) {
						closedModals.delete(pending.interactionId);
						summary = 'modal reopened';
					} else
						try {
							switch (action.verb) {
								case 'slash':
									{
										const channel = actionChannel(
											current,
											action.actor,
											action.channel ?? actorSpecs[action.actor].channelId,
										);
										result = await actor.slash({
											name: action.command,
											channel,
											group: action.group,
											subcommand: action.subcommand,
											options: action.options as ChatInputInteractionOptions['options'],
										});
									}
									break;
								case 'click':
									result = await actor.clickButton(action.customId, {
										channel: actionChannel(current, action.actor, action.source.channel),
										source: sourceId as string,
									});
									break;
								case 'select':
									result = await actor.selectMenu(action.customId, action.values, {
										channel: actionChannel(current, action.actor, action.source.channel),
										source: sourceId as string,
									});
									break;
								case 'submitModal':
									result = await actor.submitModal(action.customId, action.fields, {
										channel: actionChannel(current, action.actor, action.channel ?? actorSpecs[action.actor].channelId),
									});
									break;
								default:
									throw new Error(`Unknown user verb "${String((action as { verb: unknown }).verb)}"`);
							}
						} catch (error) {
							if (pending && errorText(error).includes('already has a pending flow')) {
								const name =
									(await instance.describe()).actors.find(item => item.key === action.actor)?.name ?? action.actor;
								throw new Error(
									`${name} has an unfinished form “${pending.payload.title}”. Reopen it from its button or submit it first.`,
								);
							}
							throw error;
						}
				}
				if (action.kind !== 'user' && action.kind !== 'admin' && action.kind !== 'local')
					throw new Error(`Unknown action kind "${String((action as { kind: unknown }).kind)}"`);
				outcome = {
					ok: true,
					dispatchIds: [
						...new Set(
							result?.actions.map(entry => entry.dispatchId).filter((id): id is number => id !== undefined) ?? [],
						),
					],
					summary: summary ?? result?.content ?? result?.modal?.title ?? 'completed',
				};
			} catch (error) {
				outcome = { ok: false, error: errorText(error), dispatchIds: [], summary: 'failed' };
			}
			sessionLog.entries.push({
				seq: sessionLog.entries.length + 1,
				action: json(recordedAction) as unknown as LabAction,
				outcome,
			});
			emit({ type: 'action', detail: json(outcome) });
			if (!outcome.ok) {
				emit({ type: 'error', detail: outcome.error ?? 'Action failed' });
				throw new Error(outcome.error);
			}
			return outcome;
		},
		observe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async view(actor, channelRef): Promise<VisibleConversation> {
			if (!actors[actor]) throw new Error(`Unknown actor "${actor}"`);
			return conversation(requireBot(), actor, resolve(channelRef));
		},
		inspect: snapshot,
		async describe(): Promise<SessionDescription> {
			const current = requireBot();
			const world = current.world.snapshot();
			const names: SessionDescription['names'] = { users: {}, roles: {}, channels: {} };
			for (const member of world.members) {
				const user = await current.client.cache.users?.raw(member.userId);
				names.users[member.userId] =
					member.nick ||
					user?.global_name ||
					user?.username ||
					Object.entries(refs).find(([, id]) => id === member.userId)?.[0] ||
					member.userId;
			}
			for (const role of world.roles) names.roles[role.id] = role.name;
			for (const channel of world.channels) names.channels[channel.id] = channel.name;
			const describedActors: SessionDescription['actors'] = Object.entries(actorSpecs).map(([key, spec]) => {
				const userId = resolve(spec.userId);
				const guildId = spec.guildId ? resolve(spec.guildId) : undefined;
				const name = names.users[userId] ?? key;
				names.users[userId] = name;
				return {
					key,
					userId,
					name,
					guildId,
					channelId: resolve(spec.channelId),
					roles: Object.fromEntries(
						world.guilds.map(guild => [
							guild.id,
							world.members.find(item => item.guildId === guild.id && item.userId === userId)?.roles ?? [],
						]),
					),
				};
			});
			const botId = current.client.botId;
			const botUser = await current.client.cache.users?.raw(botId);
			names.users[botId] = botUser?.global_name || botUser?.username || names.users[botId] || 'Bot';
			if (!describedActors.some(actor => actor.userId === botId))
				describedActors.push({
					key: 'bot',
					userId: botId,
					name: names.users[botId],
					channelId: '',
					roles: Object.fromEntries(
						world.guilds.map(guild => [
							guild.id,
							world.members.find(item => item.guildId === guild.id && item.userId === botId)?.roles ?? [],
						]),
					),
				});
			const guilds = world.guilds.map(guild => ({
				id: guild.id,
				name: guild.name,
				roles: world.roles
					.filter(role => role.guildId === guild.id)
					.map(({ id, name, position, permissions }) => ({ id, name, position, permissions })),
				members: world.members
					.filter(member => member.guildId === guild.id)
					.map(member => ({
						id: member.userId,
						name: names.users[member.userId] ?? member.userId,
						bot: member.userId === botId,
					})),
				channels: world.channels
					.filter(channel => channel.guildId === guild.id)
					.map(channel => ({
						id: channel.id,
						name: channel.name,
						type: channel.type,
						visibleTo: describedActors
							.filter(
								actor =>
									actor.key !== 'bot' &&
									!current
										.conversation({ userId: actor.userId, channelId: channel.id })
										.diagnostics.includes('no-view-channel'),
							)
							.map(actor => actor.key),
					})),
			}));
			return { preset: { ...sessionLog.preset }, refs: { ...refs }, actors: describedActors, guilds, names };
		},
		async commandSchemas() {
			return await requireBot().commandSchemas();
		},
		async inspectProject(name, args = null) {
			requireBot();
			const handler = project.inspect?.[name];
			if (!handler || !context) throw new Error(`Unknown project inspector "${name}"`);
			return json(await handler(context, args));
		},
		async log() {
			return json(sessionLog) as unknown as SessionLog;
		},
	};
	return instance;
}

export function deterministicId(name: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(name)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
	return (hash & 0x3fffffffffffffffn).toString();
}

export function replay<R>(
	project: Project<R>,
	checkpoint: Checkpoint,
): Promise<{ log: SessionLog; inspect: InspectorSnapshot }>;
export function replay<R>(
	project: Project<R>,
	log: SessionLog,
	expectations: Expectation[],
): Promise<{ log: SessionLog; inspect: InspectorSnapshot }>;
export async function replay<R>(
	project: Project<R>,
	input: Checkpoint | SessionLog,
	expectations?: Expectation[],
): Promise<{ log: SessionLog; inspect: InspectorSnapshot }> {
	const checkpoint: Checkpoint = 'entries' in input ? createCheckpoint(input, 'replay', expectations ?? []) : input;
	validateCheckpoint(checkpoint);
	if (checkpoint.labVersion !== LAB_VERSION)
		throw new Error(`Checkpoint lab version ${checkpoint.labVersion} is not supported (current ${LAB_VERSION})`);
	if (
		!project.scenarios.some(
			item => item.id === checkpoint.preset.scenario.id && item.version === checkpoint.preset.scenario.version,
		)
	)
		throw new Error(
			`Checkpoint scenario ${checkpoint.preset.scenario.id}@${checkpoint.preset.scenario.version} is not defined`,
		);
	const session = createSession(project, checkpoint.preset);
	return replaySession(session, checkpoint);
}
export async function replaySession(
	session: Session,
	checkpoint: Checkpoint,
): Promise<{ log: SessionLog; inspect: InspectorSnapshot }> {
	validateCheckpoint(checkpoint);
	if (checkpoint.labVersion !== LAB_VERSION)
		throw new Error(`Checkpoint lab version ${checkpoint.labVersion} is not supported (current ${LAB_VERSION})`);
	await session.start();
	try {
		for (const [index, action] of checkpoint.actions.entries()) {
			let failure: unknown;
			const expected = checkpoint.outcomes?.find(item => item.action === index);
			let replayAction = action;
			if (
				action.kind === 'local' &&
				action.op === 'dismissMessage' &&
				action.source.messageRef &&
				expected?.ok !== false
			) {
				if (!action.source.contains)
					throw new Error(`Checkpoint "${checkpoint.name}" cannot replay dismiss ${index + 1} without visible text`);
				const { messageRef: _messageRef, ...source } = action.source;
				replayAction = { ...action, source };
			}
			try {
				await session.act(replayAction);
			} catch (error) {
				failure = error;
			}
			const actual = (await session.log()).entries[index]?.outcome;
			if (!actual) throw new Error(`Checkpoint "${checkpoint.name}" did not record action ${index + 1}`);
			if (expected) compareOutcome(checkpoint.name, index, actual, expected);
			else if (failure) throw failure;
		}
		const inspect = await session.inspect();
		for (const expectation of checkpoint.arrival) {
			if ('action' in expectation) {
				const actual = (await session.log()).entries[expectation.action]?.outcome;
				if (!actual) throw new Error(`Checkpoint "${checkpoint.name}" has no action ${expectation.action + 1}`);
				compareOutcome(checkpoint.name, expectation.action, actual, expectation);
				continue;
			}
			if ('view' in expectation) {
				const conversation = await session.view(expectation.view.actor, expectation.view.channel);
				const matches = conversation.messages.some(message =>
					visibleMessageText(message.payload).some(text => text.includes(expectation.contains)),
				);
				if (matches === (expectation.absent === true))
					throw new Error(
						`Checkpoint "${checkpoint.name}" failed view ${expectation.view.actor}/${expectation.view.channel}: ${expectation.contains} ${expectation.absent ? 'is present' : 'is absent'}`,
					);
				continue;
			}
			if ('role' in expectation) {
				const description = await session.describe();
				const guildId = description.refs[expectation.role.guild] ?? expectation.role.guild;
				const memberId = description.refs[expectation.role.member] ?? expectation.role.member;
				const roleId = description.refs[expectation.role.role] ?? expectation.role.role;
				const role = (inspect.world as { roles?: { id: string; guildId: string }[] }).roles?.find(
					item => item.id === roleId && item.guildId === guildId,
				);
				if (!role)
					throw new Error(
						`Checkpoint "${checkpoint.name}" has no role ${expectation.role.role} in ${expectation.role.guild}`,
					);
				const member = (
					inspect.world as { members?: { guildId: string; userId: string; roles: string[] }[] }
				).members?.find(item => item.guildId === guildId && item.userId === memberId);
				if (!member)
					throw new Error(
						`Checkpoint "${checkpoint.name}" has no member ${expectation.role.member} in ${expectation.role.guild}`,
					);
				const present = member.roles.includes(roleId);
				if (present !== expectation.present)
					throw new Error(
						`Checkpoint "${checkpoint.name}" failed role ${expectation.role.role} for ${expectation.role.member} in ${expectation.role.guild}: expected ${expectation.present ? 'present' : 'absent'}, got ${present ? 'present' : 'absent'}`,
					);
				continue;
			}
			const base =
				'project' in expectation
					? await session.inspectProject(expectation.project.name, expectation.project.args)
					: inspect;
			const path = 'project' in expectation ? expectation.project.path : expectation.path;
			const actual = path ? readPath(base, path) : base;
			if (JSON.stringify(actual) !== JSON.stringify(expectation.equals))
				throw new Error(
					`Checkpoint "${checkpoint.name}" failed at ${'project' in expectation ? `project ${expectation.project.name} ` : ''}${path}: expected ${JSON.stringify(expectation.equals)}, got ${JSON.stringify(actual)}`,
				);
		}
		return { log: await session.log(), inspect };
	} finally {
		await session.dispose();
	}
}
function readPath(value: unknown, path: string): unknown {
	return path
		.split('.')
		.reduce<unknown>(
			(current, key) =>
				current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined,
			value,
		);
}
function compareOutcome(
	name: string,
	index: number,
	actual: ActionOutcome,
	expected: { ok: boolean; error?: string; dispatchCount?: number },
): void {
	if (
		actual.ok !== expected.ok ||
		(expected.error !== undefined && !new RegExp(expected.error).test(actual.error ?? '')) ||
		(expected.dispatchCount !== undefined && actual.dispatchIds.length !== expected.dispatchCount)
	)
		throw new Error(
			`Checkpoint "${name}" failed action ${index + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
}

export type { Expectation };
