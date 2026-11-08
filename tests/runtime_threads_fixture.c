/* Synthetic guest entries for testing the real C runtime, without game data. */
#include "runtime.h"
#include <stdatomic.h>
#include <stdlib.h>
#define EXPORT(name) __attribute__((export_name(#name)))
static uint32_t marker = 0x1234abcd;
static _Thread_local uint32_t local_marker = 17;
static _Atomic uint32_t started, gate, event_count;
static uint32_t events[512][3];
static uint32_t reserved_arguments[512];

EXPORT(fixture_marker) uint32_t fixture_marker(uint32_t value) { if (value) marker = value; return marker; }
EXPORT(fixture_tls) uint32_t fixture_tls(uint32_t value) { if (value) local_marker = value; return local_marker; }
EXPORT(fixture_events) uintptr_t fixture_events(void) { return (uintptr_t)events; }
EXPORT(fixture_event_count) uint32_t fixture_event_count(void) { return atomic_load(&event_count); }
EXPORT(fixture_reserved) uint32_t fixture_reserved(uint32_t index) { return reserved_arguments[index]; }
/* A checked access out of range faults in every build mode (lifted code's
 * masked fast path does not check); the null page faults only in strict builds. */
EXPORT(fixture_no_context_fault) void fixture_no_context_fault(void) { (void)wc3_mem_check(0xfffffff0u, 1); }

static void guest_return(CPU *c, uint32_t arguments) {
    c->eip = MR32(c->esp); c->esp += 4 + arguments * 4;
    dispatch_tail(c);
}
static void dll_main(CPU *c) {
    uint32_t index = atomic_fetch_add(&event_count, 1);
    if (index >= 512) wc3_cpu_fault(c, index, "Fixture event overflow");
    events[index][0] = MR32(c->fs_base + 0x24);
    events[index][1] = MR32(c->esp + 4);
    events[index][2] = MR32(c->esp + 8);
    reserved_arguments[index] = MR32(c->esp + 12);
    c->eax = events[index][2] == 1; /* THREAD_ATTACH return value must be ignored. */
    guest_return(c, 3);
}
static void callback(CPU *c) {
    c->eax = MR32(c->esp + 4) + MR32(c->fs_base + 0x24);
    guest_return(c, 1);
}
static void recyclable_guest(CPU *c) {
    uint32_t argument = MR32(c->esp + 4), tid = MR32(c->fs_base + 0x24);
    if (local_marker != 17) wc3_cpu_fault(c, tid, "Recycled native TLS was not reinitialized");
    local_marker = tid;
    /* The real Worker dispatcher executes GetCurrentThreadId and accounts it. */
    c->esp -= 4; MR32(c->esp) = 0x00401030;
    wc3_host_call(0, c);
    if (c->eax != tid) wc3_cpu_fault(c, tid, "Recycled Worker has the wrong thread context");
    c->eax = argument + tid;
    guest_return(c, 1);
}
static void aborting_guest(CPU *c) {
    volatile uint32_t native_stack[64];
    for (unsigned i = 0; i < 64; ++i) native_stack[i] = i;
    c->esp -= 128; c->eax = 0xdeadcafe;
    wc3_host_call(1, c); /* The host throws, bypassing every C epilogue. */
    c->eax = native_stack[17];
}
static void parallel_guest(CPU *c) {
    uint32_t tid = MR32(c->fs_base + 0x24), argument = MR32(c->esp + 4);
    volatile uint32_t stack[64];
    for (unsigned i = 0; i < 64; ++i) stack[i] = tid + i;
    if (local_marker != 17) wc3_cpu_fault(c, tid, "TLS image not initialized separately");
    local_marker = tid;
    if (atomic_fetch_add(&started, 1) + 1 == 2) {
        atomic_store(&gate, 1); __builtin_wasm_memory_atomic_notify((int *)&gate, 2);
    } else while (!atomic_load(&gate)) __builtin_wasm_memory_atomic_wait32((int *)&gate, 0, -1LL);
    for (unsigned i = 0; i < 100000; ++i) {
        volatile unsigned char *p = malloc(32 + i % 64);
        if (!p) wc3_cpu_fault(c, tid, "Fixture concurrent allocation failed");
        for (unsigned j = 0; j < 32; ++j) p[j] = (unsigned char)(tid + j);
        wc3_atomic_rmw(c, 0x00100000, 32, WC3_ATOMIC_ADD, 1, 0);
        for (unsigned j = 0; j < 32; ++j)
            if (p[j] != (unsigned char)(tid + j)) wc3_cpu_fault(c, tid, "Concurrent malloc data corruption");
        free((void *)p);
    }
    if (local_marker != tid) wc3_cpu_fault(c, tid, "TLS overwritten by another instance");
    for (unsigned i = 0; i < 64; ++i)
        if (stack[i] != tid + i) wc3_cpu_fault(c, tid, "Native stack overwritten");
    c->eax = 0xfeed1234;
    uint32_t nested = wc3_call_context(c, 0x00401010, 1, &argument);
    if (c->eax != 0xfeed1234) wc3_cpu_fault(c, tid, "Callback failed to restore the same CPU");
    wc3_host_call(2, c); /* Host invokes an aborting callback at nested depth. */
    c->eax = nested;
    guest_return(c, 1);
}

static const uint32_t count = 7;
static const uint32_t addresses[] = {0x11000, 0x21000, 0x31000, 0x401000, 0x401010, 0x401020, 0x401030};
static const guest_fn_t functions[] = {dll_main, dll_main, dll_main, parallel_guest, callback, aborting_guest, recyclable_guest};
const Wc3LiftTable wc3_tables[] = {{&count, addresses, functions}};
const unsigned wc3_table_count = 1;
