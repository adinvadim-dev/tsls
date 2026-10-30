<p align="center">
  <img src="docs/assets/hero.svg" width="830" alt="tsls: RAM and disk across your machines. Fictional demo output: one offline machine and two machines reporting free RAM and available disk.">
</p>

# tsls

Free RAM and available disk across your macOS and Linux machines. One snapshot, using the SSH access you already have. No remote agent, telemetry, daemon, root access or Tailscale account required. The hero contains fictional demo values, not live machine data.

## Install

Configless discovery requires version 0.2.0. Check `tsls --version`. An unreleased source checkout does not update npm or your global CLI; use its verified tarball to preview new behavior.

Requires Node.js 22 or newer and OpenSSH on the client. The npm package is **`@adinvadim/tsls`**; the installed command is **`tsls`**. The unrelated unscoped `tsls` npm package is not this project.

```sh
npm install -g @adinvadim/tsls
# Or:
pnpm add -g @adinvadim/tsls
bun add -g @adinvadim/tsls
# Run without a global install:
npx @adinvadim/tsls --help
pnpm dlx @adinvadim/tsls --help
bunx @adinvadim/tsls --help
```

Only the development build needs TypeScript. Published JavaScript runs on Node; Bun is optional. macOS and Linux clients and hosts are supported. Windows clients are not yet supported. There are no standalone native binaries or Homebrew formula yet. [GitHub Releases](https://github.com/adinvadim-dev/tsls/releases) also provide an npm tarball and SHA256SUMS for offline installation. Use that verified tarball if npm metadata is still propagating immediately after a new release. Verify `shasum -a 256 -c SHA256SUMS` in the download directory, then install the downloaded versioned tarball with npm. Checksums detect download corruption; they are not a signature from an independent trust root. Installers never silently overwrite an existing unrelated `tsls` command: check `command -v tsls` before installing.

## First run

```sh
tsls
```

No setup is required. Without a tsls config, this reads local metrics and, when available, `tailscale status --json` for the current tailnet. Missing, stopped, inaccessible or invalid Tailscale status keeps a useful local result and explains missing remote coverage on stderr. It never logs in to Tailscale or installs anything remotely. No Tailscale account is needed for local-only use.

Visibility is separate from access. Offline peers, phones and unknown/unsupported operating systems are recorded as skipped without SSH. Online Linux/macOS peers receive bounded read-only SSH probes. A node can still lack a trusted host key, valid Unix login or usable identity. Those failures stay in JSON/TSV and the human summary; no automatic trust, password prompt or browser login is attempted.

```sh
tsls --json > snapshot.json
tsls --plain | cut -f1,2,3
tsls --strict                 # Exit 1 when discovery coverage is incomplete
tsls --timeout 3 --concurrency 4
tsls laptop                  # Select a label from discovery or your config
tsls --help
```

Human output shows free/total RAM, a separate RAM available column, available/total disk, and a short reason-count summary in discovery mode. Linux RAM available includes reclaimable memory; macOS RAM available is unknown (`-`), and a note explains that low RAM free alone does not describe capacity available to applications. JSON schema 2 includes every discovered node, even consciously skipped nodes, with stable peer IDs, online/last-seen metadata, discovery diagnostics and coverage. Self is local and deduplicated by Tailscale ID. Unknown metrics remain null; failed attempts never become zeros. Labels are sanitized before terminal output. RAM uses binary GiB (1,073,741,824 bytes), so a 48 GiB machine displays 48.0 GiB. Disk uses decimal GB (1,000,000,000 bytes). The table includes a units legend; JSON and TSV continue to report bytes.

## Optional configuration

Your existing explicit config still selects its own host set. To use discovery without deleting or rewriting it:

```sh
tsls --discover
tsls --discover --json
```

`--discover` ignores all tsls config, including `TSLS_CONFIG`, and cannot be combined with `--config`. It still uses your standard OpenSSH configuration. Existing literal SSH aliases from user/system config and Includes are resolved with bounded `ssh -G` calls; a matching effective HostName can map a discovered node to your existing alias/user/identity/ProxyJump. Otherwise a validated Tailscale IP is preferred over DNS for direct access, so disabled MagicDNS does not prevent collection. The destination is passed to OpenSSH, which owns login/identity defaults. tsls never derives a Unix user from Tailscale ownership or guesses one from the OS. It does not retry with guessed accounts.

For an explicit set, `tsls init` optionally creates `~/.config/tsls/config.json`, or `$XDG_CONFIG_HOME/tsls/config.json`, with only local `laptop`. It never overwrites a file. Creating that file opts into an explicit set for subsequent bare calls. Edit it to add your machines. These are fictional targets:

```json
{
  "version": 1,
  "timeout": 5,
  "concurrency": 4,
  "hosts": [
    { "label": "laptop", "transport": "local" },
    { "label": "buildbox", "transport": "ssh", "target": "buildbox" },
    { "label": "dev-vm", "transport": "ssh", "target": "developer@dev-vm.example" }
  ]
}
```

```sh
tsls laptop buildbox
tsls --config /absolute/path/to/config.json --json
TSLS_TIMEOUT=3 tsls dev-vm
```

Config path precedence: `--config` > `TSLS_CONFIG` > XDG/default file. Only an absent implicit default file enables discovery. Missing explicitly selected files, unreadable files and malformed configs produce usage errors, rather than silently changing the host set. Timing flags > `TSLS_TIMEOUT`/`TSLS_CONCURRENCY` > config > defaults. No project config is trusted. Snapshots never create a config file.

Set up and verify SSH trust/access yourself. BatchMode and StrictHostKeyChecking remain enabled; UpdateHostKeys is disabled to preserve known_hosts. Askpass/display settings are suppressed for SSH descendants including ProxyJump, while the existing agent socket and caller environment are preserved. Your SSH config is trusted executable configuration, including any ProxyCommand/Match exec you have defined. Passwords/private keys do not belong in tsls config.

## Bounds and coverage

At most 32 probes run per snapshot, including local. The whole discovery/mapping/collection phase has a 30-second deadline. Tailscale gets 3 seconds/4 MiB; alias resolution gets 5 seconds with at most 100 literal aliases and 16 SSH config files. Includes support literal paths and `*`/`?` globs. Mapping limits are disclosed; unmatched nodes use OpenSSH destination defaults. Per-host timeout is 1–120 seconds but the remaining global budget always wins. Concurrency is 1–32, default 8. Existing explicit config/env/flag values still win. Selecting labels applies the probe cap to the selection, not to an unrelated prefix of the tailnet.

All observed peers remain in machine output; excess eligible nodes are skipped with `probe_limit`, rather than silently dropped. The deadline retains completed readings and marks queued/active probes with `snapshot_timeout`. Unavailable discovery means remote count is unknown/null, not zero. Actual coverage can be partial even when the normal command succeeds. Use JSON `coverage` or `--strict` for automation that requires completeness.

### What the numbers mean

Linux RAM free is `MemFree`, RAM available is `MemAvailable`, and total is `MemTotal` from `/proc/meminfo`. Kernel kB counters are converted with 1024 bytes. Available includes reclaimable memory and is usually more useful for capacity planning. An absent `MemAvailable` remains unknown.

macOS RAM free is exactly `vm_stat`'s `Pages free` times its reported page size, including 16 KiB Apple Silicon pages. Total comes from `sysctl hw.memsize`. Available RAM is `null`: free, inactive and compressed memory cannot simply be added into an equivalent of Linux `MemAvailable`.

Disk available is `df -Pk`'s `Available`, converted from 1024-byte blocks. This is filesystem-reported space available to an ordinary user, not all free blocks; disk free is consequently `null`. Linux probes `/`; macOS probes `/System/Volumes/Data` once. APFS volumes share container capacity, snapshots and purgeable-space accounting affect readings, and Finder's capacity can differ. Never sum macOS root and Data capacities. These are observations collected during a snapshot, not atomic fleet-wide measurements or forecasts.

## Output and failures

Version 0.2.0 moves JSON to **schemaVersion 2** because skipped statuses and coverage have new semantics. Byte/source/quality formulas remain unchanged. TSV preserves its column order and empty unknown cells, adding skipped rows/reason codes. Update consumers that assumed the version 1 status/error enums. See the [CLI contract](docs/cli.md) and [discovery rules](docs/discovery.md).

JSON records snapshot/per-host ISO client timestamps, monotonic durations, metrics or structured errors, peer metadata, discovery source and coverage. Raw SSH stderr, credentials and SSH targets are excluded. No ANSI is emitted; `--no-color`, `NO_COLOR` and `TERM=dumb` are respected.

Exit `0`: local collection succeeded in ordinary discovery, or every explicitly configured/selected host succeeded. Offline/unsupported/inaccessible discovered peers are expected partial coverage. Exit `1`: failed local probe, failed explicit host/selection, or incomplete coverage under `--strict`. Exit `2`: invalid usage/config. Exit `130`: user cancellation. Data goes to stdout, concise diagnostics to stderr. Timeout/cancellation closes inherited pipes even if an SSH master retains them. Ctrl-C kills active process groups and suppresses the unfinished snapshot. No watch, retries, background jobs, analytics or notifications.

## Development

```sh
npm ci
npm run check
```

The local gate runs typecheck, Biome, unit/integration tests and a clean tarball install with bin/JSON smoke checks. Tests use sanitized fixtures and a fake SSH executable for network failures, concurrency, timeouts and cancellation. Native collection is also exercised during the pack check. GitHub Actions checks are intentionally not configured; contributors run the local gate before pushing. See [CONTRIBUTING.md](CONTRIBUTING.md).

Uninstall with `npm uninstall -g @adinvadim/tsls`, or the equivalent package-manager command. This leaves your private config untouched. MIT licensed.
