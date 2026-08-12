# Reject unavailable pairwise verification explicitly

`getVerificationCode(userId)` keeps its `Promise<string>` result and rejects instead of returning a nullable value. A malformed snowflake or the bot's own user ID is `VOICE_INVALID_ARGUMENT`; an already destroyed connection is `VOICE_CONNECTION_DESTROYED`; and every other legitimate inability to produce the code is `VOICE_VERIFICATION_UNAVAILABLE`.

The unavailable error carries the guild, requested user, connection status, and a reason such as `connection_not_ready`, `dave_inactive`, `participant_not_present`, `participant_changed`, or `derivation_failed`. A derivation failure also preserves its lower-level cause. The method snapshots the participant identity used as input and, after asynchronous scrypt completes, verifies that the same participant identity is still active before returning the code.

Pairwise verification is an auxiliary observation, not part of maintaining or using the negotiated media protection. Its failure therefore rejects only that request and does not destroy an otherwise operational Voice Connection.
