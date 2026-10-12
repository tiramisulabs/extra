# Discord visual reference

Reference captured on 2026-10-12 from the Discord web client, stable build 634304
(`17e01cf978c3c10a5688429a38db59a4926e8982`). The lab targets the Onyx theme,
default density, 16 px chat text and cozy message layout. Lab instrumentation
retains its amber accent.

The CSS values are adapted to the lab's semantic class names, rather than loading
Discord's complete stylesheets or depending on its generated class names. The
font files are bundled with the UI; running the lab does not fetch Discord assets.

## Sources

| Surface | Source stylesheet | SHA-256 at capture |
| --- | --- | --- |
| Fonts and theme tokens | [Discord CSS](https://discord.com/assets/952007.3b490a4a037fd35b.css) | `cc0b5768c69332c1964fb2bf82329dad403ab63d5059cf33b99c86475912ea22` |
| Markdown | [Discord CSS](https://discord.com/assets/457428.24d2fb1a1a72df80.css) | `8c0d558b56d454813d35853f7c34de9e0bf2774c70e1cd40eaefc761d5517ff4` |
| Embeds | [Discord CSS](https://discord.com/assets/198496.7ea2af35bfe94977.css) | `6653204a44db51db1cca53ae498d829b1188aae412f9e7787e2915667137c9e2` |
| Buttons and modal shell | [Discord CSS](https://discord.com/assets/193433.6c7be9d5d6e8b51f.css) | `08e410da21d9ee31496ae6f55981de3b0232de0b23f5caa8d52a119e9b0ec170` |
| Select menus | [Discord CSS](https://discord.com/assets/775417.b73ff466a40423a8.css) | `2c2d9eeb677cfd783664034762e64c2fc6533a25876c5eb216fd87f4f40a28bc` |

Message geometry was also measured in the authenticated client: 40 px avatars,
16 px gutter, 16 px gap, 22 px line height, 17 px group spacing and 2 px vertical
padding. Modal shell tokens: 442 px width, 24 px horizontal padding, 16 px vertical
padding and 12 px corner radius. Select input height: 40 px.

To update this reference, compare the same content, theme, density and viewport
before changing tokens or component geometry. Check desktop and narrow layouts,
open selects, disabled controls, focus states, overflowing modals and file inputs.
Unsupported features remain explicit; matching these styles does not establish
pixel parity for every Discord feature or state.
