# Keep one stable connection per guild

Each Voice Plugin instance will own at most one stable `VoiceConnection` per guild, with no process-global registry. Reconnection, endpoint replacement, DAVE epoch changes, and channel movement replace resources inside that connection instead of replacing its public identity, allowing application code and media plugins to retain valid references. Replaced resource generations must not let late events mutate the current connection.
