import { PREFIX } from './format';
export const STORE_KIND = 'store';
export function describe(): string {
	return `${PREFIX}-${STORE_KIND}`;
}
