import { describe, expect, test } from 'vitest';
import {
	apiAuditLogEntry,
	apiAutoModRule,
	apiEmoji,
	apiGuildTemplate,
	apiInvite,
	apiScheduledEvent,
	apiSoundboardSound,
	apiStageInstance,
	apiSticker,
	apiWebhook,
} from '../src';

// These public payload factories were only exercised transitively through REST/world flows; this pins the
// factory contract directly so a regression to a default shape fails AT the factory.
const FACTORIES = [
	['apiEmoji', apiEmoji],
	['apiInvite', apiInvite],
	['apiAutoModRule', apiAutoModRule],
	['apiWebhook', apiWebhook],
	['apiSticker', apiSticker],
	['apiScheduledEvent', apiScheduledEvent],
	['apiGuildTemplate', apiGuildTemplate],
	['apiSoundboardSound', apiSoundboardSound],
	['apiStageInstance', apiStageInstance],
	['apiAuditLogEntry', apiAuditLogEntry],
] as const satisfies readonly [string, (options?: never) => object][];

describe('payload factories', () => {
	test.each(FACTORIES)('%s() returns a populated object with no args', (_name, factory) => {
		const result = factory();
		expect(result).toBeTypeOf('object');
		expect(result).not.toBeNull();
		expect(Object.keys(result).length).toBeGreaterThan(0);
	});
});
