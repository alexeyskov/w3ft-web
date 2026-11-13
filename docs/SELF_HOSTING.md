# Prepare your own `var/` and run locally

Run commands below from the repository root. **Building or deploying this project requires your own valid Warcraft III: The Frozen Throne license and files from your own lawfully obtained installation.** The repository supplies tools and source, not a game installation, prebuilt game-derived WASM or a downloadable `var/` bundle. Review the applicable game/font/map licenses before copying, modifying or sharing material. See [LEGAL.md](LEGAL.md).

## Compatible game files

The tested target is the **classic 32-bit Windows Warcraft III: The Frozen Throne**, whose `game.dll` reports **1.26.0.6401**. Archive labels such as “1.26a” or “1.26b” are not a reliable binary identifier. These are the tested inputs:

| Image | Bytes | SHA-256 |
| --- | ---: | --- |
| `war3.exe` | 471,040 | `28173101fcbeb4cdcac0f83e0e724aa444209b479a2ac1c1784e0d4310889909` |
| `game.dll` | 12,042,240 | `6d21bd9a0f9fbc8446f455c9e89ac994fed68174426fe608fcb9baefd4dec53c` |
| `Storm.dll` | 339,968 | `eecc42b05a91413dee10588a654c6cca05836e7513af6c7c568a56124bf97d0a` |
| `ijl15.dll` | 378,856 | `d0f16ff50ff5263d02488af7f69a8ccfff708b82ff49f9701227c38e604332ef` |

The hashes identify files; they are not product keys. No game download or patch/crack download is provided here. Obtain the installation and any updates through a source you are entitled to use.

You can generate C and a build profile from your own binaries, but other revisions are **porting work, not guaranteed compatibility**. Reforged/64-bit images are outside this runtime's target. Localizations of the same patch can share the translated binaries only if their gameplay scripts/tables match. Do not swap executables into an old build: the browser verifies input hashes against `var/runtime/build.json`.

## 1. Install tools

Use macOS or Linux, or WSL with the checkout in its Linux filesystem. Install Python 3.11+, Make, a recent Node.js, FFmpeg (`ffmpeg` and `ffprobe`) and, for the optional language step, `bsdtar` from libarchive. Then:

```sh
make setup
mkdir -p var/toolchains
```

Download [wasi-sdk 34 for your host](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34) and unpack it into `var/toolchains/`. For example, the compiler on the tested Apple Silicon setup is at `var/toolchains/wasi-sdk-34.0-arm64-macos/bin/clang`. Choose the matching archive for your OS/architecture. This download is the compiler, not game content.

You may keep the SDK elsewhere and pass `--sdk /absolute/path/to/wasi-sdk` to the builder in step 4.

## 2. Prepare a clean installation

Use a fresh checkout with no existing `var/game`. The ZIP preparer refuses to overwrite an existing installation. **Choose one method**, not both.

### From an installed directory

```sh
mkdir -p var
cp -R "/absolute/path/to/your/Warcraft III" var/game
```

This copies the local directory; it does not run an installer. `var/game` must directly contain `war3.exe`, `game.dll`, `Storm.dll`, `ijl15.dll`, the MPQ archives and the `Movies/` directory from a complete installation. On a case-sensitive filesystem, use the filename spelling expected by the commands below.

### From a ZIP you created locally

ZIP the installation's contents, either flat or under a single enclosing directory, then run:

```sh
.venv/bin/python tools/prepare_game.py "/absolute/path/to/your-installation.zip" --destination var/game
```

The optional default input name is `resources/Warcraft_III.zip`; no archive is supplied or fetched by the repository. The preparer validates paths, rejects symlinks/encrypted members and limits unpacked size. It cannot establish the provenance or licensing of the supplied files.

The server can enumerate files under the supplied installation. Prepare a clean copy: do not include account credentials, CD-key files, private documents, personal saves/replays or browser profiles in a served directory. Review the resource directory before exposing it to other people.

## 3. Inspect, prepare movies and maps

```sh
make inspect
make media
make maps
```

