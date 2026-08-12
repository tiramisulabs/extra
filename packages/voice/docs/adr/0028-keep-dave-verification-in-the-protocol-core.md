# Keep DAVE verification in the protocol core

The DAVE Engine will implement both verification forms defined by Discord: the 30-digit displayable code derived from the current MLS epoch authenticator and the 45-digit pairwise displayable code derived from the local and remote DAVE identity keys. These derivations belong to the protocol core because it already owns the authenticated MLS state and identity material required to produce them safely.

Pairwise verification uses the protocol's scrypt parameters and runs through an asynchronous runtime primitive so requesting a code does not synchronously block the event loop. Equivalent derivation output is a required Node, Bun, and Deno compatibility contract.

The package only supplies verification material. It does not decide that another participant is trusted, persist verification results, implement out-of-band comparison, or provide verification UI. Those actions remain application policy, and persistent verification remains unavailable while the package uses an ephemeral DAVE Identity.
