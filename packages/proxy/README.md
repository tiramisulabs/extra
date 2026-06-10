# @slipher/proxy

REST proxy for Seyfert using [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js).

## Install

```sh
pnpm add @slipher/proxy
```

## Usage

```ts
import { createProxy } from '@slipher/proxy';

const { app, result } = await createProxy({
	port: 4444,
	token: process.env.DISCORD_TOKEN!,
	baseUrl: '/api',
});

if (!result) {
	throw new Error('Proxy failed to listen.');
}
```

Requests must include the same bot token used by the proxy:

```http
Authorization: Bot <token>
```

The proxy forwards the method, route, query string, JSON body, files, and `x-audit-log-reason` header to Seyfert's `ApiHandler`. Pass `rest` when you already have an `ApiHandler` instance, or `app` when you want to mount the proxy onto an existing uWebSockets app.

## Request Bodies

`GET` and `DELETE` requests are forwarded without reading a body.

For other methods:

- `multipart/form-data` bodies are parsed with uWebSockets `getParts()`.
- Other content types are parsed as JSON objects.
- Missing `content-type` skips the multipart path and is handled as JSON.
- Malformed JSON or non-object JSON returns `400`.

File fields use the field name as `filename`, then the uploaded filename, then a generated `file-<index>` fallback.

## Development

```sh
pnpm --filter @slipher/proxy test
pnpm --filter @slipher/proxy build
```