- `make inspect` writes binary versions/hashes to `var/reports/game.json` without executing Windows binaries.
- `make media` converts the installation's AVI cinematics to browser-decodable WebM files in `var/game/WebMedia/`. Keep the original `Movies/` files. The converted copies remain game content.
- `make maps` extracts discoverable built-in maps into `var/maps/Builtin/`. Missing MPQ listfiles and unsupported codecs can leave extraction incomplete; review `var/reports/maps-extraction.json`.

For maps you are entitled to use, you can also put loose `.w3m`, `.w3x` and `.w3n` files under `var/maps/`. If `resources/Maps/` exists, the server uses it by default instead. Select a directory explicitly with `./run.sh --maps-dir var/maps`. New maps become available when the game is restarted. Custom maps may have additional authors and third-party content; a Warcraft license does not settle those rights.

## 4. Translate and compile

Fresh output directories are required for the translation step:

```sh
make lift-runtime
make runtime
```

The first command translates these four images into `var/lift-compact/{war3,game,storm,ijl15}`; this directory name is retained for compatibility. The DLLs are rebased using their PE relocation tables before translation. Input installation files are not modified: their original hashes are still verified, and the loader applies the same relocations at startup. Flag liveness analysis is enabled during translation. The builder applies register localization after its recursion protection and compiles with `-O2`.

The default memory layout is `growing`: a 2 GiB guest address window, a separate fixed 64 MiB native runtime arena, and WASM memory committed as images, stacks and guest allocations need it. The guest heap begins at 64 MiB and can grow beyond the old compact build's 448 MiB heap limit. This is an address-space limit, not a promise that a device has enough memory for every map. Browser, compiled code, GPU, audio and worker memory are additional costs. Native runtime allocations fail cleanly if their fixed arena fills; they cannot grow into guest memory.

The second command compiles and packages `var/runtime/wc3.wasm`, `build.json`, `runtime.json`, browser modules and project license notices. It also builds `wc3-compat.wasm` and `build-compat.json`: the same code for browsers without WebAssembly tail calls (Safari before 18.2, Chrome before 112, Firefox before 121), which the page picks by itself. Upload both WASM files and build profiles together; without the compatible module those browsers are asked to update.

To see or customize the commands explicitly:

```sh
.venv/bin/python tools/lift_wc3.py --image var/game/war3.exe --output var/lift-compact/war3 --max-functions 0
.venv/bin/python tools/lift_wc3.py --image var/game/game.dll --output var/lift-compact/game --image-base 0x02000000 --max-functions 0
.venv/bin/python tools/lift_wc3.py --image var/game/Storm.dll --output var/lift-compact/storm --image-base 0x03000000 --max-functions 0
.venv/bin/python tools/lift_wc3.py --image var/game/ijl15.dll --output var/lift-compact/ijl15 --image-base 0x03100000 --max-functions 0
.venv/bin/python tools/build_runtime.py --sdk /absolute/path/to/wasi-sdk --jobs 8
.venv/bin/python tools/build_runtime.py --sdk /absolute/path/to/wasi-sdk --jobs 8 --variant compat
.venv/bin/python tools/package_runtime.py
```

Use the Make targets **or** the explicit translation commands, not both against the same populated output. Re-running `make runtime` after source changes uses the builder's object cache. Translation of a full game can take substantial time and disk space; it is not performed by the HTTP server.

When upgrading an existing checkout, regenerate the translation outputs to pick up flag-analysis changes. Preserve the previous output under an unused name first (omit the `mv` if that directory does not exist):

```sh
mv var/lift-compact var/lift-compact-before-optimization
make lift-runtime
make runtime
make boot-set
```

Do not run translation into a populated output directory. Existing `var/lift-v2` outputs use old high DLL addresses and are not accepted by the default builder. For an intentional legacy build, pass `--memory-layout legacy --module-dirs var/lift-v2/war3 var/lift-v2/game var/lift-v2/storm var/lift-v2/ijl15` to `build_runtime.py` for both variants; `--memory-layout compact` retains the former eagerly allocated 512 MiB guest window. A build profile, both WASM variants and browser runtime must be deployed together.

Generated C and the compiled game module stay local. If you intend to distribute a build, establish game-content rights and collect the notices of the actual linked SDK libraries; the package step includes only the project/upstream notices, not an exhaustive toolchain-license bundle.

## 5. Play

```sh
./run.sh
```

