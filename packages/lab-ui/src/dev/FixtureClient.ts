import type { InspectorEntry, LabAction, LabClient, LabSnapshot, ScenarioChoice, VisibleMessage } from '../bridge';
import { presetParams, sessionActors } from '../bridge';

const bot = { id: 'bot', username: 'Seyfert', bot: true };
const message = (id: string, content: string, extra: Partial<VisibleMessage> = {}): VisibleMessage => ({
	id,
	channelId: 'general',
	visibility: 'public',
	payload: { id, author: bot, content },
	...extra,
});

const initial: LabSnapshot = {
	project: {
		name: 'Reference bot',
		scenarios: [
			{
				id: 'welcome',
				version: 1,
				title: 'Welcome with permissions',
				params: {
					greeting: { kind: 'string', label: 'Greeting', default: 'Hello' },
					requireReview: { kind: 'boolean', label: 'Requires review', default: true },
					attempts: { kind: 'number', label: 'Attempts', default: 2 },
					mode: { kind: 'enum', label: 'Mode', default: 'manual', values: ['manual', 'automatic'] },
				},
			},
		],
		services: { replies: { default: 'normal', variants: ['normal', 'failure', 'pending'] } },
		inspectors: [],
	},
	session: {
		preset: {
			scenario: { id: 'welcome', version: 1 },
			params: { greeting: 'Hello', requireReview: true, attempts: 2, mode: 'manual' },
			services: { replies: 'normal' },
		},
		refs: { guild: 'guild', general: 'general', staff: 'staff', alice: '101', bob: '102' },
		actors: [
			{
				key: 'alice',
				name: 'Alice',
				userId: '101',
				guildId: 'guild',
				channelId: 'general',
				roles: { guild: ['member'] },
			},
			{
				key: 'bob',
				name: 'Bob',
				userId: '102',
				guildId: 'guild',
				channelId: 'general',
				roles: { guild: ['moderator'] },
			},
		],
		guilds: [
			{
				id: 'guild',
				name: 'Test Server',
				roles: [
					{ id: 'guild', name: '@everyone', position: 0, permissions: '0' },
					{ id: 'member', name: 'Member', position: 1, permissions: '0' },
					{ id: 'moderator', name: 'Moderator', position: 2, permissions: '0' },
				],
				members: [
					{ id: '101', name: 'Alice', bot: false },
					{ id: '102', name: 'Bob', bot: false },
					{ id: 'bot', name: 'Seyfert', bot: true },
				],
				channels: [
					{ id: 'general', name: 'general', type: 0, visibleTo: ['alice', 'bob'] },
					{ id: 'staff', name: 'staff', type: 0, visibleTo: ['bob'] },
				],
			},
		],
		names: {
			users: { '101': 'Alice', '102': 'Bob' },
			roles: { member: 'Member', moderator: 'Moderator' },
			channels: { general: 'general', staff: 'staff', '222': 'general' },
		},
	},
	conversations: {
		'alice:general': {
			diagnostics: [],
			messages: [
				message('m1', 'Hi <@101>. **Review** the request in <#222>.', {
					payload: {
						id: 'm1',
						author: bot,
						content: 'Hi <@101>. **Review** the request in <#222>.',
						components: [
							{
								type: 1,
								components: [
									{ type: 2, style: 1, custom_id: 'approve', label: 'Approve' },
									{ type: 2, style: 2, custom_id: 'disabled', label: 'Unavailable', disabled: true },
									{ type: 2, style: 5, label: 'Guide', url: 'https://example.com' },
								],
							},
							{
								type: 1,
								components: [
									{
										type: 3,
										custom_id: 'route',
										placeholder: 'Choose a route',
										options: [
											{ label: 'Manual', value: 'manual' },
											{ label: 'Automatic', value: 'auto' },
										],
									},
								],
							},
						],
					},
				}),
				message('m2', 'Your request is under review.', { visibility: 'ephemeral', ownerId: '101' }),
				message('m3', '', { payload: { id: 'm3', author: bot, content: '', flags: 128 } }),
				message('m4', '', {
					payload: {
						id: 'm4',
						author: bot,
						flags: 32768,
						components: [
							{
								type: 17,
								color: 5793266,
								components: [
									{ type: 10, content: '**Summary**\nA test flow.' },
									{ type: 14, divider: true },
									{
										type: 9,
										components: [{ type: 10, content: 'Check the status.' }],
										accessory: { type: 2, style: 2, label: 'View', custom_id: 'view' },
									},
									{ type: 12, items: [{ media: { url: 'attachment://demo.png' } }] },
								],
							},
						],
					},
				}),
			],
		},
		'bob:general': { diagnostics: [], messages: [message('m1', 'Hi <@101>. **Review** the request in <#222>.')] },
		'alice:staff': { diagnostics: ['no-view-channel'], messages: [] },
		'bob:staff': { diagnostics: [], messages: [message('staff1', 'Team area.')] },
	},
	commands: [
		{
			name: 'review',
			description: 'Review a request',
			options: [
				{
					type: 1,
					name: 'open',
					description: 'Open a review',
					options: [
						{ type: 3, name: 'reason', description: 'Reason', required: true },
						{ type: 4, name: 'priority', description: 'Priority' },
						{ type: 5, name: 'notify', description: 'Notify' },
						{ type: 6, name: 'user', description: 'User' },
						{ type: 7, name: 'channel', description: 'Channel' },
						{ type: 8, name: 'role', description: 'Role' },
						{
							type: 3,
							name: 'mode',
							description: 'Mode',
							choices: [
								{ name: 'Manual', value: 'manual' },
								{ name: 'Auto', value: 'auto' },
							],
						},
					],
				},
			],
		},
	],
	pending: {
		modals: [
			{
				userId: '101',
				interactionId: 'fixture-review-1',
				customId: 'review-modal',
				payload: {
					custom_id: 'review-modal',
					title: 'Review request',
					components: [
						{ type: 10, content: 'Give a reason before continuing.' },
						{
							type: 18,
							label: 'Reason',
							component: {
								type: 4,
								style: 2,
								custom_id: 'reason',
								required: true,
								min_length: 3,
								placeholder: 'Write a reason',
							},
						},
						{
							type: 18,
							label: 'Route',
							component: {
								type: 3,
								custom_id: 'route',
								required: true,
								options: [
									{ label: 'Manual', value: 'manual' },
									{ label: 'Auto', value: 'auto' },
								],
							},
						},
					],
				},
			},
		],
		collectors: [{ id: 'collector-1', label: 'Button approve', detail: 'Waiting for input' }],
	},
	closedModals: [],
	inspector: {
		actions: [{ id: 'start', label: 'Scenario started', detail: 'welcome v1' }],
		rest: [
			{
				id: 'rest-1',
				label: 'PUT /guilds/guild/members/101/roles/moderator',
				detail: 'Missing Permissions',
				failed: true,
			},
		],
		diagnostics: [{ id: 'diag-1', label: 'no-view-channel', detail: 'alice → staff' }],
	},
};

