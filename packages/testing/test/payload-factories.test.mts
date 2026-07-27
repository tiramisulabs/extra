import { describe, expect, test } from 'vitest';
import {
	apiAttachment,
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

	test('apiAttachment can express "no content type" without a cast', () => {
		expect(apiAttachment().content_type).toBe('image/png');
		expect(apiAttachment({ contentType: 'application/pdf' }).content_type).toBe('application/pdf');
		// optional on the wire, so an explicit undefined drops the key instead of being defaulted back —
		// "attachment with no content type" is exactly what content-type validation exists to reject
		expect(apiAttachment({ contentType: undefined })).not.toHaveProperty('content_type');
	});
});
