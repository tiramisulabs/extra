# Use a manager-scoped ephemeral DAVE identity

The Voice Manager will own an ephemeral ECDSA P-256 DAVE signature keypair for its current set of active protocol media sessions. It generates the identity when acquiring the first DAVE session, reuses it across every concurrently active Voice Gateway connection and transport recovery, and erases its private material after the last DAVE session releases it. Movement into a new protocol call reacquires identity under the same active-session consistency rule.

The package will not expose persistent-key injection or claim persistent verification for bots. Discord's persistent identity flow requires secure local storage, an authenticated session identifier, and public-key registration that is not documented as a bot API contract. Ephemeral pairwise and epoch verification data may be exposed when the verification surface is designed.
