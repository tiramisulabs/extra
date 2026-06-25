import { STORE_KIND } from './store';
export const PREFIX = 'fmt';
export function label(s: string): string {
	return `${PREFIX}:${s}:${STORE_KIND}`;
}
