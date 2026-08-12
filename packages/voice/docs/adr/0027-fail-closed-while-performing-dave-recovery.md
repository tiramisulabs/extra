# Fail closed while performing DAVE recovery

The package will follow DAVE's explicit recovery procedure for an invalid MLS commit or welcome: report it with Voice Gateway opcode 31, reset the local MLS group and its derived verification state, and send a fresh key package. The same local reset and fresh key-package flow applies whenever the Voice Gateway announces that a group is being created or re-created with epoch 1. Either reset makes `voicePrivacyCode` null and pairwise verification unavailable until a new MLS group is established.

During initial establishment the Voice Connection remains `connecting`; after it has been operational it enters `recovering`. It can return to `ready` only when the DAVE context required by the currently negotiated protocol version is operational again.

The DAVE Engine never chooses protocol version 0 as a fallback from a nonzero version. A transport-only session is valid only when the Voice Gateway selects version 0 or executes an official transition to it. Unsupported selected versions, invalid Voice Gateway identity or signature material, and irrecoverable failures in the local Cryptographic Provider are terminal `VOICE_PROTOCOL_ERROR` failures and use the connection-destruction policy.

This distinguishes a recovery path mandated by DAVE from failures that cannot be made safe locally. Destroying the connection for every invalid commit or welcome would make it less resilient than the protocol requires; silently continuing without the selected E2EE context would make `ready` misleading and weaken the server-negotiated security level.
