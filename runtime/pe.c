#include "pe.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PE_IMPORT_LIMIT 1048576u

static int fail(char *error, size_t capacity, const char *format, ...) {
    if (error && capacity) {
        va_list arguments;
        va_start(arguments, format);
        vsnprintf(error, capacity, format, arguments);
        va_end(arguments);
    }
    return 0;
}

static int span(uint64_t offset, uint64_t size, uint64_t length) {
    return offset <= length && size <= length - offset;
}

static uint16_t u16(const uint8_t *p) {
    return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void put32(uint8_t *p, uint32_t value) {
    p[0] = (uint8_t)value; p[1] = (uint8_t)(value >> 8);
    p[2] = (uint8_t)(value >> 16); p[3] = (uint8_t)(value >> 24);
}

static unsigned char lower(unsigned char c) {
    return c >= 'A' && c <= 'Z' ? (unsigned char)(c + ('a' - 'A')) : c;
}

static int same_name(const char *a, const char *b) {
    if (!a || !b) return 0;
    while (*a && *b && lower((unsigned char)*a) == lower((unsigned char)*b)) {
        ++a; ++b;
    }
    return *a == *b;
}

static int valid_name(const char *name) {
    size_t length = 0;
    if (!name || !*name) return 0;
    while (name[length]) {
        unsigned char c = (unsigned char)name[length];
        if (c < 32 || c == '/' || c == '\\' || c == ':' || ++length >= WC3_PE_NAME_SIZE)
            return 0;
    }
    return strcmp(name, ".") && strcmp(name, "..");
}

void wc3_pe_loader_init(Wc3Loader *loader, uint8_t *memory, uint64_t capacity) {
    if (!loader) return;
    memset(loader, 0, sizeof(*loader));
    loader->memory = memory;
    loader->capacity = capacity;
}

Wc3Module *wc3_pe_find(Wc3Loader *loader, const char *name) {
    if (!loader) return NULL;
    for (size_t i = 0; i < loader->module_count; ++i)
        if (same_name(loader->modules[i].name, name)) return &loader->modules[i];
    return NULL;
}

Wc3Module *wc3_pe_find_address(Wc3Loader *loader, uint32_t address) {
    if (!loader) return NULL;
    for (size_t i = 0; i < loader->module_count; ++i) {
        Wc3Module *module = &loader->modules[i];
        if (address >= module->base && (uint64_t)address - module->base < module->size)
            return module;
    }
    return NULL;
}

static uint8_t *rva(const Wc3Module *module, uint32_t offset, uint64_t length) {
    if (!module || !module->loader || !module->loader->memory ||
        !span(offset, length, module->size) ||
        !span((uint64_t)module->base + offset, length, module->loader->capacity))
        return NULL;
    return module->loader->memory + module->base + offset;
}

static const char *string_rva(const Wc3Module *module, uint32_t offset, size_t maximum) {
    uint8_t *start = rva(module, offset, 1);
    if (!start) return NULL;
    size_t available = module->size - offset;
    if (available > maximum) available = maximum;
    return memchr(start, 0, available) ? (const char *)start : NULL;
}

static int relocate(Wc3Module *module, char *error, size_t capacity) {
    if (module->base == module->preferred_base) return 1;
    uint32_t directory = module->directory_rva[5], size = module->directory_size[5];
    if (!directory || !size || (module->characteristics & 1))
        return fail(error, capacity, "%s has no usable base relocations", module->name);
    uint32_t delta = module->base - module->preferred_base;
    uint64_t cursor = 0;
    while (cursor < size) {
        if (!span(cursor, 8, size)) return fail(error, capacity, "Truncated relocation block");
        const uint8_t *block = rva(module, directory + (uint32_t)cursor, 8);
        if (!block) return fail(error, capacity, "Relocation directory outside image");
        uint32_t page = u32(block), block_size = u32(block + 4);
        if (block_size < 8 || (block_size & 1) || !span(cursor, block_size, size))
            return fail(error, capacity, "Invalid relocation block size");
        block = rva(module, directory + (uint32_t)cursor, block_size);
        if (!block) return fail(error, capacity, "Relocation block outside image");
        for (uint32_t i = 8; i < block_size; i += 2) {
            uint16_t item = u16(block + i), type = item >> 12;
            if (type == 0) continue; /* IMAGE_REL_BASED_ABSOLUTE padding */
            if (type != 3) return fail(error, capacity, "Unsupported PE32 relocation type %u", type);
            uint64_t target = (uint64_t)page + (item & 0xFFF);
            if (target > UINT32_MAX) return fail(error, capacity, "Relocation target overflow");
            uint8_t *address = rva(module, (uint32_t)target, 4);
            if (!address) return fail(error, capacity, "Relocation target outside image");
            put32(address, u32(address) + delta);
        }
        cursor += block_size;
    }
    return 1;
}

int wc3_pe_load(Wc3Loader *loader, const char *name,
                const uint8_t *data, size_t length, uint32_t load_base,
                Wc3Module **out, char *error, size_t capacity) {
    if (out) *out = NULL;
    if (error && capacity) error[0] = 0;
    if (!loader || !loader->memory || !valid_name(name) || !data || !out)
        return fail(error, capacity, "Invalid loader, name, source or output");
    if (loader->capacity > UINT64_C(0x100000000) || loader->capacity > SIZE_MAX)
        return fail(error, capacity, "Guest capacity is not addressable");
    if (loader->module_count >= WC3_PE_MAX_MODULES || wc3_pe_find(loader, name))
        return fail(error, capacity, "Module already loaded or module limit reached");
    if (!span(0, 64, length) || memcmp(data, "MZ", 2))
        return fail(error, capacity, "Missing or truncated DOS header");
    uint32_t pe = u32(data + 0x3C);
    if (!span(pe, 24, length) || memcmp(data + pe, "PE\0\0", 4))
        return fail(error, capacity, "Missing or truncated PE header");
    if (u16(data + pe + 4) != 0x14C)
        return fail(error, capacity, "Only i386 PE32 images are supported");
    uint16_t sections = u16(data + pe + 6), optional_size = u16(data + pe + 20);
    uint64_t optional = (uint64_t)pe + 24;
    if (!sections || sections > 96 || optional_size < 96 ||
        !span(optional, optional_size, length) || u16(data + optional) != 0x10B)
        return fail(error, capacity, "Invalid PE32 optional header or section count");
    const uint8_t *header = data + optional;
    uint32_t image_size = u32(header + 56), headers_size = u32(header + 60);
    uint32_t directory_count = u32(header + 92), preferred = u32(header + 28);
    uint32_t base = load_base ? load_base : preferred, entry = u32(header + 16);
    uint64_t section_table = optional + optional_size;
    if (!image_size || !headers_size || headers_size > image_size ||
        !span(0, headers_size, length) || directory_count > 16 ||
        !span(96, (uint64_t)directory_count * 8, optional_size) ||
        !span(section_table, (uint64_t)sections * 40, headers_size) ||
        !span(base, image_size, loader->capacity) ||
        !span(base, image_size, UINT64_C(0x100000000)) || entry >= image_size)
        return fail(error, capacity, "PE headers, entrypoint or image interval out of bounds");
    for (size_t i = 0; i < loader->module_count; ++i) {
        const Wc3Module *existing = &loader->modules[i];
        if ((uint64_t)base < (uint64_t)existing->base + existing->size &&
            (uint64_t)existing->base < (uint64_t)base + image_size)
            return fail(error, capacity, "Guest image overlaps module %s", existing->name);
    }
    Wc3Module candidate;
    memset(&candidate, 0, sizeof(candidate));
    candidate.loader = loader; strcpy(candidate.name, name);
    candidate.base = base; candidate.size = image_size; candidate.preferred_base = preferred;
    candidate.entrypoint = entry ? base + entry : 0;
    candidate.characteristics = u16(data + pe + 22);
    candidate.is_dll = !!(candidate.characteristics & 0x2000);
    for (uint32_t i = 0; i < directory_count; ++i) {
        uint32_t address = u32(header + 96 + i * 8), size = u32(header + 100 + i * 8);
        if ((address == 0) != (size == 0))
            return fail(error, capacity, "Incomplete data directory %u", i);
        if (address && !span(address, size, i == 4 ? length : image_size))
            return fail(error, capacity, "Data directory %u outside image/file", i);
        candidate.directory_rva[i] = address; candidate.directory_size[i] = size;
    }
    for (uint32_t i = 0; i < sections; ++i) {
        const uint8_t *section = data + section_table + i * 40;
        uint32_t virtual_size = u32(section + 8), address = u32(section + 12);
        uint32_t raw_size = u32(section + 16), raw_offset = u32(section + 20);
        uint32_t memory_size = virtual_size > raw_size ? virtual_size : raw_size;
        if ((memory_size && address < headers_size) || !span(address, memory_size, image_size) ||
            !span(raw_offset, raw_size, length))
            return fail(error, capacity, "Section %u outside image/file", i);
        for (uint32_t j = 0; j < i && memory_size; ++j) {
            const uint8_t *previous = data + section_table + j * 40;
            uint32_t previous_size = u32(previous + 8), previous_raw = u32(previous + 16);
            if (previous_raw > previous_size) previous_size = previous_raw;
            uint32_t previous_address = u32(previous + 12);
            if (previous_size && (uint64_t)address < (uint64_t)previous_address + previous_size &&
                (uint64_t)previous_address < (uint64_t)address + memory_size)
                return fail(error, capacity, "Overlapping PE sections");
        }
    }
    /* Source memory must not alias the destination: clearing the image would
     * otherwise destroy bytes that have not yet been copied. */
    uintptr_t source = (uintptr_t)data, destination = (uintptr_t)(loader->memory + base);
    if ((source <= destination && destination - source < length) ||
        (destination < source && source - destination < image_size))
        return fail(error, capacity, "PE source aliases destination memory");
    memset(loader->memory + base, 0, image_size);
    memcpy(loader->memory + base, data, headers_size);
    for (uint32_t i = 0; i < sections; ++i) {
        const uint8_t *section = data + section_table + i * 40;
        uint32_t address = u32(section + 12), size = u32(section + 16), raw = u32(section + 20);
        if (size) memcpy(loader->memory + base + address, data + raw, size);
    }
    if (!relocate(&candidate, error, capacity)) {
        memset(loader->memory + base, 0, image_size);
        return 0;
    }
    candidate.state = WC3_PE_PREPARED;
    loader->modules[loader->module_count] = candidate;
    *out = &loader->modules[loader->module_count++];
    return 1;
}

typedef struct Patch { uint32_t rva, address; } Patch;

int wc3_pe_link(Wc3Module *module, Wc3PEResolver resolver, void *context,
                char *error, size_t capacity) {
    if (error && capacity) error[0] = 0;
    if (!module || module->state < WC3_PE_PREPARED)
        return fail(error, capacity, "Module is not prepared");
    if (module->state >= WC3_PE_LINKED) return 1;
    if (module->directory_rva[13]) return fail(error, capacity, "Delay imports are not implemented");
    uint32_t directory = module->directory_rva[1], size = module->directory_size[1];
    if (!directory) { module->state = WC3_PE_LINKED; return 1; }
    if (!resolver) return fail(error, capacity, "An import resolver is required");
    Patch *patches = NULL;
    size_t count = 0, allocated = 0;
    Wc3Module *dependencies[WC3_PE_MAX_MODULES];
    size_t dependency_count = 0;
    int terminated = 0, success = 0;
    for (uint64_t cursor = 0; span(cursor, 20, size); cursor += 20) {
        const uint8_t *descriptor = rva(module, directory + (uint32_t)cursor, 20);
        if (!descriptor) { fail(error, capacity, "Import descriptor outside image"); goto finish; }
        uint32_t original = u32(descriptor), name_rva = u32(descriptor + 12);
        uint32_t first = u32(descriptor + 16);
        if (!(original | u32(descriptor + 4) | u32(descriptor + 8) | name_rva | first)) {
            terminated = 1; break;
        }
        const char *library = string_rva(module, name_rva, WC3_PE_NAME_SIZE);
        if (!library || !valid_name(library) || !first) {
            fail(error, capacity, "Invalid import library or first thunk"); goto finish;
        }
        uint32_t lookup = original ? original : first;
        int thunk_terminated = 0;
        for (uint64_t i = 0; i < PE_IMPORT_LIMIT; ++i) {
            uint64_t lookup_rva = (uint64_t)lookup + i * 4, target_rva = (uint64_t)first + i * 4;
            if (lookup_rva > UINT32_MAX || target_rva > UINT32_MAX) {
                fail(error, capacity, "Import thunk arithmetic overflow"); goto finish;
            }
            const uint8_t *entry = rva(module, (uint32_t)lookup_rva, 4);
            if (!entry) { fail(error, capacity, "Import lookup outside image"); goto finish; }
            uint32_t value = u32(entry);
            if (!value) { thunk_terminated = 1; break; }
            if (!rva(module, (uint32_t)target_rva, 4)) {
                fail(error, capacity, "Import address table outside image"); goto finish;
            }
            const char *name = NULL;
            uint16_t ordinal = 0;
            if (value & 0x80000000u) {
                if (value & 0x7FFF0000u) { fail(error, capacity, "Invalid import ordinal"); goto finish; }
                ordinal = (uint16_t)value;
            } else {
                if (!rva(module, value, 3)) { fail(error, capacity, "Import hint/name outside image"); goto finish; }
                name = string_rva(module, value + 2, 4096);
                if (!name || !*name) { fail(error, capacity, "Unterminated or empty import name"); goto finish; }
            }
            uint32_t address = 0;
            if (!resolver(context, library, name, ordinal, &address) || !address) {
                fail(error, capacity, "Unresolved import %s!%s (#%u)", library, name ? name : "ordinal", ordinal);
                goto finish;
            }
            if (count == PE_IMPORT_LIMIT) { fail(error, capacity, "Too many imports"); goto finish; }
            if (count == allocated) {
                size_t next = allocated ? allocated * 2 : 64;
                Patch *grown = (Patch *)realloc(patches, next * sizeof(*patches));
                if (!grown) { fail(error, capacity, "Unable to allocate import patches"); goto finish; }
                patches = grown; allocated = next;
            }
            patches[count++] = (Patch){(uint32_t)target_rva, address};
        }
        if (!thunk_terminated) { fail(error, capacity, "Unterminated import thunk table"); goto finish; }
        Wc3Module *dependency = wc3_pe_find(module->loader, library);
        if (dependency && dependency != module) {
            size_t i = 0;
            while (i < dependency_count && dependencies[i] != dependency) ++i;
            if (i == dependency_count) dependencies[dependency_count++] = dependency;
        }
    }
    if (!terminated) { fail(error, capacity, "Unterminated import descriptor table"); goto finish; }
    for (size_t i = 0; i < count; ++i) put32(rva(module, patches[i].rva, 4), patches[i].address);
    memcpy(module->dependencies, dependencies, dependency_count * sizeof(*dependencies));
    module->dependency_count = dependency_count;
    module->state = WC3_PE_LINKED;
    success = 1;
finish:
    free(patches);
    return success;
}

int wc3_pe_export(const Wc3Module *module, const char *name, uint16_t ordinal,
                  Wc3Export *out, char *error, size_t capacity) {
    if (out) memset(out, 0, sizeof(*out));
    if (error && capacity) error[0] = 0;
    if (!module || module->state < WC3_PE_PREPARED || !out)
        return fail(error, capacity, "Invalid module or export output");
    uint32_t directory = module->directory_rva[0], size = module->directory_size[0];
    const uint8_t *table = directory && size >= 40 ? rva(module, directory, 40) : NULL;
    if (!table) return fail(error, capacity, "Module has no export table");
    uint32_t base = u32(table + 16), functions = u32(table + 20), names = u32(table + 24);
    uint32_t addresses = u32(table + 28), name_table = u32(table + 32), ordinal_table = u32(table + 36);
    if (names > functions || !rva(module, addresses, (uint64_t)functions * 4) ||
        (names && (!rva(module, name_table, (uint64_t)names * 4) ||
                   !rva(module, ordinal_table, (uint64_t)names * 2))))
        return fail(error, capacity, "Export arrays outside image");
    uint32_t index = UINT32_MAX;
    if (name) {
        for (uint32_t i = 0; i < names; ++i) {
            const char *candidate = string_rva(module, u32(rva(module, name_table + i * 4, 4)), 4096);
            if (!candidate) return fail(error, capacity, "Unterminated export name");
            if (!strcmp(candidate, name)) {
                index = u16(rva(module, ordinal_table + i * 2, 2)); break;
            }
        }
    } else if (ordinal >= base) index = ordinal - base;
    if (index >= functions) return fail(error, capacity, "Export was not found");
    uint32_t address = u32(rva(module, addresses + index * 4, 4));
    if (!address || !rva(module, address, 1)) return fail(error, capacity, "Export target outside image or absent");
    if (address >= directory && (uint64_t)address < (uint64_t)directory + size) {
        size_t remaining = (size_t)((uint64_t)directory + size - address);
        if (remaining > sizeof(out->forwarder)) remaining = sizeof(out->forwarder);
        const char *forwarder = string_rva(module, address, remaining);
        if (!forwarder || !*forwarder || !strchr(forwarder, '.'))
            return fail(error, capacity, "Invalid or oversized export forwarder");
        strcpy(out->forwarder, forwarder); out->forwarded = 1;
    } else out->address = module->base + address;
    return 1;
}

static int linked_tree(Wc3Module *module, uint32_t *visited, char *error, size_t capacity) {
    size_t index = (size_t)(module - module->loader->modules);
    if (index >= module->loader->module_count) return fail(error, capacity, "Unregistered dependency");
    uint32_t bit = UINT32_C(1) << index;
    if (*visited & bit) return 1;
    *visited |= bit;
    if (module->state < WC3_PE_LINKED) return fail(error, capacity, "Dependency %s is not linked", module->name);
    if (module->directory_rva[9]) return fail(error, capacity, "TLS initialization is not implemented for %s", module->name);
    for (size_t i = 0; i < module->dependency_count; ++i)
        if (!linked_tree(module->dependencies[i], visited, error, capacity)) return 0;
    return 1;
}

static int initialize_tree(Wc3Module *module, Wc3PEInit initialize, void *context,
                           char *error, size_t capacity) {
    if (module->state == WC3_PE_INITIALIZED || module->state == WC3_PE_INITIALIZING) return 1;
    module->state = WC3_PE_INITIALIZING;
    for (size_t i = 0; i < module->dependency_count; ++i) {
        if (!initialize_tree(module->dependencies[i], initialize, context, error, capacity)) {
            module->state = WC3_PE_LINKED; return 0;
        }
    }
    if (module->is_dll && module->entrypoint &&
        (!initialize || !initialize(context, module, module->entrypoint, module->base, WC3_PE_DLL_PROCESS_ATTACH))) {
        module->state = WC3_PE_LINKED;
        return fail(error, capacity, "DLL initialization failed: %s", module->name);
    }
    module->state = WC3_PE_INITIALIZED;
    return 1;
}

int wc3_pe_initialize(Wc3Module *module, Wc3PEInit initialize, void *context,
                      char *error, size_t capacity) {
    if (error && capacity) error[0] = 0;
    if (!module || !module->loader) return fail(error, capacity, "Invalid initialization module");
    uint32_t visited = 0;
    if (!linked_tree(module, &visited, error, capacity)) return 0;
    return initialize_tree(module, initialize, context, error, capacity);
}
