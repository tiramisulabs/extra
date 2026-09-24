import { Context } from '@slipher/macros';
import { ComponentCommand } from 'seyfert';
export class StringSelect extends ComponentCommand {
	componentType = 'StringSelect' as const;
	@Context() run(ctx) {
		const interaction: import('seyfert').StringSelectMenuInteraction = ctx.interaction;
		const values: string[] = ctx.interaction.values;
		// @ts-expect-error select values are not any
		const invalid: number = ctx.interaction.values;
		return values;
	}
}
export class UserSelect extends ComponentCommand {
	componentType = 'UserSelect' as const;
	@Context() run(ctx) {
		const interaction: import('seyfert').UserSelectMenuInteraction = ctx.interaction;
		const values: string[] = ctx.interaction.values;
		// @ts-expect-error select values are not any
		const invalid: number = ctx.interaction.values;
		return values;
	}
}
export class RoleSelect extends ComponentCommand {
	componentType = 'RoleSelect' as const;
	@Context() run(ctx) {
		const interaction: import('seyfert').RoleSelectMenuInteraction = ctx.interaction;
		const values: string[] = ctx.interaction.values;
		// @ts-expect-error select values are not any
		const invalid: number = ctx.interaction.values;
		return values;
	}
}
export class MentionableSelect extends ComponentCommand {
	componentType = 'MentionableSelect' as const;
	@Context() run(ctx) {
		const interaction: import('seyfert').MentionableSelectMenuInteraction = ctx.interaction;
		const values: string[] = ctx.interaction.values;
		// @ts-expect-error select values are not any
		const invalid: number = ctx.interaction.values;
		return values;
	}
}
export class ChannelSelect extends ComponentCommand {
	componentType = 'ChannelSelect' as const;
	@Context() run(ctx) {
		const interaction: import('seyfert').ChannelSelectMenuInteraction = ctx.interaction;
		const values: string[] = ctx.interaction.values;
		// @ts-expect-error select values are not any
		const invalid: number = ctx.interaction.values;
		return values;
	}
}
