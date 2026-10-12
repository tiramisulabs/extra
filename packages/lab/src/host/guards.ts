import type { IncomingMessage } from 'node:http';

function isLoopbackAuthority(value: string | undefined): boolean {
	return !!value && /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(value);
}

/** Local mode: the Host header and any Origin must name a loopback address, which blocks DNS rebinding and cross-site calls. */
export function isLocalRequest(req: IncomingMessage): boolean {
	if (!isLoopbackAuthority(req.headers.host)) return false;
	if (!req.headers.origin) return true;
	try {
		const origin = new URL(req.headers.origin);
		return (origin.protocol === 'http:' || origin.protocol === 'https:') && isLoopbackAuthority(origin.host);
	} catch {
		return false;
	}
}

/**
 * Hosted mode: requests must target the public origin. Navigations may arrive from anywhere, but writes need a
 * same-origin Origin header and API reads reject cross-site fetch metadata.
 */
export function isPublicOriginRequest(req: IncomingMessage, publicOrigin: URL, pathname: string): boolean {
	const { host, origin, 'sec-fetch-site': fetchSite } = req.headers;
	if (host?.toLowerCase() !== publicOrigin.host.toLowerCase()) return false;
	if (origin !== undefined && origin !== publicOrigin.origin) return false;
	if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== publicOrigin.origin) return false;
	return !pathname.startsWith('/api/') || fetchSite === undefined || fetchSite === 'same-origin';
}
