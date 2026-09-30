import type { JsonValue } from '../index';

// Mock-bot state can hold bigints (permission bitfields); JSON carries them as decimal strings.
const bigintAsString = (_key: string, value: unknown): unknown =>
	typeof value === 'bigint' ? value.toString() : value;

/** Converts mock-bot state into JSON data for events and snapshots. */
export const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value, bigintAsString));

/** Deep-copies plain data, so later mutation of either side cannot leak into the other. */
export const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value, bigintAsString));