Open `http://localhost:8080/`. The default base language is Russian. If your base installation is English:

```sh
./run.sh --base-language en
```

Choose campaigns/maps inside the original game. For LAN, use the same site lobby on both clients and then host/join through Warcraft's **Local Area Network** menu. The web lobby and a Warcraft match are separate; a lobby can contain more people than a single 12-player match. Stop the server with `Ctrl+C`.

## Optional languages

A second language supplies matching game data rather than another copy of the translated executables. Create a supported archive from your own same-patch localized installation:

```sh
.venv/bin/python tools/prepare_locale.py "/absolute/path/to/your-localized-installation.zip" --language en
```

The archive reader uses `bsdtar`; localized archives and movies must be at the archive root and under `Movies/`. This tool does not unwrap an enclosing game directory. It compares game scripts/tables against `var/game`, prepares movies and writes `var/locales/en/locale.json`. `--language ru` is also supported. No language-pack download is provided.

The equivalent Make target is `make locale-en ENGLISH_ARCHIVE="/absolute/path/to/your-localized-installation.zip"`. Without an override it reads `resources/Warcraft_III_en.zip`, which you must create from your own licensed installation; it does not download an archive.

For English data whose interface font lacks Cyrillic, the tool also calls `prepare_fonts.py`: it copies Cyrillic glyphs from the installation's Nimrod font into its Friz Quadrata font. Those fonts and the modified output are not MIT-licensed by this project. Verify the applicable font permissions before modification or distribution; do not publish the output merely because it was generated locally. For an already prepared localization:

```sh
.venv/bin/python tools/prepare_fonts.py var/locales/en
```

## Faster first launch

```sh
make boot-set
```

Run it after `make runtime` and after preparing languages; it needs Playwright with Chromium (`.venv/bin/python -m playwright install chromium`). For every game language it starts the packaged runtime in a fresh browser profile, opens the main menu and writes `var/runtime/boot-<language>.json`: the executables and archive blocks needed for the menu. The launcher downloads this set before launch, six requests at a time, with a progress bar. Startup intros are skipped without downloading them. Movies requested later by a campaign still play. Record again after replacing game files or rebuilding the runtime; an absent or outdated set falls back to on-demand reads.

The same command generates `var/runtime/download-plan-<language>.json` from your installation's MPQ metadata. It prioritizes menus, multiplayer screens, common match resources, then campaign and unclassified data. Blocks containing several kinds of content take the earliest priority. Filenames recovered from other installed archives also classify patch archives without a readable listfile. Unknown blocks are still downloaded in the final phase. Run `make download-plan` to regenerate just these plans without starting a browser.

After the menu appears, the runtime fills its existing OPFS cache automatically. One background request downloads at most 1 MiB at a time and writes complete 256 KiB blocks directly to disk. Urgent game reads cancel the background request and hold it until they finish; the selected map and related match/campaign resources move forward in the plan. Completed blocks are reused on the next launch, and replaced file versions invalidate only their own cache entries. Browser caching reduces network stalls; it cannot remove CPU, shader compilation or simulation stalls.

The selected edition, server maps and prepared campaign movies are cached. Original movie files (duplicates of the prepared videos) and startup intros are excluded. Downloading is fully automatic, without pause/resume controls for the player. **Game → Game data on this device** shows stored data; the existing manual preload before launch is optional. Closing the game stops the background work and flushes its progress. Data saver, storage shortage or repeated network errors pause only the optional download; network failures retry automatically after a cooldown. Browsers may deny persistent storage or evict it; a private browsing session may not support this cache. No entire archive or movie is buffered in JavaScript memory for the background download.

Deploy the packaged runtime together with both `boot-*.json` and `download-plan-*.json`. A UI-only update does not install runtime changes. The local deployment helpers include these files and regenerate stale sets/plans before a full restart; this can be checked without contacting a VPS with `bash ./sync-vps.sh --prepare-only --dry-run`.

## Optional country-based language default

```sh
make geoip
```

This downloads DB-IP Lite data into `var/geoip/`, under its separate CC BY 4.0 terms. Keep the launcher's DB-IP link and the data attribution/processing notice in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Without the database, the launcher still allows manual language selection and falls back to browser language when country lookup is unavailable.

