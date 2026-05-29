export class FakeClock {
	private current: number;

	constructor(now = 0) {
		this.current = now;
	}

	now = () => this.current;

	date = () => new Date(this.current);

	set(value: number | Date): this {
		this.current = value instanceof Date ? value.getTime() : value;
		return this;
	}

	advance(milliseconds: number): this {
		this.current += milliseconds;
		return this;
	}

	advanceSeconds(seconds: number): this {
		return this.advance(seconds * 1000);
	}
}
