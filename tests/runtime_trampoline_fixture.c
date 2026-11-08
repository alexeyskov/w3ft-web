/* Guest code written as tools/lift_wc3.py writes shards, for the tail-jump
 * trampoline (runtime/cpu.h): a switch whose cases jump back to its loop
 * head, a call inside a case, a jump into a host thunk and a return made by
 * jumping to the return address. The compat build compiles this file after
 * tools/build_runtime.py trampoline_source, which adds TAIL_RESUME after
 * every direct call; callees are defined before callers, as declarations
 * belong in decls.h. */
#include "runtime.h"
#define EXPORT(name) __attribute__((export_name(#name)))
#define TABLE 0x00100000u /* the switch table: two case addresses */

/* Loop head: one pass per ecx, each a jump through the table. */
void sub_00401000(CPU *restrict c) {
    if (c->ecx == 0) { POP32(c->eip); return; }
    c->ecx -= 1;
    DISPATCH_TAIL(c, MR32(TABLE + (c->ecx & 1u) * 4u));   /* indirect tail call */
}
void sub_00401400(CPU *restrict c) {
    c->edx = c->edx * 5u + 1u;
    POP32(c->eip); return;
}
/* Called from a case; leaves through a jump of its own. */
void sub_00401300(CPU *restrict c) {
    c->edx ^= c->ecx;
    DISPATCH_TAIL(c, c->esi);   /* indirect tail call */
}
void sub_00401100(CPU *restrict c) {
    c->eax += 3u;
    DISPATCH_TAIL(c, 0x00401000u);   /* indirect tail call */
}
void sub_00401200(CPU *restrict c) {
    c->eax ^= c->ecx;
    PUSH32(0x00401210u); sub_00401300(c);
    c->eax += c->edx;
    DISPATCH_TAIL(c, 0x00401000u);   /* indirect tail call */
}
/* Code after the loop runs only once the loop has finished. */
void sub_00402000(CPU *restrict c) {
    PUSH32(0x00402010u); sub_00401000(c);
    c->ebx = c->eax + 7u;
    POP32(c->eip); return;
}
/* An import thunk: jmp [IAT] into the host, which returns to the caller. */
void sub_00405100(CPU *restrict c) {
    DISPATCH_TAIL(c, 0xf1000020u);   /* indirect tail call */
}
void sub_00405000(CPU *restrict c) {
    PUSH32(0x00405010u); sub_00405100(c);
    c->eax += 1u;
    POP32(c->eip); return;
}
/* Returns by jumping to the address it pops (the sentinel of a host call). */
void sub_00403000(CPU *restrict c) {
    c->eax = 0x1234u;
    { uint32_t _t; POP32(_t); DISPATCH_TAIL(c, _t); }   /* indirect tail call */
}
void sub_00404000(CPU *restrict c) {
    DISPATCH_TAIL(c, 0x00999990u);   /* indirect tail call */
}

/* Runs guest code from a native frame, as a host callback would. */
EXPORT(fixture_call) void fixture_call(CPU *cpu, uint32_t address) {
    MR32(TABLE) = 0x00401100u; MR32(TABLE + 4u) = 0x00401200u;
    cpu->esp -= 4; MR32(cpu->esp) = 0x00400ff0u;
    dispatch_indirect(cpu, address);
}

static const uint32_t count = 10;
static const uint32_t addresses[] = {0x00401000u, 0x00401100u, 0x00401200u, 0x00401300u, 0x00401400u,
                                     0x00402000u, 0x00403000u, 0x00404000u, 0x00405000u, 0x00405100u};
static const guest_fn_t functions[] = {sub_00401000, sub_00401100, sub_00401200, sub_00401300, sub_00401400,
                                       sub_00402000, sub_00403000, sub_00404000, sub_00405000, sub_00405100};
const Wc3LiftTable wc3_tables[] = {{&count, addresses, functions}};
const unsigned wc3_table_count = 1;
