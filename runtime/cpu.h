/* Warcraft x86 CPU ABI and helpers, adapted from nfsu2-web.
 * Upstream MIT attribution: ../vendor/nfsu2/LICENSE and provenance.json.
 * CPU layout and arithmetic helpers are retained; NFS memory/dispatch,
 * split-screen hooks and fixed address windows have been removed.
 * x87 uses double, not full 80-bit precision; see upstream limitations.
 */
#ifndef WC3_CPU_H
#define WC3_CPU_H
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct CPU;
extern uint8_t *g_mem;
extern uint64_t g_mem_size;
/* One bit per 4 KiB guest page: 1=RW, 0=NOACCESS. A null map preserves
 * the accessible-memory behavior used by isolated CPU fixtures. Runtime
 * initialization allocates the map before exposing VirtualAlloc/Protect. */
#define WC3_PAGE_SHIFT 12u
#define WC3_PAGE_BYTES (1u << WC3_PAGE_SHIFT)
extern uint8_t *g_page_access;
extern uint32_t g_page_count;
int wc3_memory_permissions_init(uint64_t capacity);
int wc3_memory_protect(uint32_t address, uint32_t size, int access);
_Noreturn void wc3_cpu_fault(struct CPU *c, uint32_t address, const char *reason);
/* Strict check: bounds plus page permissions. Out of line: inlining page scans
 * at millions of lifted accesses inflated the Wasm from ~204 MiB to ~576 MiB. */
__attribute__((noinline)) uint8_t *wc3_mem_check(uint32_t address, size_t bytes);
__attribute__((noinline, cold)) _Noreturn void wc3_mem_fault(uint32_t address);
/* Lifted code reaches guest memory through wc3_mem_ptr on every access, so
 * its cost dominated translated game code (about half of the main thread).
 * The default fast path only keeps the bounds check, which protects the
 * runtime's own linear memory; page permissions (MEM_RESERVE vs MEM_COMMIT,
 * the null page) are still maintained for the host and are enforced in
 * guest code by building with -DWC3_STRICT_MEMORY=1 for diagnostics. A valid
 * program never touches such pages, and guest SEH cannot handle the fault. */
#ifndef WC3_STRICT_MEMORY
#define WC3_STRICT_MEMORY 0
#endif
/* In WebAssembly the guest address space starts at a fixed address,
 * WC3_GUEST_BASE (where the runtime's initial memory ends), inside a
 * power-of-two window that belongs to the guest alone: wc3_init grows the
 * memory over [WC3_GUEST_BASE, WC3_GUEST_BASE + WC3_GUEST_WINDOW + 16) and the
 * runtime's own allocations live below it or after it. Native test fixtures
 * keep a malloc'd g_mem (WC3_FIXED_GUEST 0). */
#if defined(__wasm__) && !defined(WC3_DYNAMIC_GUEST)
#define WC3_FIXED_GUEST 1
#else
#define WC3_FIXED_GUEST 0
#endif
#ifndef WC3_GUEST_BASE
#define WC3_GUEST_BASE 0x04000000u
#endif
#ifndef WC3_GUEST_WINDOW
#define WC3_GUEST_WINDOW 0x80000000u
#endif
_Static_assert((WC3_GUEST_WINDOW & (WC3_GUEST_WINDOW - 1u)) == 0 && WC3_GUEST_WINDOW <= 0x80000000u,
               "The guest window is a power of two of at most 2 GiB");
#if WC3_STRICT_MEMORY
static inline uint8_t *wc3_mem_ptr(uint32_t address, size_t bytes) { return wc3_mem_check(address, bytes); }
#elif WC3_FIXED_GUEST
/* The mask keeps every access inside the guest window, so the runtime's own
 * memory is unreachable without a compare and a branch at each of the
 * millions of lifted access sites, and with a constant base the engine folds
 * the base into the load's offset. Lifted code is about 40% smaller than with
 * the bounds check below, and the engines need correspondingly less memory and
 * time to compile it. An address at or past the capacity reaches the unused
 * zero tail of the window or, from 2 GiB on, aliases guest memory: a valid
 * program makes no such access (Win32 user space of a program that is not
 * large-address aware ends below 2 GiB), and WC3_STRICT_MEMORY=1 builds still
 * report them. */