## What `var/` contains

| Directory | Created by | Needed on a prepared server? |
| --- | --- | --- |
| `var/game/` | Your installation copy / ZIP preparer, media tool | Yes: game resources; review rights and contents before sharing. |
| `var/lift-compact/` | `make lift-runtime` | Build only; game-derived generated C with relocated DLLs. |
| `var/runtime/` | `make runtime`, `make boot-set` | Yes; game-derived WASM, browser modules, manifests, notices, startup sets (`boot-*.json`) and background plans (`download-plan-*.json`). |
| `var/maps/` | `make maps` / your own maps | If selected as the map directory. |
| `var/reports/` | Inspection and tests | `game.json` supplies the inspection report used by server status; other reports are development artifacts. |
| `var/toolchains/` | Your wasi-sdk download | Build only. |
| `var/locales/` | Optional language preparation | Only for the languages offered. |
| `var/geoip/` | Optional DB-IP download | Only for country-based defaults. |

No `var/` directory from the maintainer is required. Keep the entire directory out of Git and unreviewed source/release uploads.

## Different binaries or a broken build

If your hashes differ from the tested table, keep a separate checkout/build. Re-inspect the installation, regenerate all four modules into new output directories, rebuild and test the actual game; the existing C and `build.json` cannot describe a different executable. The lifter, module layout, imports and runtime may require changes. A successful compile is not a compatibility guarantee. See [lifter notes](lifter.md), [runtime contract](runtime-contract.md) and [port status](port-status.md).

The builder's `--strict-memory` flag enables additional guest-memory diagnostics. It is not a different game version. Avoid reusing generated files from another installation or only editing the recorded hashes.

### Browser game settings

Warcraft's user registry settings, including its LAN name, are stored alongside
save files in the browser's IndexedDB profile. The runtime restores them before
starting the game and includes them in JSON backups. On the site's **Saves**
tab, **Save** downloads a backup and **Load** imports it. Its
internal settings file is hidden from the save-file list. Installation paths and
launcher-controlled video options are supplied afresh on each launch.

Use **Close game** or the in-game exit after applying changes in the game's
menus. Close game allows a short normal shutdown so Warcraft can write its
settings, then stops an unresponsive guest after a bounded wait. An abrupt
browser/process termination can lose edits the original game has not written.

## Deployment

The supplied Docker image runs the server; it does **not** build the game or contain your installation. Prepare `var/` first and mount the required directories as in [compose.yaml](../compose.yaml). The example expects `resources/Maps/` as its map mount; provide that directory or adjust the mount/`--maps-dir` for your local setup.

Compose also mounts the checkout's `web/` directory read-only at `/app/web`.
Once this mount is installed, updating launcher HTML, CSS, scripts and icons
does not require restarting the application or Caddy; open LAN connections
continue, and visitors see the interface changes after reloading their page.
Transfer files with rsync's `--delay-updates` instead of writing them in place.
For deployments created before this mount was added, one container recreation
is required, which disconnects players; schedule that migration accordingly.
Changes to Python dependencies, server code or container configuration still
require rebuilding/recreating the application. Interface-only updates do not
update the packaged game runtime in `var/runtime`.

Other devices need HTTPS for SharedArrayBuffer. The supplied Caddy configuration uses `WC3_DOMAIN`; keep WebSocket Upgrade, byte-range behavior and cross-origin isolation headers through any reverse proxy. Never put game directories under a public GitHub repository or bake them into a public container image without the required permissions. The current server sends game resources and game-derived code to clients; this guide is not permission to operate a public service. Review [LEGAL.md](LEGAL.md) first.

The four permanent public lobbies are shared by all game languages, with 200
seats each. Automatic joining fills the first available lobby in numeric order.
If every public lobby is full, the relay opens a temporary numbered lobby;
empty overflow lobbies expire after 120 seconds and the four permanent ones
remain available. Custom named lobbies and private room codes are separate.

### Inspecting the “Playing now” counter

`in game` counts launcher pages reporting a running game session, including loading, cinematics and menus. `over LAN` additionally requires a live lobby connection. A page can therefore count as `in game` while no longer connected to a lobby. These are page counts, not unique people or proof that a match is progressing.

