export function requireOptionalModule(id: string, message: string) {
	if (typeof require !== 'function') {
		throw new Error(message);
	}

	try {
		return require(id);
	} catch (error) {
		const missing = error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND';

		if (missing) {
			throw new Error(message);
		}

		throw error;
	}
}
