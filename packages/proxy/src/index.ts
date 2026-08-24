export { ProxyApiHandler, type ProxyApiHandlerOptions } from './client';
export {
	createServiceCredential,
	hashServiceCredential,
	type ServiceCredential,
} from './credentials';
export {
	ProxyError,
	type ProxyErrorCode,
	type ProxyErrorEnvelope,
	type ProxyOutcome,
	type ProxyPhase,
} from './protocol';
export {
	type CreateRestForToken,
	createProxy,
	type GateOptions,
	type ProxyAuthenticationContext,
	type ProxyAuthenticationResult,
	type ProxyAuthenticator,
	type ProxyCloseOptions,
	type ProxyObservation,
	type ProxyObserver,
	type ProxyServer,
	type ProxyServerOptions,
	type ProxyStats,
} from './server';
