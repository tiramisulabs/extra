import type { JsonValue } from '../index';

// Mock-bot state can hold bigints (permission bitfields); JSON carries them as decimal strings.
const bigintAsString = (_key: string, value: unknown): unknown =>
	typeof value === 'bigint' ? value.toString() : value;

/**
 * Deep-copies mock-bot state or plain data as JSON, so later mutation of either side cannot leak into the other.
 * `T` names the shape the JSON form has; it defaults to any JSON value.
 */
export const toJson = <T = JsonValue>(value: unknown): T => JSON.parse(JSON.stringify(value, bigintAsString));
