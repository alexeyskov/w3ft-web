# Warcraft® III: The Frozen Throne® Web

The Frozen Throne Revived is a fan project that runs the classic Windows game in a browser. The original x86 code is translated to C and compiled to WebAssembly; OpenGL is implemented with WebGL 2 and audio with Web Audio. The launcher includes saves, graphics settings, fullscreen and virtual LAN lobbies.

Based on [nfsu2-web](https://github.com/th0mk/nfsu2-web) by th0mk, using its MIT-licensed lifter and CPU helpers, with original work by Talha Müderrisoğlu. The game-specific runtime and multiplayer protocol are adapted for Warcraft III.

> Not affiliated with, endorsed by, or sponsored by Blizzard Entertainment. Bring your own lawfully obtained game installation. Game files, generated game code and compiled game modules are not included in this repository.

## What you need

- **The game:** a complete classic 32-bit Windows installation with The Frozen Throne. The tested binaries report **1.26.0.6401**. Reforged and arbitrary other patches are not supported just by copying their data. See the [tested binary hashes and compatibility notes](docs/SELF_HOSTING.md#compatible-game-files).
- **To build:** macOS or Linux, Python 3.11+, a recent Node.js with WebAssembly threads and tail calls, FFmpeg (`ffmpeg` and `ffprobe`), Make, and [wasi-sdk 34](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34). Use Linux/WSL for Windows development. Optional localization preparation also needs `bsdtar`.
- **To play:** a current desktop browser with WebGL 2, OffscreenCanvas, SharedArrayBuffer and WebAssembly threads/tail calls. Chromium is the tested browser. Use localhost or HTTPS.

## Build

Start in a fresh checkout. Create a ZIP from your own installed game, containing its files at the root or inside one enclosing directory:

```sh
make setup
.venv/bin/python tools/prepare_game.py "/absolute/path/to/your-installation.zip"
make inspect media maps
```

Download the wasi-sdk 34 archive for your machine and unpack it under `var/toolchains/`, retaining its `wasi-sdk-*` directory. Then:

```sh
make lift-runtime
make runtime
```

This creates your own `var/game`, `var/maps`, `var/lift-v2`, `var/runtime` and `var/reports`. Generated C and WASM are derived from the supplied game and stay outside Git. The [self-hosting guide](docs/SELF_HOSTING.md) also covers using an installed directory, alternate SDK locations, languages, maps and rebuilding for different binaries. No prebuilt `var/` download is required.

## Play

```sh
./run.sh
```

Open **http://localhost:8080/** and press **Play**. Select campaigns and maps inside Warcraft. Saves remain in the browser and can be exported from the launcher. If your base installation is English, start with `./run.sh --base-language en`.

For LAN play, join the same site lobby, launch both clients and open **Local Area Network** in Warcraft. One player hosts the match; the others join it. Battle.net is not implemented. Other devices require HTTPS; [compose.yaml](compose.yaml) and [deploy/Caddyfile](deploy/Caddyfile) provide a deployment starting point.

**Hosting serves your game files and game-derived WASM to connected browsers.** Owning a game copy does not itself grant permission to redistribute those files or operate an Internet matchmaking service. Read the [publication and hosting notes](docs/LEGAL.md) before making a deployment public.

## How it works

- **`tools/`** inspects the installation, translates four PE images and builds the WASM module.
- **`runtime/`** implements the guest CPU, PE loading and dispatch.
- **`web/runtime/`** supplies Win32, graphics, audio, persistence and virtual sockets in browser workers.
- **`web/src/`** provides the launcher, local saves, settings and OPFS game-data cache.
- **`server/`** serves files with byte ranges/compression and routes lobby traffic; the game executes on the client.

Campaign startup, save/load and short LAN matches have been exercised. Full campaign completion, every custom map and all browsers are not verified. See [port status](docs/port-status.md) and [runtime documentation](docs/runtime-contract.md).

## Development

```sh
make test
```

Browser tests require Playwright/Chromium and, where documented, a running local server. Start with [tests/browser_smoke.py](tests/browser_smoke.py) for the launcher or [tests/runtime_lan_browser.py](tests/runtime_lan_browser.py) for two real game clients.

## Credits

- [th0mk/nfsu2-web](https://github.com/th0mk/nfsu2-web): static recompilation tools, CPU helpers and launcher layout. The vendored source revision and original notices are preserved in [vendor/nfsu2/](vendor/nfsu2/README.md).
- Talha Müderrisoğlu's [NFSU2Recomp](https://github.com/TalhaMudo/NFSU2Recomp): the original recompiler and macOS runtime credited by that MIT-licensed upstream snapshot. Its later revisions are not imported by this project.
- [StormLib](https://github.com/ladislav-zezula/StormLib): a reference for MPQ sector behavior.
- [DB-IP](https://db-ip.com): optional IP-to-country Lite data under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Dependencies and redistribution notes are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Project source is available under the [MIT License](LICENSE), with the retained notices for borrowed components. This license does **not** cover Warcraft executables, archives, maps, music, cinematics, fonts, modified game assets, or the game-derived portions of generated C/WASM. Obtain the applicable rights separately.

Warcraft, Warcraft III: The Frozen Throne and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc., in the U.S. and/or other countries. Their use here identifies the game this project targets and does not imply approval. See [LEGAL.md](docs/LEGAL.md).