After deploying the updated server, run this **on your VPS**, from its project directory:

```sh
docker compose exec -T web python -m server.sessions --playing
```

The report shows each counted page's IP address, browser User-Agent, connection time, game state and LAN connection state. Omit `--playing` to include pages that only have the website open; add `--json` for structured output. For a local server outside Docker, use `.venv/bin/python -m server.sessions` (and `--port PORT` if different from 8080). Times are in UTC. “Last state report” is the last message about game state, not a game-frame heartbeat; it need not change while a game runs.

The CLI reads a private server file; there is no extra port or public list of IP addresses. The server replaces an owner-readable file (mode `0600`, `/tmp/w3ft-presence-8080.json` in Docker) every two seconds and removes it on shutdown. Only currently connected pages appear, with no history or lobby tokens. The command rejects stale reports. A disappeared page is removed after the WebSocket heartbeat detects the lost connection; an open page still reporting a game can remain counted even when its game is stuck.

With the supplied Caddy configuration, the IP is taken from the last `X-Forwarded-For` address appended by the proxy. If that address belongs to Cloudflare's published ranges, `CF-Connecting-IP` supplies the visitor's address; arbitrary clients cannot override it by sending this header. The range list lives in `server/geoip.py`. Missing or invalid headers leave the proxy address visible. Shared Wi-Fi, VPNs, other proxies and mobile networks can still hide the particular device. The browser string is not verified device identity. Keep reports out of public bug reports. Disable the file report with `server.app --no-presence-report`, or choose a private file outside served directories with `--presence-report PATH` and read it with `server.sessions --path PATH`.

### Issue reports

After a fatal startup/runtime error the launcher offers **Report issue**. It
saves a frozen incident locally; reloading or starting another game preserves
that report. An interrupted launch can also be reported after reopening the
page. This indicates an unexpected interruption, not a confirmed out-of-memory
diagnosis. The dialog previews the error, technical context and log, accepts an
optional comment, and sends only after the visitor clicks Send. A failed upload
can be retried with the same incident ID without counting the crash twice.
After the server acknowledges a report, its local draft is removed and the
report button disappears, including after a page reload. A new incident can be
reported separately; a pending new incident is preserved if an older upload
finishes later.
**Download log** remains available when reporting is unavailable.

Open the **Issues** tab in the existing password-protected `/admin` panel.
Each group has a **Resolved** checkbox, also available in its detail view.
Checking it keeps the reports and marks the group fixed; unchecking it returns
the group to New. The existing status selector can still mark a group as
Investigating or Unreproduced. These states are stored in SQLite.

**Export JSON** downloads every unresolved group with all its retained reports
and full plain-text logs in one file. Resolved groups are excluded, regardless
of the current list filters or pagination. The file is intended to be attached
for debugging: it includes fingerprints, occurrence counts, statuses, notes,
error types/messages/stacks/details, player comments, runtime/UI build IDs,
browser/OS/language/settings and UTC timestamps. It contains no game files or
saves. Existing report redaction is preserved in the export.

The UTF-8 format identifies itself as `w3ft-issue-export`, with `schemaVersion: 1`,
`scope: "unresolved"`, `exportedAt`, `retentionDays`, `summary`, and an `issues`
array. Each issue has a `reportCount` for all observed submissions and a
`reports` array of the retained full reports, each with a plain-text `log`.
Older reports already deleted by retention cannot be recovered; their counts
remain in the group. The authenticated download endpoint is
`/api/admin/issues/export`, with attachment and no-store headers. Exports are
bounded to 32 MiB; a larger export returns an explicit error rather than a
silently truncated or invalid JSON document.

Groups use normalized error signatures and call sites; full logs, timestamps,
browser versions and random session identifiers are not grouping keys. Filter
by status, runtime build, browser, language or text, sort by report count or
recent appearance, inspect individual reports, download logs, add notes, mark
an issue resolved in a particular build, or merge duplicate groups. Reports
received after resolution are flagged for review. An older client can still
submit a report, so this flag alone is not proof of a regression and does not
automatically reopen the issue. Counts describe submitted reports, not every
failure experienced by every visitor.

