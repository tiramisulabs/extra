import { assert, describe, test } from 'vitest';
import { createServiceCredential, hashServiceCredential } from '../src';
import { createCredentialAuthenticator } from '../src/credentials';

describe('service credentials', () => {
	test('authenticates hashed credentials and supports rotation', () => {
		const first = createServiceCredential('workers');
		const second = createServiceCredential('workers');
		const authenticate = createCredentialAuthenticator([first.hash, second.hash]);

		assert.equal(authenticate(first.credential), 'workers');
		assert.equal(authenticate(second.credential), 'workers');
		assert.equal(authenticate('wrong'), undefined);
		assert.notEqual(first.hash, hashServiceCredential('workers', first.credential));
	});

	test('rejects malformed and empty configuration', () => {
		assert.throws(() => createCredentialAuthenticator([]), /at least one/);
		assert.throws(() => createCredentialAuthenticator(['plaintext']), /invalid service credential hash/);
		assert.throws(() => createServiceCredential(''), /serviceId/);
	});
});
