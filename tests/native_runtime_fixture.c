#include "runtime.h"
#define EXPORT(name) __attribute__((export_name(#name)))
static void compare(CPU *c) {
    uint32_t a=MR32(c->esp+4), b=MR32(c->esp+8);
    int32_t x=(int32_t)MR32(a), y=(int32_t)MR32(b);
    c->eax=(x>y)-(x<y); POP32(c->eip);
}
static const uint32_t count=1, addresses[]={0x100000};
static const guest_fn_t functions[]={compare};
const Wc3LiftTable wc3_tables[]={{&count,addresses,functions}};
const unsigned wc3_table_count=1;
EXPORT(fixture_import) void fixture_import(CPU *c,uint32_t id) { dispatch_indirect(c,0xf1000000u+id*16u); }
EXPORT(fixture_read) uint32_t fixture_read(uint32_t p) { return MR32(p); }
