// https://github.com/jhurliman/node-rate-limiter/blob/main/src/clock.ts

// generate timestamp or delta
// see http://nodejs.org/api/process.html#process_process_hrtime
function hrtime(previousTimestamp?: [number, number]): [number, number] {
	const clocktime = performance.now() * 1e-3;
	let seconds = Math.floor(clocktime);
	let nanoseconds = Math.floor((clocktime % 1) * 1e9);
	if (previousTimestamp !== undefined) {
		seconds -= previousTimestamp[0];
		nanoseconds -= previousTimestamp[1];
		if (nanoseconds < 0) {
			seconds--;
			nanoseconds += 1e9;
		}
	}
	return [seconds, nanoseconds];
}

// The current timestamp in whole milliseconds
export function getMilliseconds(): number {
	const [seconds, nanoseconds] = hrtime();
	return seconds * 1e3 + Math.floor(nanoseconds / 1e6);
}
