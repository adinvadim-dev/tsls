# CLI contract, version 2

`tsls [host-label...] [--discover | --config PATH] [--strict] [--json | --plain] [--timeout SECONDS] [--concurrency COUNT] [--no-color]`

`tsls init [--config PATH]` is optional: creates an explicit local-only config with exclusive file creation and mode 0600. Snapshots never write config. `init` is reserved as a configured host label. Help overrides all arguments; --version prints the package version. Repeated selected labels query a node once, in config/discovery order. Unknown labels and unsupported options exit2 without a snapshot.

| Option | Type/default | Contract |
| --- | --- | --- |
| `--discover` | boolean / false | bypass tsls config and TSLS_CONFIG; local + Tailscale; incompatible with --config |
| `--strict` | boolean / false | require complete coverage, including skipped peers and available discovery/mapping |
| `--config` | absolute path | TSLS_CONFIG, then XDG/default file; absent implicit default enables discovery |
| `--timeout` | integer / 5 | per-host seconds, 1–120; TSLS_TIMEOUT; remaining global budget wins |
| `--concurrency` | integer / 8 | simultaneous probes, 1–32; TSLS_CONCURRENCY |
| `--json` | boolean / false | JSON schemaVersion 2 |
| `--plain` | boolean / false | TSV, no ANSI, header even on partial failure |
| `--no-color` | boolean | no ANSI; currently all output is uncolored |

[Discovery/config precedence and budgets](discovery.md) define source selection. Existing valid configs retain their explicit host sets. Explicit missing or malformed/unreadable configuration is an error. No project config, implicit credential lookup, network scanning, guessed Unix accounts or interactive authentication. Config targets accept safe aliases/hostnames, optionally user@host. IPv6 discovered addresses are validated; explicit IPv6/ports can use SSH aliases. Config permits up to 100 hosts; snapshot probe cap is 32 and excess selected rows are explicitly skipped, causing exit1 for explicit sets.

JSON: `{schemaVersion: 2, startedAt, finishedAt, discovery, coverage, hosts}`. Discovery includes source (`config`, `tailscale`, `local`), status (`ok`, `unavailable`, `invalid`), fixed diagnostic message or null, aliasesLimited and duplicatesIgnored. Coverage includes seen, remoteCount (unknown/null outside successful discovery), selected, attempted, succeeded, failed, skipped, complete, limits. Completeness is for the selected set and discovery/mapping availability, not an assertion that every possible remote login was tried.

Each host has label, peerId, tailscaleOs, transport, online, lastSeen, startedAt, finishedAt, durationMs, status, metrics and error. Metadata not supplied by Tailscale is null. Status is `ok`, `offline`, `error` or `skipped`. Success has error:null; failures/skips have metrics:null and error:{code,message}. Codes: timeout, unreachable, host_key, authentication, transport, probe, cancelled, unsupported_os, offline_peer, invalid_target, probe_limit, snapshot_timeout. `skipped` never starts a metrics probe. Alias inspection is local `ssh -G`, not a remote probe. Duplicate physical peers are deduplicated by ID and counted separately.

Metrics: `{os, memory: {total, free, available}, disk: {mount, total, free, available}}`, OS `linux` or `macos`. Each metric is `{bytes: nonnegative integer | null, source: string, quality: "reported" | "unknown"}`. Source describes native counters; source/message text is informational. New object fields may be added within schema version 2. Existing fields, units, null semantics and enum values remain stable. Consumers should tolerate additional fields.

TSV header, in fixed order:

```text
label status ram_free_bytes ram_available_bytes ram_total_bytes disk_available_bytes disk_total_bytes error_code
```

Separators are literal tabs, with a newline after each row. Unknown cells are empty. Labels cannot contain control characters. No mount paths or free-form diagnostics enter TSV.

Human output shows RAM free/total and RAM available in binary GiB, disk available/total in decimal GB, and status. A legend explains the units and `-` for unknown. Successful macOS readings include a note that free RAM excludes reclaimable memory and available RAM is unknown. These explanatory lines are human-only; JSON and TSV contracts are unchanged.

Local/remote metric probes use LC_ALL=C, bounded 256 KiB stdout+stderr and a fixed read-only program. SSH uses one connection attempt, strict host checking, batch mode, disabled askpass/display and no TTY. Alias scanning is bounded; standard OpenSSH owns effective identity/login, including ProxyJump. Host labels are ASCII-sanitized and disambiguated before output. Discovered raw names and stderr cannot inject terminal controls.

Ordinary discovery returns 0 if local succeeds, despite expected unavailable peers; complete=false exposes partial coverage. Explicit sets/positional selection require all selected rows to succeed. --strict additionally requires complete discovery/mapping. Invalid config/usage exits2; required coverage failure exits1; Ctrl-C/SIGTERM exits130 and suppresses the unfinished snapshot. On deadline, completed observations survive, active probes fail and queued probes are skipped. Client-clock timestamps bracket collection; values are not simultaneous.
