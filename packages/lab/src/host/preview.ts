import type { Preset } from '../index';
import { isRecord, validatePreset } from '../protocol';

export interface PullRequestPreview {
	body: string;
	headRefOid: string;
}

/** @internal Only a named JSON fence is executable configuration; other fences are documentation. */
export function pullRequestPreset(source: PullRequestPreview, revision: string | undefined): Preset | undefined {
	if (!isRecord(source) || typeof source.body !== 'string' || !/^[a-f0-9]{40}$/.test(source.headRefOid))
		throw new TypeError('Expected a PR snapshot with body and headRefOid from gh pr view');
	if (source.headRefOid !== revision) throw new Error('PR headRefOid does not match build.revision');
	const lines = source.body.replace(/\r\n/g, '\n').split('\n');
	let preset: Preset | undefined;
	for (let i = 0; i < lines.length; i++) {
		const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		if (!opening) continue;
		const fence = opening[1];
		const named = opening[2].trim() === 'json slipher-lab';
		const content: string[] = [];
		let closed = false;
		while (++i < lines.length) {
			const ending = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
			if (ending && ending[1][0] === fence[0] && ending[1].length >= fence.length) {
				closed = true;
				break;
			}
			if (named) content.push(lines[i]);
		}
		if (!named) continue;
		if (!closed) throw new Error('Unclosed slipher-lab JSON fence');
		if (preset) throw new Error('The PR must contain at most one slipher-lab JSON fence');
		const parsed: unknown = JSON.parse(content.join('\n'));
		validatePreset(parsed);
		for (const key of Object.keys(parsed))
			if (!['scenario', 'setup', 'params', 'services', 'refs'].includes(key))
				throw new TypeError(`Unknown PR preset field "${key}"`);
		preset = parsed;
	}
	return preset;
}
