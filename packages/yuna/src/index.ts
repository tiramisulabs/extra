import { fullNameOf } from './lib/utils';
import './seyfert';

import { type Command, CommandContext, type Message, type SubCommand } from 'seyfert';
import type { CommandOptionWithType } from 'seyfert/lib/commands/handle';
import { ApplicationCommandOptionType } from 'seyfert/lib/types/index';
import { Keys } from './things';
import { getCommandsMetadata, prepareCommands, resolve } from './utils/commandsResolver/prepare';
import { YunaCommandsResolver } from './utils/commandsResolver/resolver';
import { YunaWatcherUtils } from './utils/messageWatcher/watcherUtils';
import type { YunaParserCreateOptions } from './utils/parser/configTypes';
import { mergeConfig } from './utils/parser/createConfig';
import { YunaParser } from './utils/parser/parser';

export type { ArgPosition, ArgsResult, ArgsResultMetadata, YunaGroupType as GroupType } from './things';
export type { YunaResolverResult } from './utils/commandsResolver/base';
export { DeclareFallbackSubCommand, Shortcut } from './utils/commandsResolver/decorators';
export type { InferWatcherContext } from './utils/messageWatcher/Controller';
export { createWatcher } from './utils/messageWatcher/controllerUtils';
export type { MessageWatcherManager } from './utils/messageWatcher/Manager';
export type {
	DecoratorWatchOptions,
	InferWatcher,
	InferWatcherManager,
	WatcherOnChangeEvent,
	WatcherOnOptionsErrorEvent,
	WatcherOnStopEvent,
	WatcherOnUsageErrorEvent,
	WatcherOptions,
} from './utils/messageWatcher/types';
export type { MessageWatcher } from './utils/messageWatcher/Watcher';
export { Watch } from './utils/messageWatcher/watcherUtils';
export { DeclareParserConfig } from './utils/parser/createConfig';

export const ParserRecommendedConfig = {
	/** things that I consider necessary in an Eval command. */
	Eval: {
		breakSearchOnConsumeAllOptions: true,
		disableLongTextTagsInLastOption: {
			excludeCodeBlocks: true,
		},
	},
} satisfies Record<string, YunaParserCreateOptions>;

class BaseYuna {
	/**
	 * 🐧
	 * @example
	 * ```ts
	 * import { HandleCommand } from "seyfert/lib/commands/handle";
	 * import { Yuna } from "yunaforseyfert";
	 *
	 * class YourHandleCommand extends HandleCommand {
	 *     argsParser = Yuna.parser(); // Here are the settings
	 * }
	 * // your bot's client
	 * client.setServices({
	 *     handleCommand: YourHandleCommand,
	 * });
	 * ```
	 */
	parser = YunaParser;
	/**
	 * 🐧
	 * @example
	 * ```ts
	 * import { HandleCommand } from "seyfert/lib/commands/handle";
	 * import { Yuna } from "yunaforseyfert";
	 *
	 * class YourHandleCommand extends HandleCommand {
	 *      resolveCommandFromContent = Yuna.resolver({
	 *          // You need to pass the client in order to prepare the commands that the resolver will use.
	 *          client: this.client,
	 *          // Event to be emitted each time the commands are prepared.
	 *          afterPrepare: (metadata) => {
	 *              this.client.logger.debug(`Ready to use ${metadata.commands.length} commands !`);
	 *          },
	 *      });
	 * }
	 * // your bot's client
	 * client.setServices({
	 *     handleCommand: YourHandleCommand,
	 * });
	 * ```
	 */
	resolver = YunaCommandsResolver;

	mergeParserConfig = mergeConfig;

	commands = {
		prepare: prepareCommands,
		resolve,
		/**
		 * if it is a subcommand,
		 * it will need to have the `parent` property (using Yuna.resolver will be added)
		 */
		fullNameOf,
		getMetadata: getCommandsMetadata,
		isParent(command: Command | SubCommand): command is Command & { options: SubCommand[] } {
			if (!command.options?.length) return false;
			const [firstOption] = command.options as CommandOptionWithType[];
			return (
				firstOption.type === ApplicationCommandOptionType.Subcommand ||
				firstOption.type === ApplicationCommandOptionType.SubcommandGroup
			);
		},
	};

	getArgsResult(resolvable?: CommandContext | Message) {
		const message = resolvable instanceof CommandContext ? resolvable.message : resolvable;
		return message?.[Keys.messageArgsResult];
	}

	watchers = YunaWatcherUtils;
}

export const Yuna = new BaseYuna();
