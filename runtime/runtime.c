#include "runtime.h"
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdatomic.h>

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("wc3"), import_name(#name)))
#else
#define EXPORT(name)
#define IMPORT(name)
#endif
IMPORT(wc3_host_call) void wc3_host_call(uint32_t, CPU *);
IMPORT(wc3_host_resolve) uint32_t wc3_host_resolve(const char *, const char *, uint32_t);
IMPORT(wc3_host_log) void wc3_host_log(const char *);
IMPORT(wc3_host_fault) void wc3_host_fault(uint32_t, const char *);
IMPORT(wc3_host_now) double wc3_host_now(void);

uint8_t *g_mem;
uint64_t g_mem_size;
static Wc3Loader loader;
static _Atomic uint8_t thread_calls_disabled[WC3_PE_MAX_MODULES];
static uint32_t initialization_order[WC3_PE_MAX_MODULES];
static _Atomic uint32_t initialized_count;
typedef struct Wc3Context Wc3Context;
typedef struct { CPU cpu; Wc3Context *previous_active; } Wc3CallFrame;
struct Wc3Context {
    CPU cpu; /* Must be first: the external context handle is a CPU pointer. */
    uint32_t magic;
    uint32_t last_address, trace[128], trace_index, callback_depth;
    uint64_t dispatches, dispatch_budget;
    char error_text[512];
    Wc3CallFrame frames[128];
};
#define CONTEXT_MAGIC 0x57433343u
_Static_assert(offsetof(Wc3Context, cpu) == 0, "Context must preserve CPU pointer ABI");
static Wc3Context main_context = {.magic = CONTEXT_MAGIC, .dispatch_budget = 10000000};
static _Thread_local Wc3Context *active_context;
static _Thread_local char error_text[512]; /* Loader/broker or faults outside a guest call. */
static _Atomic uint32_t heap_next = 0x30000000u;
static const uint32_t return_sentinel = 0xfffffffcu;
typedef struct { uint32_t address; guest_fn_t fn; } Entry;
static Entry *entries;
static uint32_t entry_count;
/* The sorted lift table is immutable after the one allowed wc3_init. Native
 * threads can memoize its positive lookups without locks or invalidation.
 * Each secondary WASM instance initializes this zeroed cache in its own TLS;
 * switching guest contexts on that instance does not change the lift table.
 * Set to zero only for an uncached dispatch benchmark. */
#ifndef WC3_DISPATCH_CACHE_BITS
#define WC3_DISPATCH_CACHE_BITS 12
#endif
#if WC3_DISPATCH_CACHE_BITS
_Static_assert(WC3_DISPATCH_CACHE_BITS > 0 && WC3_DISPATCH_CACHE_BITS < 32, "Invalid dispatch cache size");
static _Thread_local Entry function_cache[1u << WC3_DISPATCH_CACHE_BITS];
#endif

static Wc3Context *context_for(CPU *c) {
    Wc3Context *context = (Wc3Context *)c;
    if (!context || context->magic != CONTEXT_MAGIC)
        wc3_cpu_fault(NULL, (uint32_t)(uintptr_t)c, "Invalid native guest context");
    return context;
}

__attribute__((noreturn)) void wc3_cpu_fault(CPU *c, uint32_t address, const char *reason) {
    Wc3Context *context = c ? (Wc3Context *)c : active_context;
    if (context && context->magic != CONTEXT_MAGIC) context = NULL;
    if (c && context) context->last_address = c->eip;
    char *message = context ? context->error_text : error_text;
    snprintf(message, sizeof(error_text), "%s (address=0x%08x, eip=0x%08x)", reason, address,
             context ? context->last_address : 0);
    wc3_host_fault(address, message);
    abort();
}
void unsupported_insn(CPU *c, uint32_t address, const char *mnemonic) {
    wc3_cpu_fault(c, address, mnemonic);
}
void cpuid_shim(CPU *c) {
    uint32_t leaf = c->eax;
    c->eax = c->ebx = c->ecx = c->edx = 0;
    if (!leaf) { c->eax = 1; c->ebx = 0x756e6547; c->edx = 0x49656e69; c->ecx = 0x6c65746e; }
    /* Virtual Pentium: FPU/TSC/CX8/CMOV/MMX/FXSR/SSE/SSE2. No AVX claims. */
    else if (leaf == 1) { c->eax = 0x00000663; c->edx = 0x07808111; }
}
uint64_t rdtsc_shim(void) { return (uint64_t)(wc3_host_now() * 1000000.0); }

static int compare_entry(const void *left, const void *right) {
    uint32_t a = ((const Entry *)left)->address, b = ((const Entry *)right)->address;
    return (a > b) - (a < b);
}
static guest_fn_t find_function(uint32_t address) {
#if WC3_DISPATCH_CACHE_BITS
    Entry *cached = &function_cache[(address * UINT32_C(2654435761)) >> (32 - WC3_DISPATCH_CACHE_BITS)];
    if (cached->fn && cached->address == address) return cached->fn;
#endif
    uint32_t lo = 0, hi = entry_count;
    while (lo < hi) {
        uint32_t mid = lo + (hi - lo) / 2;
        if (entries[mid].address < address) lo = mid + 1;
        else hi = mid;
    }
    if (lo == entry_count || entries[lo].address != address) return NULL;
    guest_fn_t function = entries[lo].fn;
#if WC3_DISPATCH_CACHE_BITS
    if (function) *cached = (Entry){address, function};
#endif
    return function;
}
static void record_dispatch(CPU *c, uint32_t address) {
    Wc3Context *context = context_for(c);
    context->last_address = address;
    context->trace[context->trace_index++ % 128] = address;
    if (++context->dispatches > context->dispatch_budget) wc3_cpu_fault(c, address, "Guest dispatch budget exhausted");
}
void dispatch_indirect(CPU *c, uint32_t address) {
    record_dispatch(c, address);
    if (address == return_sentinel) { c->eip = address; return; }
    if (address >= 0xf1000000u && address < 0xf2000000u) {
        wc3_host_call((address - 0xf1000000u) / 16, c);
        return;
    }
    guest_fn_t function = find_function(address);
    if (function) { function(c); return; }
    wc3_cpu_fault(c, address, "No lifted function for guest target");
}
void dispatch_tail(CPU *c) {
    uint32_t address = c->eip;
    record_dispatch(c, address);
    if (address == return_sentinel) return;
    if (address >= 0xf1000000u && address < 0xf2000000u) {
        wc3_host_call((address - 0xf1000000u) / 16, c);
        return;
    }
    guest_fn_t function = find_function(address);
    if (!function) wc3_cpu_fault(c, address, "No lifted function for guest tail target");
#ifdef __wasm__
    __attribute__((musttail)) return function(c);
#else
    function(c);
#endif
}

EXPORT(wc3_init) int wc3_init(uint32_t capacity) {
    if (g_mem) { snprintf(error_text, sizeof(error_text), "Runtime already initialized"); return 0; }
    if (capacity < 0x1000000u || capacity > 0x80000000u) return 0;
    /* 16 bytes of slack: the fast access check tests only the start address. */
    g_mem = malloc((size_t)capacity + 16);
    if (!g_mem) { snprintf(error_text, sizeof(error_text), "Cannot allocate guest address space"); return 0; }
    g_mem_size = capacity;
    if (!wc3_memory_permissions_init(capacity)) return 0;
    wc3_memory_protect(0, 0x10000, 0);
    wc3_pe_loader_init(&loader, g_mem, capacity);
    for (unsigned i = 0; i < wc3_table_count; ++i) entry_count += *wc3_tables[i].count;
    entries = malloc((entry_count ? entry_count : 1) * sizeof(Entry));
    if (!entries) return 0;
    uint32_t out = 0;
    for (unsigned i = 0; i < wc3_table_count; ++i)
        for (uint32_t j = 0; j < *wc3_tables[i].count; ++j)
            entries[out++] = (Entry){wc3_tables[i].addresses[j], wc3_tables[i].functions[j]};
    qsort(entries, entry_count, sizeof(Entry), compare_entry);
    for (uint32_t i = 1; i < entry_count; ++i)
        if (entries[i-1].address == entries[i].address) { snprintf(error_text, sizeof(error_text), "Overlapping lifted module addresses"); return 0; }
    uint32_t main_esp = capacity > 0x08000000u ? 0x07fff000u : capacity - 0x1000u;
    memset(g_mem + 0x00c00000, 0, 0x20000);
    if (!wc3_context_init(&main_context.cpu, 1, main_esp - 0x100000u, 0x101000u, 0x00c00000u)) return 0;
    main_context.cpu.esp = main_esp; /* Preserve the existing main-thread boot stack. */
    MR32(0x00c10008) = 0x00400000;
    MR32(0x00c100a4) = 5; MR32(0x00c100a8) = 1;
    return 1;
}

EXPORT(wc3_memory_base) uintptr_t wc3_memory_base(void) { return (uintptr_t)g_mem; }
EXPORT(wc3_cpu_pointer) uintptr_t wc3_cpu_pointer(void) { return (uintptr_t)&main_context.cpu; }
EXPORT(wc3_permissions_pointer) uintptr_t wc3_permissions_pointer(void) { return (uintptr_t)g_page_access; }
EXPORT(wc3_protect_guest) int wc3_protect_guest(uint32_t address, uint32_t size, int access) { return wc3_memory_protect(address, size, access); }
EXPORT(wc3_error_pointer) uintptr_t wc3_error_pointer(void) { return (uintptr_t)error_text; }
EXPORT(wc3_trace_pointer) uintptr_t wc3_trace_pointer(void) { return (uintptr_t)main_context.trace; }
EXPORT(wc3_trace_count) uint32_t wc3_trace_count(void) { return main_context.trace_index; }
EXPORT(wc3_function_count) uint32_t wc3_function_count(void) { return entry_count; }
EXPORT(wc3_cpu_size) uint32_t wc3_cpu_size(void) { return sizeof(CPU); }
EXPORT(wc3_cpu_top_offset) uint32_t wc3_cpu_top_offset(void) { return offsetof(CPU, top); }
EXPORT(wc3_cpu_st_offset) uint32_t wc3_cpu_st_offset(void) { return offsetof(CPU, st); }
EXPORT(wc3_context_set_budget) void wc3_context_set_budget(CPU *c, uint32_t count) {
    /* Zero disables the diagnostic limit for an interactive game session. */
    Wc3Context *context = context_for(c); context->dispatch_budget = count ? count : UINT64_MAX; context->dispatches = 0;
}
EXPORT(wc3_set_budget) void wc3_set_budget(uint32_t count) { wc3_context_set_budget(&main_context.cpu, count); }
EXPORT(wc3_context_trace_pointer) uintptr_t wc3_context_trace_pointer(CPU *c) { return (uintptr_t)context_for(c)->trace; }
EXPORT(wc3_context_trace_count) uint32_t wc3_context_trace_count(CPU *c) { return context_for(c)->trace_index; }
EXPORT(wc3_context_error_pointer) uintptr_t wc3_context_error_pointer(CPU *c) { return (uintptr_t)context_for(c)->error_text; }
EXPORT(wc3_context_depth) uint32_t wc3_context_depth(CPU *c) { return context_for(c)->callback_depth; }
EXPORT(wc3_context_recover) int wc3_context_recover(CPU *c, uint32_t previous_depth) {
    Wc3Context *context = context_for(c);
    if (previous_depth > context->callback_depth) return 0;
    /* The caller first restores this instance's exported __stack_pointer.
     * A JS exception skips C epilogues; retained frames recover guest state
     * even when a broker callback is nested inside a suspended worker call. */
    while (context->callback_depth > previous_depth) {
        Wc3CallFrame *frame = &context->frames[--context->callback_depth];
        *c = frame->cpu;
        active_context = frame->previous_active;
    }
    return 1;
}

EXPORT(wc3_context_init) int wc3_context_init(CPU *c, uint32_t tid, uint32_t stack_base, uint32_t stack_size, uint32_t teb_base) {
    Wc3Context *context = context_for(c);
    uint64_t stack_end = (uint64_t)stack_base + stack_size, teb_end = (uint64_t)teb_base + 0x2000;
    if (!g_mem || !tid || stack_size < 0x1000 || stack_base < 0x10000 || teb_base < 0x10000 ||
        (stack_base & 15) || (teb_base & 0xfff) || stack_end > g_mem_size || teb_end > g_mem_size ||
        (stack_base < teb_end && teb_base < stack_end) || context->callback_depth) return 0;
    wc3_mem_check(stack_base, stack_size); /* Validate every committed stack page. */
    memset(wc3_mem_check(teb_base, 0x2000), 0, 0x2000);
    memset(context, 0, sizeof(*context));
    context->magic = CONTEXT_MAGIC; context->dispatch_budget = 10000000;
    c->esp = ((uint32_t)stack_end - 16u) & ~15u;
    c->fcw = 0x027f; c->fs_base = c->gs_base = teb_base;
    MR32(teb_base) = 0xffffffffu;
    MR32(teb_base + 4) = (uint32_t)stack_end;
    MR32(teb_base + 8) = stack_base;
    MR32(teb_base + 0x18) = teb_base;
    MR32(teb_base + 0x20) = 1;
    MR32(teb_base + 0x24) = tid;
    MR32(teb_base + 0x2c) = teb_base + 0x1000;
    MR32(teb_base + 0x30) = 0x00c10000;
    return 1;
}
EXPORT(wc3_context_create) CPU *wc3_context_create(uint32_t tid, uint32_t stack_base, uint32_t stack_size, uint32_t teb_base) {
    Wc3Context *context = calloc(1, sizeof(*context));
    if (!context) return NULL;
    context->magic = CONTEXT_MAGIC;
    if (!wc3_context_init(&context->cpu, tid, stack_base, stack_size, teb_base)) { free(context); return NULL; }
    return &context->cpu;
}
EXPORT(wc3_context_destroy) int wc3_context_destroy(CPU *c) {
    Wc3Context *context = context_for(c);
    /* Broker calls this only after its worker has stopped. A host exception
     * such as _endthreadex unwinds Wasm without decrementing callback_depth. */
    if (context == &main_context || context == active_context) return 0;
    context->magic = 0; free(context); return 1;
}

EXPORT(wc3_guest_alloc) uint32_t wc3_guest_alloc(uint32_t bytes) {
    uint64_t rounded = ((uint64_t)bytes + 15u) & ~15ull;
    if (!rounded) rounded = 16;
    uint32_t address = atomic_load_explicit(&heap_next, memory_order_relaxed);
    do {
        if (address + rounded > 0x50000000u || address + rounded > g_mem_size) return 0;
    } while (!atomic_compare_exchange_weak_explicit(&heap_next, &address, address + (uint32_t)rounded,
                                                   memory_order_relaxed, memory_order_relaxed));
    memset(g_mem + address, 0, (size_t)rounded);
    return address;
}
EXPORT(wc3_load) uint32_t wc3_load(const char *name, const uint8_t *bytes, uint32_t size) {
    Wc3Module *module = NULL;
    if (!wc3_pe_load(&loader, name, bytes, size, 0, &module, error_text, sizeof(error_text))) return 0;
    return module->base;
}
EXPORT(wc3_module) uint32_t wc3_module(const char *name) {
    Wc3Module *m = wc3_pe_find(&loader, name);
    return m ? m->base : 0;
}
static uint32_t resolve_export(Wc3Module *module, const char *name, uint32_t ordinal, unsigned depth) {
    Wc3Export result;
    if (depth > 16) return 0;
    if (!wc3_pe_export(module, name, ordinal, &result, error_text, sizeof(error_text))) return 0;
    if (!result.forwarded) return result.address;
    char library[128], symbol[256];
    const char *dot = strrchr(result.forwarder, '.');
    if (!dot || (size_t)(dot - result.forwarder) > 120) return 0;
    snprintf(library, sizeof(library), "%.*s.dll", (int)(dot - result.forwarder), result.forwarder);
    snprintf(symbol, sizeof(symbol), "%s", dot + 1);
    Wc3Module *target = wc3_pe_find(&loader, library);
    const char *forward_name = symbol[0] == '#' ? NULL : symbol;
    uint32_t forward_ord = forward_name ? 0 : (uint32_t)strtoul(symbol + 1, NULL, 10);
    return target ? resolve_export(target, forward_name, forward_ord, depth + 1) : wc3_host_resolve(library, forward_name, forward_ord);
}
EXPORT(wc3_export) uint32_t wc3_export(uint32_t base, const char *name, uint32_t ordinal) {
    Wc3Module *m = wc3_pe_find_address(&loader, base);
    return m ? resolve_export(m, name, ordinal, 0) : 0;
}
static int resolve_import(void *unused, const char *library, const char *name, uint16_t ordinal, uint32_t *address) {
    (void)unused;
    Wc3Module *m = wc3_pe_find(&loader, library);
    *address = m ? resolve_export(m, name, ordinal, 0) : wc3_host_resolve(library, name, ordinal);
    return *address != 0;
}
EXPORT(wc3_link) int wc3_link(void) {
    for (unsigned i = 0; i < loader.module_count; ++i)
        if (!wc3_pe_link(&loader.modules[i], resolve_import, NULL, error_text, sizeof(error_text))) return 0;
    return 1;
}
EXPORT(wc3_call_context) uint32_t wc3_call_context(CPU *c, uint32_t address, uint32_t argc, const uint32_t *args) {
    Wc3Context *context = context_for(c);
    if (argc > 64 || (argc && !args) || context->callback_depth >= 128)
        wc3_cpu_fault(c, address, "Guest callback nesting/arguments limit");
    uint32_t depth = context->callback_depth;
    Wc3CallFrame *frame = &context->frames[depth];
    frame->cpu = *c; frame->previous_active = active_context;
    context->callback_depth = depth + 1;
    active_context = context;
    for (uint32_t i = argc; i > 0; --i) { c->esp -= 4; MR32(c->esp) = args[i - 1]; }
    c->esp -= 4; MR32(c->esp) = return_sentinel;
    c->eip = address;
    dispatch_indirect(c, address);
    uint32_t result = c->eax;
    *c = frame->cpu;
    context->callback_depth = depth;
    active_context = frame->previous_active;
    return result;
}
EXPORT(wc3_call) uint32_t wc3_call(uint32_t address, uint32_t argc, const uint32_t *args) {
    return wc3_call_context(&main_context.cpu, address, argc, args);
}
typedef struct { CPU *cpu; uint32_t reserved; } Wc3Initialization;
static int initialize_module(void *opaque, Wc3Module *module, uint32_t entry, uint32_t base, uint32_t reason) {
    Wc3Initialization *initialization = opaque;
    uint32_t args[] = {base, reason, initialization->reserved};
    int success = wc3_call_context(initialization->cpu, entry, 3, args) != 0;
    if (success && reason == WC3_PE_DLL_PROCESS_ATTACH) {
        uint32_t count = atomic_load_explicit(&initialized_count, memory_order_relaxed);
        if (count >= WC3_PE_MAX_MODULES) wc3_cpu_fault(NULL, base, "DLL initialization order overflow");
        initialization_order[count] = (uint32_t)(module - loader.modules);
        atomic_store_explicit(&initialized_count, count + 1, memory_order_release);
    }
    return success;
}
EXPORT(wc3_initialize_modules) int wc3_initialize_modules(void) {
    Wc3Initialization initialization = {&main_context.cpu, 0x00c1f000u};
    for (unsigned i = 0; i < loader.module_count; ++i)
        if (!wc3_pe_initialize(&loader.modules[i], initialize_module, &initialization, error_text, sizeof(error_text))) return 0;
    return 1;
}
EXPORT(wc3_initialize_startup) int wc3_initialize_startup(uint32_t base) {
    Wc3Module *module = wc3_pe_find_address(&loader, base);
    if (!module || module->base != base || module->is_dll) {
        snprintf(error_text, sizeof(error_text), "Startup image is not a loaded executable"); return 0;
    }
    /* Windows supplies a non-NULL reserved argument to statically loaded
     * dependencies. Only this executable's dependency tree starts here;
     * mapped images requested later by LoadLibrary receive NULL instead. */
    Wc3Initialization initialization = {&main_context.cpu, 0x00c1f000u};
    return wc3_pe_initialize(module, initialize_module, &initialization, error_text, sizeof(error_text));
}
EXPORT(wc3_initialize_library) int wc3_initialize_library(CPU *cpu, uint32_t base) {
    context_for(cpu);
    Wc3Module *module = wc3_pe_find_address(&loader, base);
    if (!module || module->base != base) {
        snprintf(error_text, sizeof(error_text), "Library is not mapped"); return 0;
    }
    Wc3Initialization initialization = {cpu, 0};
    return wc3_pe_initialize(module, initialize_module, &initialization, error_text, sizeof(error_text));
}
EXPORT(wc3_module_initialized) int wc3_module_initialized(uint32_t base) {
    Wc3Module *module = wc3_pe_find_address(&loader, base);
    return module && module->base == base && module->state >= WC3_PE_INITIALIZING;
}
EXPORT(wc3_entrypoint) uint32_t wc3_entrypoint(uint32_t base) {
    Wc3Module *m = wc3_pe_find_address(&loader, base);
    return m ? m->entrypoint : 0;
}
EXPORT(wc3_disable_thread_calls) int wc3_disable_thread_calls(uint32_t base) {
    Wc3Module *module = wc3_pe_find_address(&loader, base);
    /* Windows refuses the optimization when a DLL has static TLS. */
    if (!module || module->base != base || !module->is_dll || module->directory_size[9]) return 0;
    atomic_store_explicit(&thread_calls_disabled[module - loader.modules], 1, memory_order_release);
    return 1;
}
EXPORT(wc3_context_thread_notify) int wc3_context_thread_notify(CPU *c, uint32_t reason) {
    context_for(c);
    if (reason != 2 && reason != 3) return 0;
    if (MR32(c->fs_base + 0x24) == 1) return 1;
    uint32_t count = atomic_load_explicit(&initialized_count, memory_order_acquire);
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t index = initialization_order[reason == 2 ? i : count - 1 - i];
        Wc3Module *module = &loader.modules[index];
        if (module->state != WC3_PE_INITIALIZED || !module->entrypoint ||
            atomic_load_explicit(&thread_calls_disabled[index], memory_order_acquire)) continue;
        uint32_t args[] = {module->base, reason, 0};
        /* DllMain's return value only controls PROCESS_ATTACH, not thread notifications. */
        (void)wc3_call_context(c, module->entrypoint, 3, args);
    }
    return 1;
}