export class FixtureClient implements LabClient {
	private snapshot: LabSnapshot = structuredClone(initial);
	private listeners = new Set<(snapshot: LabSnapshot) => void>();
	async connect() {
		return this.snapshot;
	}
	subscribe(listener: (snapshot: LabSnapshot) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit() {
		const current = structuredClone(this.snapshot);
		for (const listener of this.listeners) listener(current);
	}
	private log(entry: Omit<InspectorEntry, 'id'>) {
		this.snapshot.inspector.actions.unshift({ id: crypto.randomUUID(), ...entry });
	}
	async start(choice: ScenarioChoice) {
		const version = this.snapshot.project.scenarios.find(item => item.id === choice.scenarioId)?.version ?? 1;
		if (this.snapshot.session)
			this.snapshot.session.preset = {
				scenario: { id: choice.scenarioId, version },
				params: presetParams(choice),
				services: choice.services,
			};
		this.snapshot.closedModals = [];
		this.log({ label: 'Scenario restarted', detail: choice.scenarioId });
		this.emit();
	}
	async act(action: LabAction) {
		this.log({ kind: action.kind, label: 'verb' in action ? action.verb : action.op, detail: JSON.stringify(action) });
		if ('verb' in action && action.verb === 'submitModal') {
			const userId = sessionActors(this.snapshot.session).find(actor => actor.key === action.actor)?.userId;
			this.snapshot.pending.modals = this.snapshot.pending.modals.filter(
				modal => modal.customId !== action.customId || modal.userId !== userId,
			);
		}
		this.emit();
	}
	closeModal(actor: string, customId: string) {
		const userId = sessionActors(this.snapshot.session).find(item => item.key === actor)?.userId;
		const modal = this.snapshot.pending.modals.find(item => item.customId === customId && item.userId === userId);
		if (modal) this.snapshot.closedModals = [...this.snapshot.closedModals, modal.interactionId];
		this.log({ kind: 'local', label: 'closeModal', detail: customId });
		this.emit();
	}
	async dismissMessage(actor: string, channel: string, dismissed: VisibleMessage) {
		const view = this.snapshot.conversations[`${actor}:${channel}`];
		if (view) view.messages = view.messages.filter(item => item.id !== dismissed.id);
		this.log({ kind: 'local', label: 'dismissMessage', detail: dismissed.id });
		this.emit();
	}
	reopenModal(key: string) {
		this.snapshot.closedModals = this.snapshot.closedModals.filter(item => item !== key);
		this.emit();
	}
	clearError() {
		this.snapshot.error = undefined;
		this.emit();
	}
}
