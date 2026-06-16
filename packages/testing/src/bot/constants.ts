// Real (numeric-string) snowflakes so the defaults survive BigInt-based seyfert helpers (avatarURL, createdAt,
// timestamp decoding) the way a real id does. Distinct from the mockId() generated range to avoid collisions.

/** Default bot user id used by createMockBot when none is given. */
export const TEST_BOT_ID = '900000000000000001';

/** Default application id used by createMockBot and the payload builders. */
export const TEST_APPLICATION_ID = '900000000000000002';

/** Default guild id used when interaction dispatch omits guildId. */
export const TEST_GUILD_ID = '900000000000000003';

/** Default channel id used when interaction or message dispatch omits a channel. */
export const TEST_CHANNEL_ID = '900000000000000004';

/** Id of the bot's single default test user (MockBot.defaultUser). */
export const TEST_USER_ID = '900000000000000005';