static inline __attribute__((always_inline)) uint8_t *wc3_mem_ptr(uint32_t address, size_t bytes) {
    (void)bytes;
    return (uint8_t *)(uintptr_t)WC3_GUEST_BASE + (address & (WC3_GUEST_WINDOW - 1u));
}
#else
/* Guest operands are at most 16 bytes and wc3_init allocates 16 bytes of
 * slack, so one 32-bit compare of the start address suffices (capacity is at
 * most 2 GiB). This keeps the inlined check small at a million access sites. */
static inline __attribute__((always_inline)) uint8_t *wc3_mem_ptr(uint32_t address, size_t bytes) {
    (void)bytes;
    if (__builtin_expect(address >= (uint32_t)g_mem_size, 0)) wc3_mem_fault(address);
    return g_mem + address;
}
#endif
/* Packed aliasing wrappers preserve x86 unaligned access and cross-type
 * stores. Guest execution must be serialized by the runtime, except for
 * the explicitly atomic helpers below; the CPU ABI itself has no lock. */
#define WC3_PACKED(name, type) typedef struct __attribute__((packed, may_alias)) { type value; } name
WC3_PACKED(wc3_u16, uint16_t); WC3_PACKED(wc3_u32, uint32_t); WC3_PACKED(wc3_u64, uint64_t);
WC3_PACKED(wc3_f32, float); WC3_PACKED(wc3_f64, double);
#undef WC3_PACKED
#define MR8(a) (*(uint8_t *)wc3_mem_ptr((uint32_t)(a), 1))
#define MR16(a) (((wc3_u16 *)wc3_mem_ptr((uint32_t)(a), 2))->value)
#define MR32(a) (((wc3_u32 *)wc3_mem_ptr((uint32_t)(a), 4))->value)
#define MR64(a) (((wc3_u64 *)wc3_mem_ptr((uint32_t)(a), 8))->value)
#define MRF32(a) (((wc3_f32 *)wc3_mem_ptr((uint32_t)(a), 4))->value)
#define MRF64(a) (((wc3_f64 *)wc3_mem_ptr((uint32_t)(a), 8))->value)

enum { R_EAX=0,R_ECX,R_EDX,R_EBX,R_ESP,R_EBP,R_ESI,R_EDI };
void dispatch_indirect(struct CPU *c, uint32_t address);
void dispatch_tail(struct CPU *c);
/* Used by the builder's virtual self-call loop; preserves trace/budget checks. */
void wc3_record_dispatch(struct CPU *c, uint32_t address);
typedef void (*guest_fn_t)(struct CPU *);
#define DISPATCH_CALL(c_, address_) dispatch_indirect((c_), (uint32_t)(address_))
/* A jump to an address in a register or memory (x86 "jmp eax", including
 * switch tables) leaves the lifted function for its target. With WebAssembly
 * tail calls that is a return_call and the stack does not grow; a loop over a
 * switch makes such a jump on every pass. Engines without them (Safari before
 * 18.2, Chrome before 112, Firefox before 121) get a build with
 * WC3_TAIL_TRAMPOLINE (tools/build_runtime.py --variant compat): the jump
 * records its target and returns, and the caller makes it. That build adds
 * TAIL_RESUME after every direct call in lifted code; dispatch_indirect and
 * the runtime's own calls do the same. */
#if defined(__wasm__) && defined(WC3_TAIL_TRAMPOLINE)
#ifdef __wasm_tail_call__
#error "WC3_TAIL_TRAMPOLINE is the build without WebAssembly tail calls (-mno-tail-call)"
#endif
extern _Thread_local uint32_t wc3_tail_pending;
void wc3_tail_resume(struct CPU *c);
#define DISPATCH_TAIL(c_, address_) { (c_)->eip = (uint32_t)(address_); wc3_tail_pending = 1; return; }
#define TAIL_RESUME(c_) do { if (__builtin_expect(wc3_tail_pending, 0)) wc3_tail_resume(c_); } while (0)
#elif defined(__wasm__)
#ifndef __wasm_tail_call__
#error "Lifted code needs WebAssembly tail calls (-mtail-call) or the trampoline build (--variant compat)"
#endif
#define DISPATCH_TAIL(c_, address_) { (c_)->eip = (uint32_t)(address_); __attribute__((musttail)) return dispatch_tail(c_); }
#define TAIL_RESUME(c_) ((void)0)
#else
#define DISPATCH_TAIL(c_, address_) { (c_)->eip = (uint32_t)(address_); dispatch_tail(c_); return; }
#define TAIL_RESUME(c_) ((void)0)
#endif

