/* Warcraft guest CPU helpers. See cpu.h and vendor/nfsu2/LICENSE.
 * LOCK operations use sequentially consistent C atomics. Unsupported
 * alignment is rejected instead of invoking a misaligned Wasm atomic.
 */
#include "cpu.h"
#include <stdatomic.h>
#include <stdlib.h>

uint8_t *g_page_access;
uint32_t g_page_count;

__attribute__((noinline, cold)) _Noreturn void wc3_mem_fault(uint32_t address) {
    wc3_cpu_fault(NULL, address, "guest memory access out of range");
}

__attribute__((noinline)) uint8_t *wc3_mem_check(uint32_t address, size_t bytes) {
    if (!g_mem || address > g_mem_size || bytes > g_mem_size - address)
        wc3_cpu_fault(NULL, address, "guest memory access out of range");
    if (g_page_access && bytes) {
        uint32_t first = address >> WC3_PAGE_SHIFT;
        uint32_t last = (uint32_t)(((uint64_t)address + bytes - 1) >> WC3_PAGE_SHIFT);
        if (last >= g_page_count)
            wc3_cpu_fault(NULL, address, "guest page outside permissions map");
        for (uint32_t page = first; page <= last; ++page)
            if (!(g_page_access[page >> 3] & (uint8_t)(1u << (page & 7u))))
                wc3_cpu_fault(NULL, page == first ? address : page << WC3_PAGE_SHIFT,
                              "guest memory access to NOACCESS page");
    }
    return g_mem + address;
}

int wc3_memory_permissions_init(uint64_t capacity) {
    if (!capacity || capacity > UINT64_C(0x100000000)) return 0;
    uint32_t count = (uint32_t)((capacity + WC3_PAGE_BYTES - 1) >> WC3_PAGE_SHIFT);
    size_t bytes = ((size_t)count + 7) / 8;
    uint8_t *access = malloc(bytes);
    if (!access) return 0;
    memset(access, 0xff, bytes);
    free(g_page_access);
    g_page_access = access;
    g_page_count = count;
    return 1;
}

int wc3_memory_protect(uint32_t address, uint32_t size, int access) {
    if (!g_page_access || !size || (access != 0 && access != 1)
        || address > g_mem_size || size > g_mem_size - address) return 0;
    uint32_t first = address >> WC3_PAGE_SHIFT;
    uint32_t last = (uint32_t)(((uint64_t)address + size - 1) >> WC3_PAGE_SHIFT);
    if (last >= g_page_count) return 0;
    for (uint32_t page = first; page <= last; ++page) {
        uint8_t bit = (uint8_t)(1u << (page & 7u));
        if (access) g_page_access[page >> 3] |= bit;
        else g_page_access[page >> 3] &= (uint8_t)~bit;
    }
    return 1;
}

static uint64_t atomic_read(void *pointer, unsigned bits) {
    switch (bits) {
    case 8: return atomic_load_explicit((_Atomic uint8_t *)pointer, memory_order_seq_cst);
    case 16: return atomic_load_explicit((_Atomic uint16_t *)pointer, memory_order_seq_cst);
    case 32: return atomic_load_explicit((_Atomic uint32_t *)pointer, memory_order_seq_cst);
    case 64: return atomic_load_explicit((_Atomic uint64_t *)pointer, memory_order_seq_cst);
    default: wc3_cpu_fault(NULL, 0, "invalid atomic width");
    }
}

static int atomic_compare(void *pointer, unsigned bits, uint64_t *old, uint64_t value) {
#define WC3_CAS(width) do { \
    uint##width##_t expected = (uint##width##_t)*old; \
    int success = atomic_compare_exchange_weak_explicit( \
        (_Atomic uint##width##_t *)pointer, &expected, (uint##width##_t)value, \
        memory_order_seq_cst, memory_order_seq_cst); \
    *old = expected; return success; \
} while (0)
    switch (bits) {
    case 8: WC3_CAS(8);
    case 16: WC3_CAS(16);
    case 32: WC3_CAS(32);
    case 64: WC3_CAS(64);
    default: wc3_cpu_fault(NULL, 0, "invalid atomic width");
    }
#undef WC3_CAS
}

static void arithmetic_flags(CPU *c, uint64_t left, uint64_t right,
                             unsigned carry, uint64_t result, unsigned bits, int subtract) {
    uint64_t mask = (UINT64_C(1) << bits) - 1;
    result &= mask;
    c->zf = result == 0;
    c->sf = (uint32_t)(result >> (bits - 1));
    c->pf = parity8((uint32_t)result);
    c->af = (uint32_t)((left ^ right ^ result) >> 4) & 1u;
    if (subtract) {
        c->cf = left < right + carry;
        c->of = (uint32_t)(((left ^ right) & (left ^ result)) >> (bits - 1)) & 1u;
    } else {
        c->cf = left + right + carry > mask;
        c->of = (uint32_t)((~(left ^ right) & (left ^ result)) >> (bits - 1)) & 1u;
    }
}

