// Discord message flag bits the mock reasons about, named once so no caller mis-keys a raw `& 64`.

/** `EPHEMERAL` (1 << 6): the message is only visible to the invoking user and is not part of the channel. */
export const MESSAGE_FLAG_EPHEMERAL = 1 << 6;

/** `IS_COMPONENTS_V2` (1 << 15): the body uses the components-v2 tree and forbids top-level content/embeds. */
export const MESSAGE_FLAG_COMPONENTS_V2 = 1 << 15;

/** Whether a message carries the ephemeral flag. */
export const isEphemeral = (message: { flags?: number }): boolean =>
	((message.flags ?? 0) & MESSAGE_FLAG_EPHEMERAL) !== 0;
