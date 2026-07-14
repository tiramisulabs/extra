# Complete bot example

Build once, then run one master, one agent per host, and let each agent fork `worker.js`.

Required environment variables:

- master: `BOT_TOKEN`, `SCALER_TOKEN`;
- agent: `HOST_ID`, `SCALER_TOKEN`;
- worker commands: no scaler-specific variables.

For remote connections, configure the TLS variables shown in `master.ts` and `agent.ts`. `SCALER_ALLOW_INSECURE=true` is only for an explicitly trusted private overlay.

`SCALER_AUTO_REPLACE=true` opts into host-loss replacement and its network-partition overlap risk. It is disabled by default.