uint64_t wc3_atomic_rmw(CPU *c, uint32_t address, unsigned bits,
                      enum wc3_atomic_operation operation, uint64_t value, uint64_t compare) {
    if (!c || (bits != 8 && bits != 16 && bits != 32 && bits != 64))
        wc3_cpu_fault(c, address, "invalid atomic CPU/width");
    unsigned bytes = bits / 8;
    if (address & (bytes - 1))
        wc3_cpu_fault(c, address, "unaligned LOCK operand is not supported");
    if (!g_mem || (uint64_t)address + bytes > g_mem_size)
        wc3_cpu_fault(c, address, "atomic operand outside guest memory");
    /* LOCK accesses obey the same reserve/commit permissions as MR*. */
    void *pointer = wc3_mem_ptr(address, bytes);
    if (bits == 64 && operation != WC3_ATOMIC_CMPXCHG8B)
        wc3_cpu_fault(c, address, "unsupported 64-bit atomic operation");
    if (operation == WC3_ATOMIC_CMPXCHG8B && bits != 64)
        wc3_cpu_fault(c, address, "CMPXCHG8B requires 64 bits");
    uint64_t mask = bits == 64 ? UINT64_MAX : (UINT64_C(1) << bits) - 1;
    value &= mask;
    compare &= mask;
    unsigned carry = c->cf & 1u;
    uint64_t old = atomic_read(pointer, bits), desired;
    do {
        switch (operation) {
        case WC3_ATOMIC_ADD: case WC3_ATOMIC_XADD: desired = old + value; break;
        case WC3_ATOMIC_ADC: desired = old + value + carry; break;
        case WC3_ATOMIC_SUB: desired = old - value; break;
        case WC3_ATOMIC_SBB: desired = old - value - carry; break;
        case WC3_ATOMIC_AND: desired = old & value; break;
        case WC3_ATOMIC_OR: desired = old | value; break;
        case WC3_ATOMIC_XOR: desired = old ^ value; break;
        case WC3_ATOMIC_INC: desired = old + 1; break;
        case WC3_ATOMIC_DEC: desired = old - 1; break;
        case WC3_ATOMIC_NEG: desired = 0 - old; break;
        case WC3_ATOMIC_NOT: desired = ~old; break;
        case WC3_ATOMIC_XCHG: desired = value; break;
        case WC3_ATOMIC_CMPXCHG: case WC3_ATOMIC_CMPXCHG8B:
            desired = old == compare ? value : old; break;
        case WC3_ATOMIC_BTS: desired = old | (UINT64_C(1) << (value % bits)); break;
        case WC3_ATOMIC_BTR: desired = old & ~(UINT64_C(1) << (value % bits)); break;
        case WC3_ATOMIC_BTC: desired = old ^ (UINT64_C(1) << (value % bits)); break;
        default: wc3_cpu_fault(c, address, "invalid atomic operation");
        }
        desired &= mask;
    } while (!atomic_compare(pointer, bits, &old, desired));

    switch (operation) {
    case WC3_ATOMIC_ADD: case WC3_ATOMIC_XADD:
        arithmetic_flags(c, old, value, 0, desired, bits, 0); break;
    case WC3_ATOMIC_ADC: arithmetic_flags(c, old, value, carry, desired, bits, 0); break;
    case WC3_ATOMIC_SUB: arithmetic_flags(c, old, value, 0, desired, bits, 1); break;
    case WC3_ATOMIC_SBB: arithmetic_flags(c, old, value, carry, desired, bits, 1); break;
    case WC3_ATOMIC_INC:
        arithmetic_flags(c, old, 1, 0, desired, bits, 0); c->cf = carry; break;
    case WC3_ATOMIC_DEC:
        arithmetic_flags(c, old, 1, 0, desired, bits, 1); c->cf = carry; break;
    case WC3_ATOMIC_NEG: arithmetic_flags(c, 0, old, 0, desired, bits, 1); break;
    case WC3_ATOMIC_AND: case WC3_ATOMIC_OR: case WC3_ATOMIC_XOR:
        c->cf = c->of = c->af = 0;
        c->zf = desired == 0; c->sf = (uint32_t)(desired >> (bits - 1));
        c->pf = parity8((uint32_t)desired); break;
    case WC3_ATOMIC_CMPXCHG:
        /* Intel: flags are ACC - DEST, not DEST - ACC. */
        arithmetic_flags(c, compare, old, 0, compare - old, bits, 1);
        if (!c->zf) c->eax = (c->eax & ~(uint32_t)mask) | (uint32_t)old;
        break;
    case WC3_ATOMIC_CMPXCHG8B:
        c->zf = old == compare;
        if (!c->zf) { c->eax = (uint32_t)old; c->edx = (uint32_t)(old >> 32); }
        break;
    case WC3_ATOMIC_BTS: case WC3_ATOMIC_BTR: case WC3_ATOMIC_BTC:
        c->cf = (uint32_t)(old >> (value % bits)) & 1u; break;
    default: break; /* NOT and XCHG preserve flags. */
    }
    return old;
}

void wc3_memory_fence(void) {
    atomic_thread_fence(memory_order_seq_cst);
}
