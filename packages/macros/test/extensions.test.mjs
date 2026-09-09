test('CustomId matches before the user filter and dispatches with per-interaction parameters', async () => {
	const root = inject('consumer');
	const { Client } = require(path.join(root, 'node_modules/seyfert/lib/index.js'));
	const { ComponentHandler } = require(path.join(root, 'node_modules/seyfert/lib/components/handler.js'));
	const { UserButton, PageButton } = await import(pathToFileURL(path.join(root, 'dist/user-button.js')));
	const { CustomId } = await import(pathToFileURL(path.join(root, 'dist/custom-id.js')));
	const button = new UserButton();
	const client = new Client();
	for (const [customId, matches] of [
		['other:123', false],
		['user:', false],
		['user:123:extra', false],
		['user:denied', false],
		['user:123', true],
		['user:456', true],
	]) {
		const context = { client, customId, metadata: {}, globalMetadata: {} };
		expect(await button._filter(context), customId).toBe(matches);
		if (matches) await ComponentHandler.prototype.execute.call({ client }, button, context);
	}
	expect(button.seen).toEqual(['denied', '123', '456']);
	expect(button.results).toEqual(['123', '456']);
	const page = new PageButton();
	const pageContext = { customId: 'page::42::user::123' };
	expect(page._filter(pageContext)).toBe(true);
	expect(page.run(pageContext)).toEqual(['42', '123']);
	expect(page._filter({ customId: 'page:42:user:123' })).toBe(false);
	expect(() => CustomId('user:{id}', '')).toThrow('separator must not be empty');
	for (const pattern of ['user:{id}:{id}', 'user:{id', 'user:x{id}']) {
		expect(() => CustomId(pattern)).toThrow();
	}
	const javascript = fs.readFileSync(path.join(root, 'dist/custom-id.js'), 'utf8');
	expect(javascript).not.toContain('@slipher/macros');
});

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, inject, test } from 'vitest';

const require = createRequire(import.meta.url);
