/* Exercise the production indirect/tail dispatcher with a game-sized table. */
#include "runtime.h"
#define EXPORT(name) __attribute__((export_name(#name)))

static void leaf_a(CPU *cpu) { cpu->eax = 0x1111u + MR32(cpu->fs_base + 0x24); }
static void leaf_b(CPU *cpu) { cpu->eax = 0x2222u + MR32(cpu->fs_base + 0x24); }

EXPORT(fixture_dispatch) uint32_t fixture_dispatch(CPU *cpu, uint32_t address, uint32_t tail) {
    cpu->eip = address;
    if (tail) dispatch_tail(cpu);
    else dispatch_indirect(cpu, address);
    return cpu->eax;
}

EXPORT(fixture_dispatch_loop) uint32_t fixture_dispatch_loop(CPU *cpu, uint32_t address, uint32_t count) {
    uint32_t sum = 0;
    for (uint32_t i = 0; i < count; ++i) {
        cpu->eip = address;
        dispatch_indirect(cpu, address);
        sum += cpu->eax;
    }
    return sum;
}

#include "dispatch_entries.inc"
