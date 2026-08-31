import type { SeyfertPlugin } from 'seyfert';
import { expectTypeOf, test } from 'vitest';
import { type CacheIntegrityOptions, type CacheIntegrityPlugin, cacheIntegrity } from '../src';

test('exports a configured Seyfert plugin factory', () => {
	expectTypeOf(cacheIntegrity).parameters.toEqualTypeOf<[CacheIntegrityOptions]>();
	expectTypeOf(cacheIntegrity({ maxAge: 60_000 })).toMatchTypeOf<SeyfertPlugin>();
	expectTypeOf(cacheIntegrity({ maxAge: 60_000 })).toEqualTypeOf<CacheIntegrityPlugin>();
});
