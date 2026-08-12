# Observe raw Gateway dispatches

The Voice Plugin will passively observe raw `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE` dispatches through Seyfert's Gateway interceptor before cache and semantic event transformation. It will synchronously enqueue relevant data and always continue the interceptor chain without modifying or vetoing packets; connection work runs outside the dispatch path so voice networking cannot block the main Gateway.
