# Arbitrate one local operation per guild

The Voice Plugin will serialize at most one local connect, move, or disconnect operation for each guild without exposing or maintaining a command queue. Requests with the same effective intent share the in-flight promise. A second movement to a different destination fails as a conflict, repeated disconnects share the leave operation, and `connect()` fails while a disconnect is awaiting Discord confirmation.

`disconnect()` has local precedence: it cancels and rejects any pending connect or move and stops transport recovery before requesting the authoritative leave. An explicitly authorized move may replace transport recovery but cannot replace a disconnect. Discord's main-Gateway events remain authoritative over every local operation, and operation generations prevent late payloads, timers, or transport completions from mutating newer state.
