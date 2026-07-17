import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const prefix = 'slipher.proxy.v1';
const saltBytes = 16;
const digestBytes = 32;
const credentialBytes = 32;

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
	const salt = randomBytes(saltBytes);
	return `${prefix}.${Buffer.from(serviceId).toString('base64url')}.${salt.toString('base64url')}.${digestCredential(credential, salt).toString('base64url')}`;
}

export function createServiceCredential(serviceId: string): ServiceCredential {
	const credential = randomBytes(credentialBytes).toString('base64url');
	return { credential, hash: hashServiceCredential(serviceId, credential) };
}

function parseCredentialHash(value: string): ParsedCredentialHash {
	const encoded = value.startsWith(`${prefix}.`) ? value.slice(prefix.length + 1).split('.') : [];
	// Buffer.from silently drops non-base64url characters, so the charset must be validated before decoding.
	if (encoded.length !== 3 || encoded.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
		throw new TypeError('credentials contains an invalid service credential hash.');
	}
	const [encodedServiceId, encodedSalt, encodedDigest] = encoded;
	const serviceId = Buffer.from(encodedServiceId, 'base64url').toString();
	const salt = Buffer.from(encodedSalt, 'base64url');
	const digest = Buffer.from(encodedDigest, 'base64url');
	validateServiceId(serviceId);
	if (salt.byteLength !== saltBytes || digest.byteLength !== digestBytes) {
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
			if (timingSafeEqual(digestCredential(credential, entry.salt), entry.digest)) serviceId = entry.serviceId;
		}
		return serviceId;
	};
}