typedef struct CPU {
    union {
        uint32_t r[8];
        struct { uint32_t eax,ecx,edx,ebx,esp,ebp,esi,edi; };
    };
    uint32_t eip;
    uint32_t fs_base, gs_base;   /* TEB / TLS base (flat model) */
    /* flags - each kept as 0/1 (clang DCE drops the unused ones) */
    uint32_t cf,pf,af,zf,sf,of,df;
    /* x87 stack */
    double   st[8];
    int32_t  top;
    uint16_t fcw, fsw;
    /* MMX (not shared with x87, kept separately) */
    uint64_t mm[8];
    /* SSE */
    union { uint8_t b[16]; float f[4]; double d[2]; uint32_t u32[4]; uint64_t u64[2]; } xmm[8];
    /* EFLAGS system bits (preserved by pushfd/popfd): ID (21), AC (18).
     * Without them the game's "is CPUID there" test (it tries to flip the
     * ID bit, 0x5CDCF5 / 0x5C0B09) always failed, the CPU MHz was never
     * measured and the first run picked performance level 0. */
    uint32_t sysfl;
} CPU;

/* ---- registers and flags in locals (tools/lregs.py, LREGS) ------------
 * A shard lifted with LREGS=1 defines WC3_LREGS: its functions keep the
 * general registers and the six arithmetic flags in locals (_r_eax ...
 * _r_of) and store them to the CPU struct only around calls, returns, tail
 * jumps and the helpers that take the CPU (the stores are written out by
 * tools/lregs.py, which knows what changed).  RG_() names them in the macros
 * below; everywhere else they are the struct's fields.  LR_FG / LR_FF reload
 * the registers / flags from the struct after a call. */
#ifdef WC3_LREGS
#define RG_(x) _r_##x
#else
#define RG_(x) c->x
#endif
#define LR_ENTER uint32_t _r_eax = c->eax, _r_ecx = c->ecx, _r_edx = c->edx, _r_ebx = c->ebx, \
    _r_esp = c->esp, _r_ebp = c->ebp, _r_esi = c->esi, _r_edi = c->edi, \
    _r_cf = c->cf, _r_pf = c->pf, _r_af = c->af, _r_zf = c->zf, _r_sf = c->sf, _r_of = c->of
#define LR_FG do{ _r_eax = c->eax; _r_ecx = c->ecx; _r_edx = c->edx; _r_ebx = c->ebx; \
    _r_esp = c->esp; _r_ebp = c->ebp; _r_esi = c->esi; _r_edi = c->edi; }while(0)
#define LR_FF do{ _r_cf = c->cf; _r_pf = c->pf; _r_af = c->af; _r_zf = c->zf; _r_sf = c->sf; _r_of = c->of; }while(0)
/* pushfd / popfd on the locals (eflags_get / eflags_set below) */
#define LR_EFLAGS_GET() (0x00000202u | (_r_cf&1u) | ((_r_pf&1u)<<2) | ((_r_af&1u)<<4) \
    | ((_r_zf&1u)<<6) | ((_r_sf&1u)<<7) | ((c->df&1u)<<10) | ((_r_of&1u)<<11) | (c->sysfl & 0x00240000u))
#define LR_EFLAGS_SET(f) do{ uint32_t _ef = (f); _r_cf = _ef&1u; _r_pf = (_ef>>2)&1u; _r_af = (_ef>>4)&1u; \
    _r_zf = (_ef>>6)&1u; _r_sf = (_ef>>7)&1u; c->df = (_ef>>10)&1u; _r_of = (_ef>>11)&1u; \
    c->sysfl = _ef & 0x00240000u; }while(0)

