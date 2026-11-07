# Prepare your own `var/` and run locally

Run commands below from the repository root. The repository supplies tools and source, not a game installation, prebuilt game-derived WASM or a downloadable `var/` bundle. Use your own lawfully obtained copy and review the applicable game/font/map licenses before copying, modifying or sharing material. See [LEGAL.md](LEGAL.md).

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

The first command translates these four images into `var/lift-v2/{war3,game,storm,ijl15}`. The second compiles and packages `var/runtime/wc3.wasm`, `build.json`, `runtime.json`, browser modules and project license notices.

To see or customize the commands explicitly:

```sh
.venv/bin/python tools/lift_wc3.py --image var/game/war3.exe --output var/lift-v2/war3 --max-functions 0
.venv/bin/python tools/lift_wc3.py --image var/game/game.dll --output var/lift-v2/game --max-functions 0
.venv/bin/python tools/lift_wc3.py --image var/game/Storm.dll --output var/lift-v2/storm --max-functions 0
.venv/bin/python tools/lift_wc3.py --image var/game/ijl15.dll --output var/lift-v2/ijl15 --max-functions 0
.venv/bin/python tools/build_runtime.py --sdk /absolute/path/to/wasi-sdk --jobs 8
.venv/bin/python tools/package_runtime.py
```

Use the Make targets **or** the explicit translation commands, not both against the same populated output. Re-running `make runtime` after source changes uses the builder's object cache. Translation of a full game can take substantial time and disk space; it is not performed by the HTTP server.

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

For English data whose interface font lacks Cyrillic, the tool also calls `prepare_fonts.py`: it copies Cyrillic glyphs from the installation's Nimrod font into its Friz Quadrata font. Those fonts and the modified output are not MIT-licensed by this project. Verify the applicable font permissions before modification or distribution; do not publish the output merely because it was generated locally. For an already prepared localization:

```sh
.venv/bin/python tools/prepare_fonts.py var/locales/en
```

## Faster first launch

```sh
make boot-set
```

Run it after `make runtime` and after preparing languages; it needs Playwright with Chromium (`.venv/bin/python -m playwright install chromium`). For every game language it starts the packaged runtime in a fresh browser profile, opens the main menu and writes `var/runtime/boot-<language>.json`: the executables, the archive blocks the game reads up to the menu and the intro cinematic. The launcher downloads that set before a launch, six requests at a time, with a progress bar; the menu then opens right after the cinematic. Without these files the game still starts, loading menu data from the server after the cinematic. Record again after replacing game files or rebuilding the runtime; an outdated set only loads slower.

## Optional country-based language default

```sh
make geoip
```

This downloads DB-IP Lite data into `var/geoip/`, under its separate CC BY 4.0 terms. Keep the launcher's DB-IP link and the data attribution/processing notice in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Without the database, the launcher still allows manual language selection and falls back to browser language when country lookup is unavailable.

## What `var/` contains

| Directory | Created by | Needed on a prepared server? |
| --- | --- | --- |
| `var/game/` | Your installation copy / ZIP preparer, media tool | Yes: game resources; review rights and contents before sharing. |
| `var/lift-v2/` | `make lift-runtime` | Build only; game-derived generated C. |
| `var/runtime/` | `make runtime`, `make boot-set` | Yes; game-derived WASM, browser modules, manifests, notices and the recorded startup sets (`boot-*.json`). |
| `var/maps/` | `make maps` / your own maps | If selected as the map directory. |
| `var/reports/` | Inspection and tests | `game.json` supplies the inspection report used by server status; other reports are development artifacts. |
| `var/toolchains/` | Your wasi-sdk download | Build only. |
| `var/locales/` | Optional language preparation | Only for the languages offered. |
| `var/geoip/` | Optional DB-IP download | Only for country-based defaults. |

No `var/` directory from the maintainer is required. Keep the entire directory out of Git and unreviewed source/release uploads.

## Different binaries or a broken build

If your hashes differ from the tested table, keep a separate checkout/build. Re-inspect the installation, regenerate all four modules into new output directories, rebuild and test the actual game; the existing C and `build.json` cannot describe a different executable. The lifter, module layout, imports and runtime may require changes. A successful compile is not a compatibility guarantee. See [lifter notes](lifter.md), [runtime contract](runtime-contract.md) and [port status](port-status.md).

The builder's `--strict-memory` flag enables additional guest-memory diagnostics. It is not a different game version. Avoid reusing generated files from another installation or only editing the recorded hashes.

## Deployment

The supplied Docker image runs the server; it does **not** build the game or contain your installation. Prepare `var/` first and mount the required directories as in [compose.yaml](../compose.yaml). The example expects `resources/Maps/` as its map mount; provide that directory or adjust the mount/`--maps-dir` for your local setup.

Other devices need HTTPS for SharedArrayBuffer. The supplied Caddy configuration uses `WC3_DOMAIN`; keep WebSocket Upgrade, byte-range behavior and cross-origin isolation headers through any reverse proxy. Never put game directories under a public GitHub repository or bake them into a public container image without the required permissions. The current server sends game resources and game-derived code to clients; this guide is not permission to operate a public service. Review [LEGAL.md](LEGAL.md) first.
