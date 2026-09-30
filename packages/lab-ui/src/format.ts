/** Text for an error shown to the user: an Error's message, anything else as a string. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Keeps a readable prefix of commit or content hashes and any suffix such as `-dirty-…`. */
export function shortRevision(revision: string): string {
	return revision.replace(/^((?:content-)?[0-9a-f]{7})[0-9a-f]+/i, '$1');
}