/* ---- flag helpers ----------------------------------------------------- */
static inline uint32_t parity8(uint32_t v){ v&=0xff; v^=v>>4; v^=v>>2; v^=v>>1; return (~v)&1; }

/* ---- flag masks --------------------------------------------------------
 * Every arithmetic instruction computed all six flags EAGERLY (ZF/SF/PF/CF/OF/AF),
 * but the following branch usually reads only one.  Measured: the generated
 * code has 110k FLAGS_ADD + 130k FLAGS_SUB + 130k FLAGS_LOG, while OF is
 * read directly in only 22 places (CC_O/CC_NO) and PF in 5.7k.
 * The generator (tools/lift.py) now solves flag LIVENESS over the control
 * flow graph and passes each call a "flags read later" mask.  The mask is a
 * compile-time constant, so the unused branches are removed entirely.     */
#define F_CF  0x01u
#define F_PF  0x02u
#define F_AF  0x04u
#define F_ZF  0x08u
#define F_SF  0x10u
#define F_OF  0x20u
#define F_ALL 0x3Fu

#define SETZSP_M(res,bits,M) do{ \
    if((M)&F_ZF) RG_(zf) = ((uint##bits##_t)(res)==0); \
    if((M)&F_SF) RG_(sf) = (((uint##bits##_t)(res))>>((bits)-1))&1; \
    if((M)&F_PF) RG_(pf) = parity8((uint32_t)(res)); }while(0)
#define SETZSP(res,bits) SETZSP_M(res,bits,F_ALL)

/* ADD */
#define FLAGS_ADD_M(a,b,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) RG_(cf) = ((uint##bits##_t)(res) < (uint##bits##_t)(a)); \
    if((M)&F_AF) RG_(af) = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) RG_(of) = ((~((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_ADD(a,b,res,bits) FLAGS_ADD_M(a,b,res,bits,F_ALL)
/* SUB / CMP */
#define FLAGS_SUB_M(a,b,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) RG_(cf) = ((uint##bits##_t)(a) < (uint##bits##_t)(b)); \
    if((M)&F_AF) RG_(af) = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) RG_(of) = ((((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_SUB(a,b,res,bits) FLAGS_SUB_M(a,b,res,bits,F_ALL)
/* ADC/SBB: with carry-in 1 the result can EQUAL the input; the (res<a)
 * test then missed the carry (example: sbb eax,eax  CF=1 -> CF=1).       */
#define FLAGS_ADC_M(a,b,cin,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) RG_(cf) = (cin) ? ((uint##bits##_t)(res) <= (uint##bits##_t)(a)) \
                               : ((uint##bits##_t)(res) <  (uint##bits##_t)(a)); \
    if((M)&F_AF) RG_(af) = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) RG_(of) = ((~((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_ADC(a,b,cin,res,bits) FLAGS_ADC_M(a,b,cin,res,bits,F_ALL)
#define FLAGS_SBB_M(a,b,cin,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) RG_(cf) = (cin) ? ((uint##bits##_t)(a) <= (uint##bits##_t)(b)) \
                               : ((uint##bits##_t)(a) <  (uint##bits##_t)(b)); \
    if((M)&F_AF) RG_(af) = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) RG_(of) = ((((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_SBB(a,b,cin,res,bits) FLAGS_SBB_M(a,b,cin,res,bits,F_ALL)
/* logical: CF=OF=0 */
#define FLAGS_LOG_M(res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) RG_(cf)=0; if((M)&F_OF) RG_(of)=0; if((M)&F_AF) RG_(af)=0; }while(0)
#define FLAGS_LOG(res,bits) FLAGS_LOG_M(res,bits,F_ALL)

/* ---- stack ------------------------------------------------------------ */
/* CRITICAL: the operand may depend on esp (example: push [esp+8], push esp).
 * x86 semantics: PUSH reads the value first, then decrements esp.        */
#define PUSH32(v) do{ uint32_t _pv = (uint32_t)(v); RG_(esp) -= 4; MR32(RG_(esp)) = _pv; }while(0)
/* POP: esp is incremented first; the destination address uses the NEW esp (pop [esp+N]). */
#define POP32(d)  do{ uint32_t _qv = MR32(RG_(esp)); RG_(esp) += 4; (d) = _qv; }while(0)

/* ---- conditions ------------------------------------------------------- */
#define CC_O   (RG_(of))
#define CC_NO  (!RG_(of))
#define CC_B   (RG_(cf))
#define CC_AE  (!RG_(cf))
#define CC_E   (RG_(zf))
#define CC_NE  (!RG_(zf))
#define CC_BE  (RG_(cf)||RG_(zf))
#define CC_A   (!RG_(cf)&&!RG_(zf))
#define CC_S   (RG_(sf))
#define CC_NS  (!RG_(sf))
#define CC_P   (RG_(pf))
#define CC_NP  (!RG_(pf))
#define CC_L   (RG_(sf)!=RG_(of))
#define CC_GE  (RG_(sf)==RG_(of))
#define CC_LE  (RG_(zf)||(RG_(sf)!=RG_(of)))
#define CC_G   (!RG_(zf)&&(RG_(sf)==RG_(of)))


/* ---- x87 FPU stack ----------------------------------------------------
 * NOTE: ARM64 has no 80-bit extended float; we use double (64-bit).
 * This can deviate slightly from x86's 80-bit intermediate precision.    */
#define ST(n)    (c->st[(c->top + (n)) & 7])
/* CAUTION: the source value must be computed BEFORE top changes.  ST(i) is
 * defined relative to top, so "fld st(0)" in the old FPUSH read the newly
 * opened empty slot -> it loaded garbage instead of copying itself.  That
 * broke the CRT's __ftol routine (it starts with fld st(0)), i.e. EVERY
 * float->int conversion in the game.  Symptom: the frame-delta measurement
 * always came out as 1 unit. */
#define FPUSH(v) do{ double _fpv = (double)(v); \
    c->top = (c->top - 1) & 7; c->st[c->top] = _fpv; }while(0)
#define FPOP()   do{ c->top = (c->top + 1) & 7; }while(0)

/* x87 compare -> status word C0/C2/C3 bits (8/10/14) */
#define FSW_C0 (1u<<8)
#define FSW_C1 (1u<<9)
#define FSW_C2 (1u<<10)
#define FSW_C3 (1u<<14)
/* fnstsw: on real hardware the TOP field (bits 11-13) is read as well. */
static inline uint16_t fsw_get(const struct CPU *c){
    return (uint16_t)((c->fsw & (uint16_t)~0x3800u) | (uint16_t)((c->top & 7u) << 11));
}
/* X87OPT: with in-block x87 register allocation c->top is written at the end
 * of the region; fnstsw takes the (static) top at that point explicitly. */
static inline uint16_t fsw_get_top(const struct CPU *c, uint32_t top){
    return (uint16_t)((c->fsw & (uint16_t)~0x3800u) | (uint16_t)((top & 7u) << 11));
}
static inline void fcompare(struct CPU *c, double a, double b){
    c->fsw &= (uint16_t)~(FSW_C0|FSW_C2|FSW_C3);
    if (a != a || b != b)      c->fsw |= FSW_C0|FSW_C2|FSW_C3;  /* unordered (NaN) */
    else if (a > b)            ;                                 /* all 0 */
    else if (a < b)            c->fsw |= FSW_C0;
    else                       c->fsw |= FSW_C3;
}
/* fcomi / fucomi: write EFLAGS directly */
#define FCOMI(a,b) do{ double _x=(a),_y=(b); \
    if(_x!=_x||_y!=_y){ RG_(zf)=1;RG_(pf)=1;RG_(cf)=1; } \
    else { RG_(pf)=0; RG_(zf)=(_x==_y); RG_(cf)=(_x<_y); } RG_(of)=RG_(sf)=RG_(af)=0; }while(0)

/* ---- EFLAGS pack/unpack (pushfd/popfd/sahf) --------------------------- */
static inline uint32_t eflags_get(const struct CPU *c){
    return 0x00000202u | (c->cf&1u) | ((c->pf&1u)<<2) | ((c->af&1u)<<4)
         | ((c->zf&1u)<<6) | ((c->sf&1u)<<7) | ((c->df&1u)<<10) | ((c->of&1u)<<11)
         | (c->sysfl & 0x00240000u);
}
static inline void eflags_set(struct CPU *c, uint32_t f){
    c->cf=f&1u; c->pf=(f>>2)&1u; c->af=(f>>4)&1u;
    c->zf=(f>>6)&1u; c->sf=(f>>7)&1u; c->df=(f>>10)&1u; c->of=(f>>11)&1u;
    c->sysfl = f & 0x00240000u;
}

/* ---- string instructions ---------------------------------------------- */
#define DFSTEP(n) (c->df ? -(int32_t)(n) : (int32_t)(n))

/* x87 rounding: the result follows the control word's RC field (bits 10-11).
 * 00=nearest (even), 01=down, 10=up, 11=toward zero (chop).
 * The CRT's __ftol routine sets RC to 11 and calls fistp; if we ignore that,
 * every float->int conversion comes out one too high when the fraction >= 0.5. */
static inline double x87_round(uint16_t fcw, double v){
    switch ((fcw >> 10) & 3u){
    case 0:  return nearbyint(v);      /* host mode: nearest, even */
    case 1:  return floor(v);
    case 2:  return ceil(v);
    default: return trunc(v);
    }
}

/* ---- x87 precision control (lift-time X87PC=1, tools/lift.py) ---------
 * The hardware rounds the result of FADD/FSUB/FMUL/FDIV/FSQRT (and their
 * P/R/I forms) to the significand width the control word's PC field
 * (bits 8-9) selects: 00 = 24 bits, 10 = 53, 11 = 64.  The game's main
 * thread runs at PC=00 on Windows (Direct3D's CreateDevice without
 * D3DCREATE_FPU_PRESERVE sets it), so its intermediates are single
 * precision with the extended exponent range.  Our registers are doubles:
 * PC=53/64 stay double, PC=24 rounds the double result to 24 bits in the
 * rounding direction of the RC field.  The double is the correctly rounded
 * (to nearest) exact result, so with RC = nearest this is exact whenever
 * both operands have at most 24 significant bits (Figueroa: 53 >= 2*24+2);
 * with a wider operand (fild of a big int, a double constant) a 24-bit tie
 * can very rarely round differently.  With RC = down/up/chop it is NOT
 * exact: when the nearest double is itself a 24-bit value (e.g. an add or
 * subtract of operands more than ~29 binary orders apart) the directed
 * rounding is lost, 1 ulp off (checked against Unicorn's x87).  The game
 * does no x87 arithmetic at such RC on its PC=24 thread (its fldcw sites
 * are float->int loops and CRT/D3DX code at PC=64), so this is accepted.
 * Exponent range: extended vs double, irrelevant here.                   */
/* Out of line and cold: the fast path below inlines only the FCVT pair, which
 * keeps an X87PC=1 build ~20 MB smaller. */
static __attribute__((noinline, cold, unused)) double x87_round24(double v, uint32_t rc){
    uint64_t b; memcpy(&b, &v, 8);
    uint64_t low = b & 0x1FFFFFFFull;            /* the 29 bits below 24 */
    if (!low || ((b >> 52) & 0x7FFu) == 0x7FFu) return v;   /* exact, inf, nan */
    uint64_t t = b - low;                        /* toward zero */
    int up;
    if (rc == 0) up = low > 0x10000000ull || (low == 0x10000000ull && (t & 0x20000000ull));
    else if (rc == 3) up = 0;
    else up = (int)(b >> 63) == (rc == 1);       /* down: negatives grow; up: positives */
    if (up) t += 0x20000000ull;
    memcpy(&v, &t, 8); return v;
}
/* PC=24 with RC=nearest (the game thread's word): the hardware double->float
 * conversion rounds to nearest even exactly like x87_round24 as long as the
 * result is a normal float, and is ~40% cheaper on the dependency chain.
 * Zero, float subnormals, overflow and NaN take the exact path. */
static inline double x87_pcround(uint16_t fcw, double v){
    if (__builtin_expect((fcw & 0x0F00u) == 0u, 1)){
        float f = (float)v, a = __builtin_fabsf(f);
        if (__builtin_expect(a > 0x1p-126f && a <= 0x1.fffffep127f, 1)) return (double)f;
#ifdef __wasm__
        /* Zero is exact too.  The game's matrix products make many zero
         * terms, and on wasm their call to the out-of-line path cost ~1.4 %
         * of a race frame. */
        if (v == 0.0) return v;
#endif
        return x87_round24(v, 0);
    }
    if (fcw & 0x0300u) return v;                 /* PC=53/64: double */
    return x87_round24(v, (fcw >> 10) & 3u);
}
#define X87R(v) x87_pcround(c->fcw, (v))

/* ---- invalid-operation results and out-of-range conversions ----------
 * On x86 invalid operations such as 0/0, sqrt(-x) produce "real indefinite":
 * a quiet NaN with a NEGATIVE sign.  C's sqrt/0.0 result is a positive NaN,
 * so it has to be fixed up separately.  If one of the inputs is a NaN, that
 * one propagates.                                                       */
#define X87_INDEF (-__builtin_nan(""))
/* Two NaN operands: the x87 returns the one with the LARGER significand
 * (Intel SDM vol. 1, table 4-7); the ARM FPU (and the old code here) returns
 * the first.  Found by the drift oracle (runtime/oracle.c): the rigid-
 * body integrator 0x5AA480 adds NaN garbage of unused state slots.
 * The NaN path is out of line and cold: inlined at every x87 operation it
 * made the lifted code ~8 MB (17 %) larger, X87PC=0 builds included. */
static __attribute__((noinline, cold, unused)) double x87_r2_nan(double a, double b){
    if (a != a && b != b){
        uint64_t x, y; memcpy(&x, &a, 8); memcpy(&y, &b, 8);
        return (y & 0x000FFFFFFFFFFFFFull) > (x & 0x000FFFFFFFFFFFFFull) ? b : a;
    }
    if (a != a) return a;
    if (b != b) return b;
    return X87_INDEF;
}
static inline double x87_r2(double a, double b, double r){
    if (__builtin_expect(r == r, 1)) return r;
    return x87_r2_nan(a, b);
}
static inline double x87_r1(double a, double r){
    if (r == r) return r;
    if (a != a) return a;
    return X87_INDEF;
}
/* X87R(x87_r2(a, b, r)) in one test (tools/lift.py emits X87R2 for the x87
 * arithmetic).  On the game thread's word (PC=24, RC=nearest) a result in the
 * normal float range is no NaN, so the NaN test of x87_r2 is only made on the
 * way to the out-of-line path, which does the two in a row.  Same results:
 * that path is taken for everything the fast tests below do not decide. */
static __attribute__((noinline, cold, unused)) double x87_r2pc_slow(uint16_t fcw, double a, double b, double r){
    return x87_pcround(fcw, x87_r2(a, b, r));
}
static inline double x87_r2pc(uint16_t fcw, double a, double b, double r){
    if (__builtin_expect((fcw & 0x0F00u) == 0u, 1)){
        float f = (float)r, m = __builtin_fabsf(f);
        if (__builtin_expect(m > 0x1p-126f && m <= 0x1.fffffep127f, 1)) return (double)f;
        if (r == 0.0) return r;                  /* exact (see x87_pcround) */
    } else if ((fcw & 0x0300u) && __builtin_expect(r == r, 1)) return r;   /* PC=53/64 */
    return x87_r2pc_slow(fcw, a, b, r);
}
#define X87R2(a, b, r) x87_r2pc(c->fcw, (a), (b), (r))
static inline float sse_r2f(float a, float b, float r){
    if (r == r) return r;
    if (a != a) return a;
    if (b != b) return b;
    return (float)X87_INDEF;
}
static inline float sse_r1f(float a, float r){
    if (r == r) return r;
    if (a != a) return a;
    return (float)X87_INDEF;
}
static inline double sse_r2d(double a, double b, double r){ return x87_r2(a,b,r); }
static inline double sse_r1d(double a, double r){ return x87_r1(a,r); }

/* Out of range / NaN -> "integer indefinite" (the most negative value). */
static inline uint32_t x86_cvt_i32(double v){
    if (!(v >= -2147483648.0 && v <= 2147483647.0)) return 0x80000000u;
    return (uint32_t)(int32_t)v;
}
static inline uint16_t x86_cvt_i16(double v){
    if (!(v >= -32768.0 && v <= 32767.0)) return 0x8000u;
    return (uint16_t)(int16_t)v;
}
static inline uint64_t x86_cvt_i64(double v){
    if (!(v >= -9223372036854775808.0 && v < 9223372036854775808.0))
        return 0x8000000000000000ull;
    return (uint64_t)(int64_t)v;
}

/* ---- 80-bit extended floating point (x87 tbyte) <-> double ----------- */
static inline void f80_store(uint8_t *p, double v){
    /* sign, 15-bit exponent, 64-bit explicit mantissa */
    uint64_t bits; memcpy(&bits, &v, 8);
    uint32_t sign = (uint32_t)(bits >> 63);
    int32_t  exp  = (int32_t)((bits >> 52) & 0x7FF);
    uint64_t man  = bits & 0xFFFFFFFFFFFFFull;
    uint16_t e80; uint64_t m80;
    if (exp == 0x7FF){ e80 = 0x7FFF; m80 = man ? (0xC000000000000000ull | (man << 11)) : 0x8000000000000000ull; }
    else if (exp == 0){
        if (!man){ e80 = 0; m80 = 0; }
        else { int sh = 0; while (!(man & 0x10000000000000ull)) { man <<= 1; sh++; }
               e80 = (uint16_t)(16383 - 1022 - sh); m80 = (man << 11) | 0x8000000000000000ull; }
    } else { e80 = (uint16_t)(exp - 1023 + 16383); m80 = 0x8000000000000000ull | (man << 11); }
    memcpy(p, &m80, 8);
    uint16_t se = (uint16_t)((sign << 15) | e80);
    memcpy(p + 8, &se, 2);
}
static inline double f80_load(const uint8_t *p){
    uint64_t m80; uint16_t se;
    memcpy(&m80, p, 8); memcpy(&se, p + 8, 2);
    uint32_t sign = (uint32_t)(se >> 15);
    int32_t  e80  = (int32_t)(se & 0x7FFF);
    if (e80 == 0 && m80 == 0) return sign ? -0.0 : 0.0;
    if (e80 == 0x7FFF){
        double inf = sign ? -1.0/0.0 : 1.0/0.0;
        return (m80 << 1) ? (0.0/0.0) : inf;
    }
    int32_t exp = e80 - 16383 + 1023;
    uint64_t man = (m80 & 0x7FFFFFFFFFFFFFFFull) >> 11;
    if (exp <= 0)   return sign ? -0.0 : 0.0;
    if (exp >= 0x7FF){ double inf = sign ? -1.0/0.0 : 1.0/0.0; return inf; }
    uint64_t bits = ((uint64_t)sign << 63) | ((uint64_t)(uint32_t)exp << 52) | man;
    double d; memcpy(&d, &bits, 8); return d;
}

/* Runtime provides these hooks; unsupported instructions never succeed. */
void unsupported_insn(CPU *c, uint32_t address, const char *mnemonic);
void cpuid_shim(CPU *c);
uint64_t rdtsc_shim(void);

enum wc3_atomic_operation {
    WC3_ATOMIC_ADD, WC3_ATOMIC_ADC, WC3_ATOMIC_SUB, WC3_ATOMIC_SBB,
    WC3_ATOMIC_AND, WC3_ATOMIC_OR, WC3_ATOMIC_XOR, WC3_ATOMIC_INC,
    WC3_ATOMIC_DEC, WC3_ATOMIC_NEG, WC3_ATOMIC_NOT, WC3_ATOMIC_XCHG,
    WC3_ATOMIC_XADD, WC3_ATOMIC_CMPXCHG, WC3_ATOMIC_CMPXCHG8B,
    WC3_ATOMIC_BTS, WC3_ATOMIC_BTR, WC3_ATOMIC_BTC
};
/* Returns the old memory value. Updates x86 flags; CMPXCHG failure also
 * updates EAX (and EDX for CMPXCHG8B). value and compare are masked to bits.
 * Naturally aligned operands only; unsupported alignment faults explicitly. */
uint64_t wc3_atomic_rmw(CPU *c, uint32_t address, unsigned bits,
                      enum wc3_atomic_operation operation, uint64_t value, uint64_t compare);
void wc3_memory_fence(void);
#endif
