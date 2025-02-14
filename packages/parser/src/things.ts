import type { Client, Command, SubCommand, UsingClient, WorkerClient } from 'seyfert';
import type { LocaleString } from 'seyfert/lib/types';
import type { YunaParserCommandMetaData } from './utils/parser/CommandMetaData';
import type { YunaParserCreateOptions } from './utils/parser/configTypes';

// biome-ignore lint/complexity/noStaticOnlyClass: 🐧
export class Keys {
	static readonly parserMetadata = Symbol('ParserMetadata');
	static readonly parserConfig = Symbol('ParserConfig');

	static readonly resolverSubCommands = Symbol('Subcommands');
	static readonly resolverIsShortcut = Symbol('IsShortcut');
	/** fallbackSubcommandName */
	static readonly resolverFallbackSubCommand = Symbol('FallbackSubcommandName');

	static readonly clientResolverMetadata = Symbol('ResolverMetadata');
	static readonly clientResolverAlreadyModdedEvents = Symbol('YunaMessageWatcherController');
	static readonly clientWatcherController = Symbol('YunaMessageWatcherController');

	static readonly watcherRawCommandRun = Symbol('WatcherRawCommandRun');

	static readonly watcherStop = Symbol('WatcherStop');

	static readonly messageArgsResult = Symbol();
}

export type Instantiable<C> = { new (...args: any[]): C };
export type AvailableClients = UsingClient | Client | WorkerClient;

export type ArgPosition = [number, number];
export type ArgsResultPositions = Record<string, ArgPosition>;
export type ArgsResult = Record<string, string>;

export interface ArgsResultMetadata {
	content: string;
	result: ArgsResult;
	positions: ArgsResultPositions;
}

export type CommandUsable = (Command | SubCommand) & {
	[Keys.watcherRawCommandRun]?: (Command | SubCommand)['run'];
};

export type YunaCommandUsable<T extends CommandUsable = CommandUsable> = T & {
	[Keys.watcherRawCommandRun]?: T['run'];
	[Keys.parserConfig]?: YunaParserCreateOptions;
	[Keys.resolverSubCommands]?: { fallback?: Instantiable<SubCommand> | null; fallbackName?: string } | null;
	[Keys.resolverIsShortcut]?: boolean;

	constructor: {
		prototype: {
			[Keys.parserMetadata]?: YunaParserCommandMetaData;
		};
	};
};

export interface YunaGroupType {
	name?: [language: LocaleString, value: string][];
	description?: [language: LocaleString, value: string][];
	defaultDescription?: string;
	aliases?: string[];
	/**
	 * ### Yuna's Text Shortcuts
	 * They allow you to access to a group more easily,
	 * as if it were a normal command.
	 * @example
	 * ```
	 *  // normal way to access
	 *  fun music play
	 *  // can now be accessed as
	 *  music play
	 * ```
	 * @requires Yuna.resolver to work.
	 */
	shortcut?: boolean;
	/**
	 * Allows you to set a subcommand that will be used when one is not found.
	 * if not set the first subcommand of this group will be used.
	 *
	 * use `null` to disable this option for this group.
	 * @requires  Yuna.resolver to work.
	 */
	fallbackSubCommand?: Instantiable<SubCommand> | string | null;
}
