# CLI contract, version 1

`tsls [host-label...] [--json | --plain] [--config PATH] [--timeout SECONDS] [--concurrency COUNT] [--no-color]`

`tsls init [--config PATH]` creates only a local-host config with exclusive file creation and mode 0600. All snapshots are read-only. `init` is reserved as a host label. `-h`/`--help` override every other argument. `--version` prints the package version. Unsupported options and unknown labels exit 2 without data. Repeated selected labels query a host once, in configuration order.

| Option | Type/default | Contract |
| --- | --- | --- |
| `--config` | absolute path | `TSLS_CONFIG`, otherwise XDG config or `~/.config/tsls/config.json` |
| `--timeout` | integer / 5 | seconds per started host, 1–120; `TSLS_TIMEOUT` |
| `--concurrency` | integer / 4 | started probes, 1–32; `TSLS_CONCURRENCY` |
| `--json` | boolean / false | one JSON object on stdout |
| `--plain` | boolean / false | TSV, no ANSI, header even on partial failure |
| `--no-color` | boolean | no ANSI; all output is currently uncolored |

Config `version` must equal 1. Labels are 1–64 ASCII letters/digits/dot/underscore/hyphen, beginning with a letter or digit. Targets accept safe SSH aliases or hostnames, optionally `user@host`. No project configuration, stdin secrets, arbitrary SSH flags, or implicit discovery. Unknown future config keys are ignored. No prompts or destructive operations, so no `--force`, `--dry-run` or `--no-input` is needed.

JSON object: `{schemaVersion: 1, startedAt, finishedAt, hosts: [...]}`. Each host has `label`, `startedAt`, `finishedAt`, `durationMs`, `status`, `metrics`, `error`. Status is `ok`, `offline` or `error`. Success has `error: null`; failure has `metrics: null` and `error: {code, message}`. Error codes are `timeout`, `unreachable`, `host_key`, `authentication`, `transport`, `probe`, `cancelled`. Timeout/unreachable maps to offline. Other failures map to error. Ctrl-C suppresses the unfinished snapshot and exits 130.

Metrics: `{os, memory: {total, free, available}, disk: {mount, total, free, available}}`, OS `linux` or `macos`. Each metric is `{bytes: nonnegative integer | null, source: string, quality: "reported" | "unknown"}`. Source describes native counters; source/message text is informational. New object fields may be added within schema version 1. Existing fields, units, null semantics and enum values remain stable. Consumers should tolerate additional fields.

TSV header, in fixed order:

```text
label status ram_free_bytes ram_available_bytes ram_total_bytes disk_available_bytes disk_total_bytes error_code
```

Separators are literal tabs, with a newline after each row. Unknown cells are empty. Labels cannot contain control characters. No mount paths or free-form diagnostics enter TSV.

Local and remote probes use `LC_ALL=C`. SSH output is capped at 256 KiB including stderr. SSH uses one connection attempt, a connection timeout bounded by the overall host budget and strict host verification. The budget covers the entire child process including configured ProxyJump/ProxyCommand. Linux requires `/proc/meminfo`, `uname`, `df`, `cat` and POSIX sh. macOS additionally requires `sysctl` and `vm_stat`. A missing native counter or malformed output fails that host rather than inventing a metric.

Snapshots return 0 only when all selected hosts succeed, 1 for runtime or partial failure, 2 for invalid configuration/usage, 130 on SIGINT/SIGTERM. JSON/TSV data remains on stdout, host diagnostics on stderr. Sampling timestamps bracket collection from the client clock; a fleet snapshot is not simultaneous.
