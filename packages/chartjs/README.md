# @slipher/chartjs

Render Chart.js charts to image buffers with `@napi-rs/canvas`.

**[Read the complete Chart.js guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/chartjs).**

## Install

```sh
pnpm add @slipher/chartjs
```

## Quick start

```ts
import { NapiChartjsCanvas } from '@slipher/chartjs';

const canvas = new NapiChartjsCanvas({ width: 800, height: 400 });
const image = canvas.renderToBuffer({
	type: 'bar',
	data: {
		labels: ['Ready', 'Queued'],
		datasets: [{ data: [8, 3] }],
	},
});
```
