import type { ChartConfiguration, Chart as ChartJS } from 'chart.js/auto';
import { type Canvas, createCanvas } from '@napi-rs/canvas';
import { freshRequire } from './freshRequire';
import { BackgroundColourPlugin } from './backgroundcolorplugin';
import type { ChartJSNapiRSCanvasOptions } from './options';

export class NapiChartjsCanvas {
	_chartJs: typeof ChartJS;

	constructor(public options: ChartJSNapiRSCanvasOptions) {
		this._chartJs = this.initialize(options);
	}

	private initialize(options: ChartJSNapiRSCanvasOptions): typeof ChartJS {
		const chartJs: typeof ChartJS = require('chart.js/auto');

		if (options.plugins?.requireChartJSLegacy) {
			for (const plugin of options.plugins.requireChartJSLegacy) {
				freshRequire(plugin);
				delete require.cache[require.resolve(plugin)];
			}
		}

		if (options.plugins?.globalVariableLegacy) {
			(global as any).Chart = chartJs;
			for (const plugin of options.plugins.globalVariableLegacy) {
				freshRequire(plugin);
			}
			delete (global as any).Chart;
		}

		if (options.plugins?.modern) {
			for (const plugin of options.plugins.modern) {
				if (typeof plugin === 'string') {
					chartJs.register(freshRequire(plugin));
				} else {
					chartJs.register(plugin);
				}
			}
		}

		if (options.plugins?.requireLegacy) {
			for (const plugin of options.plugins.requireLegacy) {
				chartJs.register(freshRequire(plugin));
			}
		}

		if (options.chartCallback) {
			options.chartCallback(chartJs);
		}

		if (options.backgroundColour) {
			chartJs.register(new BackgroundColourPlugin(options.width, options.height, options.backgroundColour));
		}

		delete require.cache[require.resolve('chart.js')];

		return chartJs;
	}

	renderChart(configuration: ChartConfiguration) {
		const canvas = createCanvas(this.options.width, this.options.height);
		configuration.options ??= {};
		configuration.options.responsive = false;
		configuration.options.animation = false;
		return new this._chartJs(canvas.getContext('2d') as any, configuration) as any as Omit<ChartJS, 'canvas'> & {
			canvas: Canvas;
		};
	}

	renderToBuffer(configuration: ChartConfiguration) {
		const chart = this.renderChart(configuration);
		return (chart.canvas as any as Canvas).toBuffer('image/png');
	}
}
