/* Original synthetic guest code, in the lifter's C format. A virtual tree
 * visitor with two non-tail calls and stdcall arguments. No game code/data. */
#include "runtime.h"
#define EXPORT(name) __attribute__((export_name(#name)))
#define HASH 0x00200000u

void sub_00401000(CPU *restrict c) {
    goto L_00401000;
L_00401000:;
    if (!c->ecx) { POP32(c->eip); c->esp += 4u; return; }
    PUSH32(c->esi);
    PUSH32(c->edi);
    c->esi = c->ecx;
    c->edi = MR32(c->esp + 12u);
    MR32(HASH) = MR32(HASH) * 33u + MR32(c->esi + 12u);
    if (MR32(c->esi + 4u)) {
        c->ecx = MR32(c->esi + 4u);
        c->edx = MR32(c->ecx);
        PUSH32(c->edi);
        { uint32_t _ct = c->edx; PUSH32(0x401020u); DISPATCH_CALL(c, _ct); }
    }
    if (MR32(c->esi + 8u)) {
        c->ecx = MR32(c->esi + 8u);
        c->edx = MR32(c->ecx);
        PUSH32(c->edi);
        { uint32_t _ct = c->edx; PUSH32(0x401030u); DISPATCH_CALL(c, _ct); }
    }
    MR32(HASH) = MR32(HASH) * 33u + (MR32(c->esi + 12u) ^ c->edi);
    { uint32_t _t; POP32(_t); c->edi = _t; }
    { uint32_t _t; POP32(_t); c->esi = _t; }
    POP32(c->eip); c->esp += 4u; return;
}

/* An ordinary external callee, including a tail exit in the compat build. */
void sub_00402000(CPU *restrict c) {
    DISPATCH_TAIL(c, 0xf1000020u);
}

EXPORT(fixture_call) void fixture_call(CPU *cpu, uint32_t root, uint32_t sentinel) {
    cpu->ecx = root;
    cpu->esp -= 4; MR32(cpu->esp) = 0x55;
    cpu->esp -= 4; MR32(cpu->esp) = sentinel;
    dispatch_indirect(cpu, 0x00401000u);
}

static const uint32_t count = 2;
static const uint32_t addresses[] = {0x00401000u, 0x00402000u};
static const guest_fn_t functions[] = {sub_00401000, sub_00402000};
const Wc3LiftTable wc3_tables[] = {{&count, addresses, functions}};
const unsigned wc3_table_count = 1;
