import { describe, expect, test } from 'vitest';
import * as testing from '../src';

describe('payload factories', () => {
	test('no-argument resource factories produce usable codes and distinct snowflakes', () => {
		const resources = [
			testing.apiEmoji(),
			testing.apiInvite(),
			testing.apiAutoModRule(),
			testing.apiWebhook(),
			testing.apiSticker(),
			testing.apiScheduledEvent(),
			testing.apiGuildTemplate(),
			testing.apiSoundboardSound(),
			testing.apiStageInstance(),
			testing.apiAuditLogEntry(),
		];
		const snowflakes: string[] = [];
		for (const resource of resources) {
			if ('code' in resource) {
				expect(resource.code).toMatch(/\S/);
				continue;
			}
			const id = 'sound_id' in resource ? resource.sound_id : resource.id;
			expect(id).toMatch(/^\d{17,20}$/);
			snowflakes.push(id);
		}
		expect(new Set(snowflakes).size).toBe(snowflakes.length);
	});

	test('apiAttachment can express "no content type" without a cast', () => {
		expect(testing.apiAttachment().content_type).toBe('image/png');
		expect(testing.apiAttachment({ contentType: 'application/pdf' }).content_type).toBe('application/pdf');
		// optional on the wire, so an explicit undefined drops the key instead of being defaulted back —
		// "attachment with no content type" is exactly what content-type validation exists to reject
		expect(testing.apiAttachment({ contentType: undefined })).not.toHaveProperty('content_type');
	});
});
