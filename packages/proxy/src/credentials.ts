import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const prefix = 'slipher.proxy.v1';

export interface ServiceCredential {
	credential: string;
	hash: string;
}

interface ParsedCredentialHash {
	serviceId: string;
	salt: Buffer;
	digest: Buffer;
}

function validateServiceId(serviceId: string): void {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serviceId)) {
		throw new TypeError('serviceId must contain 1 to 128 safe identifier characters.');
	}
}

function validateCredential(credential: string): void {
	if (!credential) throw new TypeError('credential must not be empty.');
}

function digestCredential(credential: string, salt: Buffer): Buffer {
	return createHash('sha256').update(salt).update(credential).digest();
}

export function hashServiceCredential(serviceId: string, credential: string): string {
	validateServiceId(serviceId);
	validateCredential(credential);
	const salt = randomBytes(16);
	const digest = digestCredential(credential, salt);
	return `${prefix}.${Buffer.from(serviceId).toString('base64url')}.${salt.toString('base64url')}.${digest.toString('base64url')}`;
}

export function createServiceCredential(serviceId: string): ServiceCredential {
	const credential = randomBytes(32).toString('base64url');
	return { credential, hash: hashServiceCredential(serviceId, credential) };
}

function parseCredentialHash(value: string): ParsedCredentialHash {
	const encoded = value.startsWith(`${prefix}.`) ? value.slice(prefix.length + 1).split('.') : [];
	if (encoded.length !== 3 || encoded.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
		throw new TypeError('credentials contains an invalid service credential hash.');
	}
	const [encodedServiceId, encodedSalt, encodedDigest] = encoded;
	const serviceId = Buffer.from(encodedServiceId, 'base64url').toString();
	const salt = Buffer.from(encodedSalt, 'base64url');
	const digest = Buffer.from(encodedDigest, 'base64url');
	validateServiceId(serviceId);
	if (salt.byteLength !== 16 || digest.byteLength !== 32) {
		throw new TypeError('credentials contains an invalid service credential hash.');
	}
	return { serviceId, salt, digest };
}

export function createCredentialAuthenticator(hashes: readonly string[]): (credential: string) => string | undefined {
	if (hashes.length === 0) throw new TypeError('credentials must contain at least one credential hash.');
	const parsed = hashes.map(parseCredentialHash);
	return credential => {
		let serviceId: string | undefined;
		// Scan every active hash so a match does not reveal its position through early-return timing.
		for (const entry of parsed) {
			const actual = digestCredential(credential, entry.salt);
			if (timingSafeEqual(actual, entry.digest)) serviceId = entry.serviceId;
		}
		return serviceId;
	};
}
