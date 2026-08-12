# Support Node.js, Bun, and Deno from v1

`@slipher/voice` will treat Node.js 22, Bun, and Deno 2 as first-class runtimes from its first release. The shared protocol, transport, and DAVE behavior must pass the same conformance suite in all three runtimes; runtime-specific capabilities such as UDP sockets and codecs may be supplied behind narrow internal provider boundaries. Support is a tested contract rather than an expectation derived from TypeScript compatibility.
