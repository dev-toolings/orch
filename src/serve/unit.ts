// The systemd user unit of `orch serve`: written by `orch install`, never
// enabled by it (OPT_IN_UNITS); `systemctl --user enable --now` is the operator's.
export const SERVE_UNIT = "orch-serve.service";

export function serveUnit(): { name: string; content: string } {
  return {
    name: SERVE_UNIT,
    content: `[Unit]
Description=orch serve, the conductor v2 engine (durable tasks, outbox)
After=network-online.target

[Service]
Type=simple
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/orch serve
Restart=on-failure
RestartSec=10
# Jobs run in detached process groups that the next engine adopts: stopping
# or restarting the engine must not kill them.
KillMode=process

[Install]
WantedBy=default.target
`,
  };
}
