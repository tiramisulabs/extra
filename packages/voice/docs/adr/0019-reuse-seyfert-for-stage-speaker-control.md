# Reuse Seyfert for Stage speaker control

`@slipher/voice` will establish and maintain transport for Stage channels, and a suppressed audience connection may still become `ready`. The package observes the current bot's authoritative `suppress` and `request_to_speak_timestamp` values so its media layer never transmits while Discord denies speaking permission.

The package will not duplicate Stage speaker or Stage-instance management. Consumers use Seyfert's existing `client.voiceStates.requestSpeak()` and `client.voiceStates.setSuppress()` operations, whose results are reflected through `VOICE_STATE_UPDATE`; creating or managing a Stage instance remains outside voice transport. The Voice Plugin will not automatically request to speak or unsuppress the bot because those actions require application policy and permissions.
