# Source licensing, attribution and hosting

This file explains the repository's licensing boundaries. It does not grant rights in Warcraft or provide legal clearance for a deployment. A source-code license and a fan-project disclaimer cannot guarantee that a port, a derivative binary or a hosted service is authorized. The applicable game license, third-party permissions and law must be assessed separately.

## What is licensed here

The root [LICENSE](../LICENSE) is the MIT license for project source, with the upstream copyright notices retained. It permits redistribution of that source under its terms. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) identifies the borrowed code and separately licensed dependencies/data.

Preserve `vendor/nfsu2/LICENSE`, `vendor/nfsu2/provenance.json`, the CPU-header attribution and the existing MIT notice in the launcher CSS. The pinned MIT source remains the basis for those files; do not silently replace it with a newer upstream revision without checking its licensing and dependencies.

## What the MIT license does not cover

- Blizzard's executables, MPQ archives, game scripts, artwork, music, cinematics and game maps.
- Game-derived instructions in generated C and compiled WASM. A change of programming language or file format does not establish redistribution permission.
- Localized game archives, third-party maps/mods or fonts. Obtain the permissions and preserve the notices applicable to each item.
- Modified Friz Quadrata/Nimrod fonts and converted cinematics. Possession of the originals is not, by itself, permission to redistribute modified copies.
- Dependencies and linked libraries under their own licenses, including the C runtime in a WASM binary.

`resources/` and `var/` are ignored by Git. They must also be excluded from source releases, release attachments, public CI artifacts and publicly published container layers unless separately cleared for distribution. Never include CD keys, account files, personal saves or browser profiles.

## Attribution locations

| Location | Purpose |
| --- | --- |
| `README.md` | A short source-license statement, direct upstream credits and Blizzard non-affiliation/trademark notice. |
| `LICENSE` | Full MIT grant, disclaimer and project/upstream copyright notices. |
| `THIRD_PARTY_NOTICES.md` | Borrowed components, data/dependency licenses and the scope of game-content exclusions. |
| `vendor/nfsu2/LICENSE` and source headers | Original notices kept with copied/adapted files. |
| Launcher header and credits links | Visible non-affiliation notice and access to notices for a deployed copy. |
| Launcher DB-IP link | Attribution on the page using the optional country database. |
| Packaged runtime | `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt`, copied by `tools/package_runtime.py`. Additional linked-toolchain notices must be collected for binary distribution. |

When copying individual source files out of the tree, include the notices that apply to them. Keep license texts alongside any minified or bundled distribution; do not rely only on a link back to a repository that recipients may not receive.

## Public servers are a separate question

The server enumerates and serves game resources to browsers, and the generated WASM contains translated game code. HTTPS, access control, an MIT license, a non-commercial label or requiring visitors to own the game do not by themselves authorize those transfers.

Blizzard's published Legal FAQ expressly addresses unauthorized matchmaking and protocol tunneling. Its EULA also addresses reverse engineering, derivative works and transmission of game content. The Custom Game policy concerns custom games and is not a blanket license for this runtime or a replacement game service. Assess the actual license supplied with the classic installation, permissions and applicable law before operating or advertising a public service; obtain qualified advice or permission where necessary.

Use Warcraft names to identify the targeted game, retain an accurate ownership/non-endorsement statement, and review naming/domain/logo use against the applicable trademark guidelines. Acknowledging ownership is not an approval from Blizzard. No Blizzard logo or game asset is supplied as project branding by this source tree.

## Maintainer publication checklist

1. Publish source and documentation with the complete MIT and third-party notices. Confirm the staged/release file list excludes game content, secrets and local data.
2. Do not upload generated C/WASM, the game installation, language packs, fonts or movies as a convenience download without independently establishing the required rights.
3. Review licenses for every extra custom map/mod and every dependency included in a container or binary. Preserve the notices of the exact versions shipped.
4. For a permitted deployment, keep the launcher notices and DB-IP credit visible. Include linked-runtime notices as well as this project's MIT license in the material supplied to users.
5. Review the site/project name, domain, screenshots and promotional material separately. Provide a maintainer contact for licensing questions using an address you intend to publish. These documents do not settle trademark or game-distribution questions.

## Primary references

Checked 7 November 2026; policies may change. These references do not replace the license accompanying a particular classic game copy.

- [nfsu2-web README](https://github.com/th0mk/nfsu2-web) and [MIT license](https://github.com/th0mk/nfsu2-web/blob/main/LICENSE); the actually imported revision is recorded in `vendor/nfsu2/provenance.json`.
- [Blizzard End User License Agreement](https://www.blizzard.com/en-us/legal/08b946df-660a-40e4-a072-1fbde65173b1/blizzard-end-user-license-agreement).
- [Blizzard Legal FAQ](https://www.blizzard.com/en-us/legal/28d5ebbf-c245-4408-8ba9-043dd5f056bf/legal-faq).
- [Blizzard logo and trademark guidelines](https://www.blizzard.com/en-us/legal/574308ba-d8db-44e9-bc64-76173f84a57e/blizzard-entertainment-logo-and-trademark-guidelines).
- [Custom Game Acceptable Use Policy](https://www.blizzard.com/en-us/legal/2749df07-2b53-4990-b75e-a7cb3610318b/custom-game-acceptable-use-policy).
- [DB-IP Lite licensing](https://db-ip.com/db/lite.php).
- [wasi-libc licensing](https://github.com/WebAssembly/wasi-libc/blob/main/LICENSE) and [FFmpeg legal information](https://ffmpeg.org/legal.html).
