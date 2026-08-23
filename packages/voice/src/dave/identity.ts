import type { VoiceCryptoProvider } from '../crypto/provider';
import { signWithLabel } from '../mls/crypto';

export class DaveIdentity {
	readonly #provider: VoiceCryptoProvider;
	readonly #secretKey: Uint8Array;
	readonly #publicKey: Uint8Array;
	#closed = false;

	constructor(provider: VoiceCryptoProvider) {
		this.#provider = provider;
		const keyPair = provider.generateP256KeyPair();
		this.#secretKey = keyPair.secretKey;
		this.#publicKey = keyPair.publicKey;
	}

	get publicKey(): Uint8Array {
		this.assertOpen();
		return this.#publicKey.slice();
	}

	sign(label: string, content: Uint8Array): Uint8Array {
		this.assertOpen();
		return signWithLabel(this.#provider, this.#secretKey, label, content);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#secretKey.fill(0);
		this.#publicKey.fill(0);
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE identity is closed.');
	}
}
