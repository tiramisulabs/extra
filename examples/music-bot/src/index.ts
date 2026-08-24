import 'dotenv/config';

import { player } from '@slipher/player';
import { voice } from '@slipher/voice';
import { Client, definePlugins, type ParseClient } from 'seyfert';
import { youtubeProvider } from './youtube-provider.js';

const plugins = definePlugins(voice(), player({ providers: [youtubeProvider] }));

const client = new Client({
	plugins,
	commands: {
		prefix: () => ['!'],
		reply: () => true,
		deferReplyResponse: () => ({ content: 'Loading...' }),
	},
});

await client.start();

declare module 'seyfert' {
	interface SeyfertRegistry {
		client: ParseClient<Client<true>>;
		plugins: typeof plugins;
	}

	interface InternalOptions {
		withPrefix: true;
	}
}
