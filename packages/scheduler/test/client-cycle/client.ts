import { Client } from 'seyfert';
import plugins from './plugins';

const client = new Client({ plugins });
void client;

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}