SQLite uses Python's standard library and is initialized lazily on the first
report/admin Issues request. Local storage defaults to `var/issues/issues.sqlite3`;
choose another directory with `--issues-dir PATH` or `WC3_ISSUES_DIR`. An empty
`WC3_ISSUES_DIR` disables collection unless an explicit directory is supplied.
Compose uses `/app/var/issues` in the persistent writable `issue_data` named
volume; game data and the container root filesystem remain read-only. Ordinary
container recreation preserves reports. Do not remove that volume when
updating. The SQLite files and local `var/` are ignored by Git and excluded
from the upload scripts.

Reports contain the error/stack, build identifiers, browser/OS, language,
graphics settings and bounded journal. Known credentials, private lobby
identifiers and IP addresses are scrubbed before storage; IP addresses used
for upload rate limiting are only held as temporary salted hashes in memory.
Game archives, saves, screenshots and memory dumps are not attached. The
public endpoint accepts JSON up to 1 MiB, with at most 800,000 UTF-8 bytes of
log and 4,000 comment characters. Default limits are five submissions per
address and 60 globally per minute, and a 256 MiB SQLite database budget.
Full reports/logs expire after 30 days during maintenance on store access;
group counters and duplicate-send receipts survive. Back up SQLite using its
backup API or with the application stopped, including pending WAL data; avoid
copying only the live main database file. Logs are only downloadable through
authenticated admin endpoints.

### Private admin panel

`/admin` shows the current connections and can end a selected session. It has no link on the game page. Without `WC3_ADMIN_PASSWORD_HASH` it returns 404; there is no default password. Configure it **on the VPS**, after uploading the updated source:

```sh
cd /opt/w3ft-web
python3 -m server.admin_auth
docker compose --profile https up -d --build --force-recreate web
```

The command asks for a password of at least 16 characters twice, without echoing it. It uses only Python's standard library; no virtual environment is needed. It preserves other `.env` settings and saves only a salted PBKDF2-SHA256 hash (600,000 iterations), with file permissions `0600`. `.env` is ignored by Git and excluded from the local deployment scripts. Run the command as the owner of `.env` (or with `sudo` if required); Docker must also be available to that user. Recreating the web container interrupts existing connections.

The configured password survives VPS reboots, `docker compose restart` and container recreation: Compose reads the same hash from the VPS's `.env`. Synchronization excludes that file, and the installer only updates its domain setting. A restart invalidates active admin login sessions, so sign in again with the same password. The password changes only when you explicitly run `server.admin_auth` again or replace/remove its setting. Keep the VPS's `.env` if moving to another server, or set a new password there.

Open `https://YOUR_DOMAIN/admin` and sign in. The panel supports English and Russian, refreshes every five seconds and shows page IDs, IP addresses, browser strings, connection/report times and LAN state. Dates in the panel use your browser's local timezone; the CLI uses UTC. A confirmation identifies the selected page before disconnecting it. Server-generation checks prevent an old list from targeting a different page after a restart.

The top of the panel shows server CPU usage (overall and per logical CPU), RAM used/available, swap when present, space used/free on the game data filesystem, and receive/send rates and cumulative traffic per network interface. CPU and network rates need two samples; the first view briefly shows sampling placeholders. Sampling pauses when the page is hidden and starts a fresh baseline after a long gap. Missing system counters are shown as unavailable; a failed refresh leaves the last snapshot visible with a warning and its timestamp. The data is available only through the authenticated `/api/admin/metrics` endpoint and is not stored as a history.

The **Visitor activity** chart below it shows concurrent connections **on site**,
**in game** and **over LAN** over the last hour, 24 hours, 7, 30 or 90 days.
Each connected launcher tab counts separately, including multiple tabs from the
same browser or IP address. These are neither unique visitor counts nor a sum
of visits. In-game counts include loading, cinematics and menus. The chart uses
the same definitions as the launcher's live counters.

The server records each counter's peak within every minute, including brief
connections between periodic samples, and flushes to SQLite every 30 seconds.
Longer chart ranges show peaks within larger buckets, without adding counts
together. Hover, tap or use the arrow keys on the chart to inspect a bucket.
Dates use the browser's timezone. Recording continues while the admin page is
closed; the visible chart refreshes every 30 seconds. Collection begins when
the updated server starts, with no backfill of earlier visits. Missing intervals
(such as server downtime) are gaps, not zero visitors.

