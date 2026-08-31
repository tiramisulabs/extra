import type { SeyfertPlugin } from 'seyfert';
import { expectTypeOf, test } from 'vitest';
import { type CacheIntegrityPlugin, cacheIntegrity } from '../src';

test('exports a zero-configuration Seyfert plugin factory', () => {
	expectTypeOf(cacheIntegrity).parameters.toEqualTypeOf<[]>();
	expectTypeOf(cacheIntegrity()).toMatchTypeOf<SeyfertPlugin>();
	expectTypeOf(cacheIntegrity()).toEqualTypeOf<CacheIntegrityPlugin>();
});
