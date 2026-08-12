# Own the DAVE MLS profile

`@slipher/voice` will implement DAVE and the MLS behavior and wire formats it requires in TypeScript instead of delegating them to Davey, libdave, or a general-purpose MLS implementation. Audited libraries or runtime facilities may supply cryptographic primitives through an internal provider boundary; implementing those algorithms is not part of owning the protocol. This preserves runtime portability and protocol-level control without taking on avoidable cryptographic implementation risk.