Activity storage contains only a minute timestamp and three aggregate counters;
it does not retain IP addresses, browser strings, names or session identifiers.
It keeps 90 days, prunes older rows hourly, and is readable only through the
authenticated `/api/admin/activity` endpoint. Local storage is
`var/activity/activity.sqlite3` by default, next to the configured game directory.
Set `WC3_ACTIVITY_DIR` to choose another private directory, or to an empty string
to disable recording. This environment setting is independent of the admin
password and the current-session report. The supplied Compose file uses the
dedicated writable `activity_data` volume at `/app/var/activity`; rebuild and
recreate `web` once when adding this feature so that the volume is attached.
Ordinary restarts and container recreation preserve history. Keep this volume
when updating, and copy its data separately if migrating to a new server.
Back up SQLite using its backup API, or stop the application and include any
pending WAL data; copying only a live main database can miss recent records.
Local activity databases under `var/` are ignored by Git. An abrupt process
termination can lose the most recent unflushed 30 seconds of observations.

On the Linux VPS, CPU and RAM statistics describe the machine, not just the Python process or a Docker memory/CPU quota. The supplied Compose file mounts only `/proc/1/net/dev` read-only at `/run/host-net-dev`, selected by `WC3_HOST_NET_DEV`, to include host network traffic such as Caddy HTTPS. Loopback, Docker bridges and veth interfaces are excluded to avoid duplicated traffic. Rates are shown separately for each remaining interface; they are not percentages of the VPS provider's bandwidth allowance. Disk space is measured on the filesystem containing `var/game`, not by summing the sizes of game files. No Docker socket, privileged mode or host PID/network namespace is used.

Rebuild and recreate the web container when deploying this change so that `psutil` and the read-only mount are installed. This host counter mount is for Linux Docker hosts; for Docker Desktop on a non-Linux host, remove that mount and `WC3_HOST_NET_DEV` from your local Compose configuration. Without the mount, network statistics are explicitly labelled as web-container traffic. Outside Docker, install the updated `requirements.txt`; local macOS/Linux runs read their own machine's counters directly.

A kick closes the selected game's LAN connection, asks the launcher to stop its game through the normal save/stop path, and disables automatic reconnection and Play for that tab. It does not close the browser tab or ban its IP. Reloading the page allows a new session. Older launchers can also be disconnected: the server closes their presence and linked LAN sockets and rejects automatic retries. They **cannot receive the game-stop command**, so an already loaded single-player game may continue. The panel explains this before confirmation and reports a server disconnect instead of claiming the game stopped.

With admin access enabled, the presence handshake sets a random HttpOnly, SameSite=Strict browser-session cookie scoped to `/api/presence` (Secure over HTTPS). After a legacy kick, the server recognizes retries by this cookie rather than IP, so other devices on the same network are unaffected. Old tabs share the browser cookie: their subsequent reconnects are rejected too; already connected tabs are not kicked. Current launchers still reconnect normally, including after a reload. Retry records stay in memory, expire after one hour without retries, and reset on server restart. The cookie identifier changes after a server restart and is never included in public counters or admin listings. A modified client or a client that refuses/clears cookies can bypass this restriction; this is session management, not DRM or a permanent ban.

Admin endpoints require authentication, use `Cache-Control: no-store`, and do not expose connection details to the public APIs. Sessions expire after eight hours and are invalidated on logout or server restart. Cookies are HttpOnly, SameSite=Strict and Secure over HTTPS. Login checks have per-address and global rate limits, with at most one password verification in progress. Commands additionally require a CSRF token and reject a mismatched Origin ([OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)). HTTPS is required except for direct loopback development. These protections do not replace a strong unique password or keeping the server updated. Current connections and login sessions remain in memory; aggregate activity history and submitted issue reports use their separate private SQLite stores.

To change the password, rerun the same command and recreate `web`. To disable the panel, remove `WC3_ADMIN_PASSWORD_HASH` from `.env` and recreate `web`. If the panel is enabled, it collects current connection metadata even with `--no-presence-report`; disable both to stop that collection entirely. For non-Docker development, explicitly export the hash before `python -m server.app` (the Python server does not automatically read `.env`).
