import { createMediaTrack, type MediaProvider, type MediaResource, type MediaTrack } from '@slipher/player';
import { demuxWebmOpus, type VoicePlaybackSource } from '@slipher/voice';
import { type Payload, youtubeDl } from 'youtube-dl-exec';

const YOUTUBE_OPUS_FORMAT = 'bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]';
const preparedResources = new Map<string, MediaResource>();
const resolvedMedia = new WeakMap<MediaTrack, YoutubeMedia>();

interface YoutubeMedia {
	readonly url: string;
	readonly headers: Headers;
}

export async function prepareYoutubeTrack(
	track: MediaTrack,
	signal: AbortSignal,
): Promise<{ discard(): Promise<void> }> {
	if (track.provider !== 'youtube') {
		throw new TypeError('Only YouTube tracks can be prepared by this provider.');
	}
	const media = resolvedMedia.get(track);
	resolvedMedia.delete(track);
	const resource = await openYoutubeResource(track, signal, media);
	preparedResources.set(track.identifier, resource);

	return {
		async discard() {
			if (preparedResources.get(track.identifier) !== resource) return;
			preparedResources.delete(track.identifier);
			await resource.close();
		},
	};
}

export const youtubeProvider: MediaProvider = {
	name: 'youtube',
	async resolve(input, { signal }) {
		const result = await youtubeDl(
			input,
			{
				dumpSingleJson: true,
				format: YOUTUBE_OPUS_FORMAT,
				noPlaylist: true,
				noWarnings: true,
				skipDownload: true,
			},
			{ signal },
		);

		if (typeof result === 'string') throw new TypeError('yt-dlp did not return YouTube metadata.');
		if (result.is_live) throw new TypeError('This minimal provider does not support YouTube live streams.');

		const track = createMediaTrack({
			provider: 'youtube',
			identifier: `${result.id}:${crypto.randomUUID()}`,
			title: result.title,
			author: result.uploader,
			uri: result.webpage_url,
			artworkUrl: result.thumbnail,
			format: 'webm-opus',
			timeline: {
				kind: 'finite',
				durationMs: result.duration * 1_000,
				seekable: false,
			},
		});
		resolvedMedia.set(track, selectedYoutubeMedia(result));

		return {
			kind: 'track',
			track,
		};
	},
	async open(track, { signal }) {
		const prepared = preparedResources.get(track.identifier);
		if (!prepared) return openYoutubeResource(track, signal);
		preparedResources.delete(track.identifier);
		return prepared;
	},
};

async function openYoutubeResource(
	track: MediaTrack,
	signal: AbortSignal,
	resolved?: YoutubeMedia,
): Promise<MediaResource> {
	if (!track.uri) throw new TypeError('A YouTube track must include its webpage URL.');

	const media = resolved ?? (await resolveYoutubeMedia(track.uri, signal));

	signal.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener('abort', abort, { once: true });
	const response = await fetch(media.url, {
		headers: media.headers,
		signal: controller.signal,
	}).catch(error => {
		signal.removeEventListener('abort', abort);
		throw error;
	});
	if (!response.ok || !response.body) {
		signal.removeEventListener('abort', abort);
		controller.abort();
		throw new Error(`YouTube media request failed with status ${response.status}.`);
	}

	const iterator = demuxWebmOpus(response.body)[Symbol.asyncIterator]();
	const first = await iterator
		.next()
		.catch(error => {
			controller.abort();
			throw error;
		})
		.finally(() => signal.removeEventListener('abort', abort));
	if (first.done) {
		controller.abort();
		throw new TypeError('The YouTube stream did not contain an Opus packet.');
	}

	let returned = false;
	const returnIterator = async () => {
		if (returned || !iterator.return) return;
		returned = true;
		await iterator.return();
	};
	let consumed = false;
	const packets: VoicePlaybackSource = {
		async *[Symbol.asyncIterator]() {
			if (consumed) throw new TypeError('A prepared YouTube stream can only be consumed once.');
			consumed = true;
			try {
				yield first.value;
				for (;;) {
					const packet = await iterator.next();
					if (packet.done) return;
					yield packet.value;
				}
			} finally {
				await returnIterator();
			}
		},
	};

	return {
		packets,
		async close() {
			try {
				await returnIterator();
			} finally {
				controller.abort();
			}
		},
	};
}

async function resolveYoutubeMedia(input: string, signal: AbortSignal): Promise<YoutubeMedia> {
	const result = await youtubeDl(
		input,
		{
			dumpSingleJson: true,
			format: YOUTUBE_OPUS_FORMAT,
			noPlaylist: true,
			noWarnings: true,
			skipDownload: true,
		},
		{ signal },
	);
	if (typeof result === 'string') throw new TypeError('yt-dlp did not return YouTube media metadata.');
	return selectedYoutubeMedia(result);
}

function selectedYoutubeMedia(result: Payload): YoutubeMedia {
	const selected = result.formats.find(format => format.format_id === result.format_id);
	if (!selected?.url.trim()) {
		throw new TypeError('yt-dlp did not return a playable YouTube media URL.');
	}

	const headers = new Headers();
	for (const [name, value] of Object.entries(selected.http_headers)) {
		headers.set(name, String(value));
	}
	return { url: selected.url.trim(), headers };
}
