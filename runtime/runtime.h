#ifndef WC3_RUNTIME_H
#define WC3_RUNTIME_H
#include "cpu.h"
#include "pe.h"

typedef struct { const uint32_t *count; const uint32_t *addresses; const guest_fn_t *functions; } Wc3LiftTable;
extern const Wc3LiftTable wc3_tables[];
extern const unsigned wc3_table_count;

/* Native context pointer begins with the exact lifted CPU ABI. Guest stack
 * and the 0x2000-byte TEB/TLS region are allocated/owned by the broker. One
 * worker executes a context at a time; broker callbacks may re-enter it only
 * while that worker is synchronously waiting for its HLE reply. */
CPU *wc3_context_create(uint32_t tid, uint32_t stack_base, uint32_t stack_size, uint32_t teb_base);
int wc3_context_init(CPU *cpu, uint32_t tid, uint32_t stack_base, uint32_t stack_size, uint32_t teb_base);
int wc3_context_destroy(CPU *cpu);
uint32_t wc3_call_context(CPU *cpu, uint32_t address, uint32_t argc, const uint32_t *args);
void wc3_context_set_budget(CPU *cpu, uint32_t count);
uintptr_t wc3_context_trace_pointer(CPU *cpu);
uint32_t wc3_context_trace_count(CPU *cpu);
uintptr_t wc3_context_error_pointer(CPU *cpu);
uint32_t wc3_context_depth(CPU *cpu);
int wc3_context_recover(CPU *cpu, uint32_t previous_depth);
int wc3_disable_thread_calls(uint32_t module_base);
int wc3_context_thread_notify(CPU *cpu, uint32_t reason);

/* These imports terminate explicitly on unsupported behaviour. */
#ifdef __wasm__
#define WC3_HOST_IMPORT(name) __attribute__((import_module("wc3"), import_name(#name)))
#else
#define WC3_HOST_IMPORT(name)
#endif
WC3_HOST_IMPORT(wc3_host_call) void wc3_host_call(uint32_t thunk, CPU *cpu);
WC3_HOST_IMPORT(wc3_host_resolve) uint32_t wc3_host_resolve(const char *library, const char *name, uint32_t ordinal);
WC3_HOST_IMPORT(wc3_host_log) void wc3_host_log(const char *message);
WC3_HOST_IMPORT(wc3_host_fault) void wc3_host_fault(uint32_t address, const char *message);
WC3_HOST_IMPORT(wc3_host_now) double wc3_host_now(void);
#endif
