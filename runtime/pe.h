#ifndef WC3_PE_H
#define WC3_PE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WC3_PE_MAX_MODULES 32
#define WC3_PE_NAME_SIZE 128
#define WC3_PE_DLL_PROCESS_ATTACH 1u

typedef enum Wc3ModuleState {
    WC3_PE_EMPTY = 0,
    WC3_PE_PREPARED = 1,
    WC3_PE_LINKED = 2,
    WC3_PE_INITIALIZING = 3,
    WC3_PE_INITIALIZED = 4
} Wc3ModuleState;

typedef struct Wc3Loader Wc3Loader;
typedef struct Wc3Module Wc3Module;

struct Wc3Module {
    Wc3Loader *loader;
    char name[WC3_PE_NAME_SIZE];
    uint32_t base, size, preferred_base, entrypoint;
    uint32_t directory_rva[16], directory_size[16];
    uint16_t characteristics;
    uint8_t is_dll;
    Wc3ModuleState state;
    Wc3Module *dependencies[WC3_PE_MAX_MODULES];
    size_t dependency_count;
};

struct Wc3Loader {
    uint8_t *memory;
    uint64_t capacity;
    Wc3Module modules[WC3_PE_MAX_MODULES];
    size_t module_count;
};

typedef struct Wc3Export {
    uint32_t address; /* guest VA, or zero when forwarded */
    int forwarded;
    char forwarder[256]; /* e.g. KERNEL32.Sleep or other.#123 */
} Wc3Export;

/* A null name requests an ordinal import; ordinal is ignored for named imports.
 * Return nonzero and fill address on success. All input images must be loaded
 * before linking so local dependency initialization order can be recorded. */
typedef int (*Wc3PEResolver)(void *context, const char *library,
                            const char *name, uint16_t ordinal,
                            uint32_t *address);

/* Invokes a translated DLL entry point. The callback's context determines
 * DllMain's reserved argument (non-NULL at process startup, NULL for dynamic
 * loading). This loader never executes guest/native code itself. Nonzero
 * means successful attach. */
typedef int (*Wc3PEInit)(void *context, Wc3Module *module, uint32_t entrypoint,
                       uint32_t image_base, uint32_t reason);

void wc3_pe_loader_init(Wc3Loader *loader, uint8_t *guest_memory, uint64_t capacity);
Wc3Module *wc3_pe_find(Wc3Loader *loader, const char *name);
Wc3Module *wc3_pe_find_address(Wc3Loader *loader, uint32_t address);

/* load_base=0 selects ImageBase. Source bytes are borrowed only during this
 * call; headers and sections are copied into guest memory, owned by the caller.
 * No state is registered on failure; a failed relocation clears the reserved
 * image span. Module records remain valid until loader_init resets the loader.
 * These APIs are synchronous; callers serialize all mutation of one loader. */
int wc3_pe_load(Wc3Loader *loader, const char *name,
                const uint8_t *data, size_t length, uint32_t load_base,
                Wc3Module **out, char *error, size_t error_capacity);
int wc3_pe_link(Wc3Module *module, Wc3PEResolver resolver, void *context,
                char *error, size_t error_capacity);
int wc3_pe_export(const Wc3Module *module, const char *name, uint16_t ordinal,
                  Wc3Export *out, char *error, size_t error_capacity);
int wc3_pe_initialize(Wc3Module *module, Wc3PEInit initialize, void *context,
                      char *error, size_t error_capacity);

#ifdef __cplusplus
}
#endif
#endif
