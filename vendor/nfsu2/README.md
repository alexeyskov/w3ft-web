# Pinned upstream lifter

The files listed in `provenance.json` are copied without changes from
`th0mk/nfsu2-web` commit `3e61f9c37cb7ce4084dde182047c1b782bd9ac1a`.
Their MIT license and authorship notice are in `LICENSE`.

This is a small source subset, not the NFS game, its generated C, or its
runtime. `tools/lift_wc3.py` in this repository configures the imported
lifter for an experimental Warcraft target:

- replaces `split_operand` with literal 32-bit operands;
- replaces the NFS return-past address list with an empty set;
- disables NFS `_ftol2` inlining and inherited build flags;
- reads standard PE relocation metadata, exports and entry points;
- reports unsupported instructions, capped/empty blocks, unresolved
  references and static decoding coverage.

Do not call the original NFS `gen.sh` against Warcraft. The generated C
requires a separate WC3 runtime and is not a playable WASM build.

`lregs.py`, `split_reloc.py`, and `retpast.txt` are retained as pristine
upstream dependencies/provenance; address-specific behavior is disabled
by the adapter. `tests/test_lift_wc3.py` checks both source hashes and
target isolation.
