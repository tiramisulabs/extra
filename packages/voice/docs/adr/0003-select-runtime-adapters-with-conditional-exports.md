# Select runtime adapters with conditional exports

Consumers will import the same `@slipher/voice` API on every supported runtime. Package export conditions will select thin Node.js, Bun, or Deno adapters, while the protocol and DAVE implementation remains shared and runtime-neutral. Provider substitution is limited to internal test seams and is not a public API for specialized environments; public runtime-specific import paths and global-based runtime detection are not the normal integration path.
