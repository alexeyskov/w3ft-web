PYTHON ?= .venv/bin/python

.PHONY: setup prepare inspect maps media locale-en geoip boot-set serve test lift-smoke lift-runtime runtime runtime-probe
# Archive created from your own licensed English installation; never downloaded.
ENGLISH_ARCHIVE ?= resources/Warcraft_III_en.zip
setup:
	python3 -m venv .venv
	$(PYTHON) -m pip install -r requirements.txt

prepare:
	$(PYTHON) tools/prepare_game.py
	$(PYTHON) tools/inspect_game.py
	$(PYTHON) tools/prepare_media.py

inspect:
	$(PYTHON) tools/inspect_game.py

maps:
	$(PYTHON) tools/extract_maps.py

media:
	$(PYTHON) tools/prepare_media.py

# English game data of the same patch (1.26a) into var/locales/en.
locale-en:
	$(PYTHON) tools/prepare_locale.py "$(ENGLISH_ARCHIVE)" --language en

# Country database for the default page language (monthly, DB-IP CC BY 4.0).
geoip:
	$(PYTHON) tools/fetch_geoip.py

serve:
	$(PYTHON) -m server.app

test:
	$(PYTHON) -m unittest discover -s tests -v
	node --check web/src/app.mjs
	node --check web/src/storage.mjs
	node --check web/src/transport.mjs
	node --check web/src/diagnostics.mjs
	node --check web/src/presence.mjs
	node --check web/src/touch-keyboard.mjs
	node --test tests/*_test.mjs

lift-smoke:
	$(PYTHON) tools/lift_wc3.py --image var/game/game.dll --output var/lift/game-smoke --max-functions 32

lift-runtime:
	$(PYTHON) tools/lift_wc3.py --image var/game/war3.exe --output var/lift-compact/war3 --max-functions 0
	$(PYTHON) tools/lift_wc3.py --image var/game/game.dll --output var/lift-compact/game --image-base 0x02000000 --max-functions 0
	$(PYTHON) tools/lift_wc3.py --image var/game/Storm.dll --output var/lift-compact/storm --image-base 0x03000000 --max-functions 0
	$(PYTHON) tools/lift_wc3.py --image var/game/ijl15.dll --output var/lift-compact/ijl15 --image-base 0x03100000 --max-functions 0

# wc3.wasm, and wc3-compat.wasm for browsers without WebAssembly tail calls.
runtime:
	$(PYTHON) tools/build_runtime.py
	$(PYTHON) tools/build_runtime.py --variant compat
	$(PYTHON) tools/package_runtime.py

# What the game reads up to its main menu, per language (var/runtime/boot-*.json):
# the launcher downloads it before a launch, with progress. Needs Playwright.
boot-set:
	$(PYTHON) tools/record_boot_set.py

runtime-probe:
	node tools/run_runtime.mjs
