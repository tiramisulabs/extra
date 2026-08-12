# Publish CommonJS like Seyfert

`@slipher/voice` emits CommonJS and declares `"type": "commonjs"` explicitly in its package metadata. Node already treats an untyped package as CommonJS, but Deno requires the explicit declaration (or a `.cjs` extension) to load the emitted `.js` files without unstable detection flags. The declaration preserves Seyfert's module format while making the same artifact unambiguous across the supported runtimes.

`@slipher/voice` will follow Seyfert and the existing `@slipher/*` ecosystem by publishing CommonJS rather than introducing an ESM-only package. Node.js, Bun, and Deno remain first-class tested runtimes, and conditional exports still select their runtime adapters behind one public import. Repository and consumer consistency takes precedence over using each runtime's preferred module format.
