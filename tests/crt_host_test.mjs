import test from 'node:test';
import assert from 'node:assert/strict';
import {WarcraftHost, GuestFault} from '../web/runtime/host.mjs';
import {splitCommandLine} from '../web/runtime/crt.mjs';

function host() {
  let next=0x10000;
  const h=new WarcraftHost({memory:new WebAssembly.Memory({initial:64}),readFile:()=>new Uint8Array()});
  h.base=0;h.currentCPU=0x1000;
  h.exports={wc3_guest_alloc:n=>{const p=next;next+=n;return p;},wc3_cpu_st_offset:()=>72,wc3_cpu_top_offset:()=>136};
  h.view.setUint16(h.currentCPU+140,0x027f,true);
  h.exec=(name,args=[],esp=0x3000)=>h.handlers.get('msvcr80.dll!'+name).fn(args,esp);
  return h;
}

test('CRT memory operations preserve overlap and heap alignment',()=>{
  const h=host(),p=h.alloc(16);h.copyIn(p,Uint8Array.of(1,2,3,4));
  h.exec('memmove',[p+1,p,4]);assert.deepEqual([...h.copyOut(p,5)],[1,1,2,3,4]);
  const aligned=h.allocAligned(4096);assert.equal(aligned%65536,0);assert.equal(h.allocations.get(aligned),4096);
  const grown=h.exec('realloc',[p,64]);assert.deepEqual([...h.copyOut(grown,5)],[1,1,2,3,4]);assert.throws(()=>h.free(p),GuestFault);
});
test('CRT bounded strings, parsing and snprintf count match cdecl conventions',()=>{
  const h=host(),s=h.string('Example'),out=h.alloc(32);
  assert.equal(h.exec('strcpy_s',[out,4,s]),34);assert.equal(h.u8(out),0);
  assert.equal(h.exec('strcpy_s',[out,32,s]),0);assert.equal(h.cstr(out),'Example');
  assert.equal(h.exec('_stricmp',[out,h.string('eXAMPLE')]),0);
  const end=h.alloc(4),number=h.string(' -0x2a!');assert.equal(h.exec('strtol',[number,end,0]),-42);assert.equal(h.u32(end),number+6);
  const format=h.string('%04x %s'),va=h.alloc(8);h.w32(va,42);h.w32(va+4,s);
  assert.equal(h.exec('_vsnprintf',[out,6,format,va]),-1);assert.deepEqual([...h.copyOut(out,6)],[48,48,50,97,32,69]);
});
test('narrow formatted IO preserves UTF-8 and arbitrary high bytes without transcoding',()=>{
  const h=host();h.base=0x4000;
  const out=h.alloc(1024),va=h.alloc(16),pattern=h.string('Задание: %s — %d'),name=h.string('Мэв');
  h.w32(va,name);h.w32(va+4,2);
  const expected=new TextEncoder().encode('Задание: Мэв — 2');
  assert.equal(h.exec('vsprintf',[out,pattern,va]),expected.length);
  assert.deepEqual(h.copyOut(out,expected.length),expected);assert.equal(h.u8(out+expected.length),0);
  h.w8(out+5,99);assert.equal(h.exec('_vsnprintf',[out,5,h.string('%s'),va]),-1);
  assert.deepEqual(h.copyOut(out,5),new TextEncoder().encode('Мэв').slice(0,5));assert.equal(h.u8(out+5),99);
  const raw=h.alloc(129),values=Uint8Array.from({length:128},(_,i)=>128+i);h.copyIn(raw,values);h.w32(va,raw);
  assert.equal(h.exec('vsprintf',[out,h.string('%s'),va]),128);assert.deepEqual(h.copyOut(out,128),values);
  h.w32(va,out);assert.equal(h.exec('vsscanf',[raw,h.string('%s'),va]),1);assert.deepEqual(h.copyOut(out,128),values);
  h.w32(va,name);h.w32(va+4,2);
  assert.equal(h.handlers.get('user32.dll!wvsprintfA').fn([out,pattern,va]),expected.length);
  assert.deepEqual(h.copyOut(out,expected.length),expected);
  const file=h.exec('fopen',[h.string('Save/utf8.txt'),h.string('wb')]);
  assert.equal(h.exec('vfprintf',[file,pattern,va]),expected.length);h.exec('fclose',[file]);
  assert.deepEqual(h.virtualFiles.get('save/utf8.txt'),expected);
});
test('guest heap coalesces adjacent frees and reuses aligned regions without extra padding',()=>{
  const h=host();let next=0x10010,bumps=0;
  h.exports.wc3_guest_alloc=n=>{if(next+n>0x60000)return 0;const p=next;next+=n;bumps++;return p;};
  const a=h.alloc(32),b=h.alloc(48),c=h.alloc(16),guard=h.alloc(16);
  h.free(a);h.free(c);h.free(b);
  const joined=h.alloc(96);assert.equal(joined,a);assert.equal(bumps,4,'combined free space is reused');
  const aligned=h.allocAligned(65536),after=bumps;
  for(let i=0;i<100;i++){
    h.w32(aligned,0xdeadbeef);h.free(aligned);
    assert.equal(h.allocAligned(65536),aligned);assert.equal(h.u32(aligned),0);
  }
  assert.equal(bumps,after,'repeated virtual allocation must not exhaust the bump arena');
  h.free(guard);h.free(joined);h.free(aligned);
  assert.equal(h.freeBlocks.length,1);assert.equal(h.heapStats().liveBytes,0);
  const size=h.freeBlocks[0].size,last=h.alloc(size);assert.equal(last,0x10010);
  assert.throws(()=>h.alloc(0x60000),error=>error instanceof GuestFault&&error.details.heap.liveBytes===size);
});
test('CRT x87 intrinsics return through ST0 and update stack top',()=>{
  const h=host();h.view.setFloat64(0x1000+72,3,true);h.view.setFloat64(0x1000+80,2,true);
  h.exec('_CIpow');assert.equal(h.view.getInt32(0x1000+136,true),1);assert.equal(h.view.getFloat64(0x1000+80,true),8);
  h.exec('_CIsqrt');assert.equal(h.view.getFloat64(0x1000+80,true),Math.sqrt(8));
  const out=h.alloc(4);h.exec('_controlfp_s',[out,0x200,0x300]);assert.equal(h.u32(out)&0x300,0x200);assert.equal(h.view.getUint16(0x1000+140,true)&0xc00,0x800);
});
test('printf consumes exact x86 64-bit varargs and preserves signs, prefixes and precision',()=>{
  const h=host(),out=h.alloc(1024),va=h.alloc(128);
  h.base=0x4000; // Guest addresses and WASM addresses need not coincide.
  const format=(pattern,values)=>{
    let cursor=va;
    for(const value of values){
      if(typeof value==='bigint'){h.view.setBigUint64(h.check(cursor,8),BigInt.asUintN(64,value),true);cursor+=8;}
      else{h.w32(cursor,value>>>0);cursor+=4;}
    }
    const count=h.exec('_vsnprintf',[out,1024,h.string(pattern),va]);
    const result=h.cstr(out);assert.equal(count,result.length);return result;
  };
  assert.equal(format('%d|%I64u|%lld|%I64X|%s',[7,18446744073709551615n,-9223372036854775808n,0x123456789abcdef0n,h.string('tail')]),
    '7|18446744073709551615|-9223372036854775808|123456789ABCDEF0|tail');
  assert.equal(format('%+022I64d|%#018I64x|%08.4d',[9223372036854775807n,0xfedcba9876543210n,-12]),
    '+009223372036854775807|0xfedcba9876543210|   -0012');
  assert.equal(format('[%0*.*I64d][%.0u][%#.0o][%#.0x]',[-8,3,42n,0,0,0]),'[042     ][][0][]');
  assert.equal(format('%hd %hhu %ld %I32u %p', [65535,257,0xffffffff,0xffffffff,0x12ab]),'-1 1 -1 4294967295 000012AB');
  assert.equal(format('%.*I64u/%u',[-1,9007199254740993n,123]),'9007199254740993/123');
  // Exercise the cdecl wrapper: the next argument follows two 32-bit words.
  const esp=0x3000;
  h.view.setBigUint64(h.check(esp+12,8),9007199254740993n,true);h.w32(esp+20,17);
  assert.equal(h.exec('sprintf',[out,h.string('%I64u:%u')],esp),19);
  assert.equal(h.cstr(out),'9007199254740993:17');
});
test('CRT initializer callback order and early error are real',()=>{
  const h=host(),table=h.alloc(16),calls=[];[12,0,16,20].forEach((p,i)=>h.w32(table+i*4,p));
  h.call=fn=>{calls.push(fn);return fn===16?7:0;};
  assert.equal(h.exec('_initterm_e',[table,table+16]),7);assert.deepEqual(calls,[12,16]);
  assert.deepEqual(splitCommandLine('war3.exe -loadfile "Maps\\A B.w3x"'),['war3.exe','-loadfile','Maps\\A B.w3x']);
});
test('CRT floating control translates broad masks, precision, infinity and denormal bits',()=>{
  const h=host(),p=h.currentCPU+140;
  assert.equal(h.exec('_control87',[0,0]),0x9001f);
  assert.equal(h.exec('_control87',[0xe031f,0xffffffff]),0xe031f);
  assert.equal(h.view.getUint16(p,true),0x1c7f);
  assert.equal(h.exec('_control87',[0,0]),0xe031f);
  h.exec('_controlfp',[0,0x80000]);assert.ok(h.view.getUint16(p,true)&2,'controlfp preserves denormal mask');
  h.exec('_control87',[0,0x80000]);assert.equal(h.view.getUint16(p,true)&2,0);
  h.view.setUint16(p+2,0x453f,true);
  assert.equal(h.exec('_clearfp'),0x8001f);assert.equal(h.view.getUint16(p+2,true),0x4500);
});
test('sscanf writes typed outputs and preserves assignment counts, widths and input position',()=>{
  const h=host(),va=h.alloc(24),out=h.alloc(64);
  [out,out+4,out+8,out+16,out+24,out+32].forEach((p,i)=>h.w32(va+i*4,p));
  assert.equal(h.exec('vsscanf',[h.string('1.1 WC3'),h.string('%d.%d%n'),va]),2);
  assert.equal(h.u32(out),1);assert.equal(h.u32(out+4),1);assert.equal(h.u32(out+8),3);
  assert.equal(h.exec('vsscanf',[h.string('-0x2a 077 1.25 abcdef Z'),h.string('%i %o %lf %3[a-z] %*s %c'),va]),5);
  assert.equal(h.i32(out),-42);assert.equal(h.u32(out+4),63);assert.equal(h.view.getFloat64(out+8,true),1.25);
  assert.equal(h.cstr(out+16),'abc');assert.equal(h.u8(out+24),90);
  assert.equal(h.exec('vsscanf',[h.string(''),h.string('%d'),va]),-1);
  assert.equal(h.exec('vsscanf',[h.string('wrong'),h.string('%d'),va]),0);
});
test('HLE dispatch cleans stdcall arguments while preserving cdecl stack',()=>{
  const h=host(),cpu=0x1000,esp=0x3000;
  h.view.setUint32(cpu+16,esp,true);h.w32(esp,0x123456);h.w32(esp+4,1);h.w32(esp+8,2);
  h.add('test.dll','sum',2,([a,b])=>a+b);
  h.invoke((h.resolve('test.dll','sum')-0xf1000000)/16,cpu);
  assert.equal(h.view.getUint32(cpu,true),3);assert.equal(h.view.getUint32(cpu+16,true),esp+12);assert.equal(h.view.getUint32(cpu+32,true),0x123456);
  h.view.setUint32(cpu+16,esp,true);h.w32(esp+4,h.string('42'));
  h.invoke((h.resolve('MSVCR80.dll','atoi')-0xf1000000)/16,cpu);
  assert.equal(h.view.getUint32(cpu,true),42);assert.equal(h.view.getUint32(cpu+16,true),esp+4);
});

test('CRT binary files share Win32 paths, range reads and writable overlay',()=>{
  const h=host(),ranges=[];
  h.listFiles=()=>['Data/Large.mpq'];h.fileSize=()=>512*1024*1024;
  h.readFile=(path,offset,length)=>{ranges.push({path,offset,length});return new Uint8Array(length).fill(42);};
  const fd=h.exec('fopen',[h.string('C:\\Warcraft III\\Data\\Large.mpq'),h.string('rb')]),out=h.alloc(8);
  assert.ok(fd);assert.equal(ranges.length,0,'fopen must not download a whole MPQ');
  assert.equal(h.exec('fread',[out,2,4,fd]),4);assert.deepEqual(ranges,[{path:'Data/Large.mpq',offset:0,length:8}]);
  assert.equal(h.exec('fseek',[fd,512*1024*1024+10,0]),0);
  assert.equal(h.exec('fread',[out,1,8,fd]),0);assert.equal(h.exec('ftell',[fd]),512*1024*1024+10);
  assert.equal(h.exec('feof',[fd]),1);h.exec('fclose',[fd]);
  const saved=h.exec('fopen',[h.string('Save\\Test.w3z'),h.string('wb')]);
  h.copyIn(out,Uint8Array.of(1,2,3));assert.equal(h.exec('fwrite',[out,1,3,saved]),3);h.exec('fclose',[saved]);
  assert.deepEqual([...h.virtualFiles.get('save/test.w3z')],[1,2,3]);
  const append=h.exec('fopen',[h.string('save/test.w3z'),h.string('ab')]);
  h.exec('fseek',[append,0,0]);h.exec('fwrite',[out,1,1,append]);h.exec('fclose',[append]);
  assert.deepEqual([...h.virtualFiles.get('save/test.w3z')],[1,2,3,1]);
  assert.equal(h.exec('fopen',[h.string('../outside'),h.string('wb')]),0);
});

test('CRT text reads translate CRLF, preserve lone CR, and restore ftell cookies',()=>{
  const h=host(),raw=new TextEncoder().encode('A\r\nB\rC\nD\r'),out=h.alloc(32),ranges=[];
  h.listFiles=()=>['Text.txt'];h.fileSize=()=>raw.length;
  h.readFile=(path,offset,length)=>{ranges.push({offset,length});return raw.slice(offset,offset+length);};
  const fd=h.exec('fopen',[h.string('Text.txt'),h.string('r')]);
  assert.equal(ranges.length,0);
  assert.equal(h.exec('fread',[out,1,1,fd]),1);assert.equal(h.u8(out),65);
  const beforeCRLF=h.exec('ftell',[fd]);
  assert.equal(h.exec('fread',[out,1,1,fd]),1);assert.equal(h.u8(out),10);
  const afterCRLF=h.exec('ftell',[fd]);assert.equal(afterCRLF,3);
  assert.equal(h.exec('fseek',[fd,beforeCRLF,0]),0);
  assert.equal(h.exec('fread',[out,1,1,fd]),1);assert.equal(h.u8(out),10);
  assert.equal(h.exec('ftell',[fd]),afterCRLF);
  assert.equal(h.exec('fread',[out,1,32,fd]),6);
  assert.deepEqual([...h.copyOut(out,6)],[66,13,67,10,68,13]);
  assert.equal(h.exec('feof',[fd]),1);assert.equal(h.exec('ferror',[fd]),0);
  assert.equal(h.exec('fseek',[fd,0,0]),0);assert.equal(h.exec('feof',[fd]),0);
  assert.equal(h.exec('fread',[out,3,4,fd]),2,'return complete elements, including copied partial final element');
  assert.deepEqual([...h.copyOut(out,8)],[65,10,66,13,67,10,68,13]);
  h.exec('fclose',[fd]);
});

test('CRT text Ctrl-Z is sticky EOF and its cookie restores the marker',()=>{
  const h=host(),out=h.alloc(32);h.virtualFiles.set('ctrlz.txt',Uint8Array.of(65,13,10,26,66,10));
  const fd=h.exec('fopen',[h.string('ctrlz.txt'),h.string('rt')]);
  assert.equal(h.exec('fread',[out,1,32,fd]),2);assert.deepEqual([...h.copyOut(out,2)],[65,10]);
  const eof=h.exec('ftell',[fd]);assert.equal(eof,3);assert.equal(h.exec('feof',[fd]),1);
  assert.equal(h.exec('fread',[out,1,32,fd]),0);assert.equal(h.exec('ftell',[fd]),eof);
  assert.equal(h.exec('fseek',[fd,eof,0]),0);assert.equal(h.exec('feof',[fd]),0);
  assert.equal(h.exec('fread',[out,1,32,fd]),0);assert.equal(h.exec('feof',[fd]),1);
  h.exec('clearerr',[fd]);assert.equal(h.exec('feof',[fd]),0);assert.equal(h.exec('fread',[out,1,32,fd]),0);
  h.exec('fclose',[fd]);
  const binary=h.exec('fopen',[h.string('ctrlz.txt'),h.string('rb')]);
  assert.equal(h.exec('fread',[out,1,32,binary]),6);assert.deepEqual([...h.copyOut(out,6)],[65,13,10,26,66,10]);
});

test('CRT text translation handles CRLF across the bounded raw read buffer',()=>{
  const h=host(),raw=new Uint8Array(32770).fill(65),out=h.alloc(raw.length),ranges=[];
  raw[16383]=13;raw[16384]=10;raw[32767]=13;raw[32768]=66;raw[32769]=13;
  h.listFiles=()=>['boundary.txt'];h.fileSize=()=>raw.length;
  h.readFile=(path,offset,length)=>{ranges.push(length);return raw.slice(offset,offset+length);};
  const fd=h.exec('fopen',[h.string('boundary.txt'),h.string('rt')]);
  assert.equal(h.exec('fread',[out,1,raw.length,fd]),raw.length-1);
  assert.equal(h.u8(out+16383),10);assert.equal(h.u8(out+16384),65);
  assert.deepEqual([...h.copyOut(out+32766,3)],[13,66,13]);
  assert.ok(Math.max(...ranges)<=16384);assert.equal(h.exec('ftell',[fd]),raw.length);
  assert.equal(h.exec('feof',[fd]),1);
});

test('CRT text writes expand each LF and count untranslated input bytes',()=>{
  const h=host(),path=h.string('out.txt'),data=h.string('A\nB\r\n\x1a'),fd=h.exec('fopen',[path,h.string('w+t')]);
  assert.equal(h.exec('fwrite',[data,2,3,fd]),3);assert.equal(h.exec('ftell',[fd]),8);
  assert.deepEqual([...h.virtualFiles.get('out.txt')],[65,13,10,66,13,13,10,26]);
  assert.equal(h.exec('fseek',[fd,0,0]),0);
  const out=h.alloc(16);assert.equal(h.exec('fread',[out,1,16,fd]),5);
  assert.deepEqual([...h.copyOut(out,5)],[65,10,66,13,10]);h.exec('fclose',[fd]);
  const append=h.exec('fopen',[path,h.string('a+t')]);
  assert.equal(h.exec('ftell',[append]),0);assert.deepEqual([...h.virtualFiles.get('out.txt')],[65,13,10,66,13,13,10]);
  assert.equal(h.exec('fread',[out,1,1,append]),1);assert.equal(h.u8(out),65);
  assert.equal(h.exec('fputc',[10,append]),10);assert.equal(h.exec('ftell',[append]),9);
  assert.deepEqual([...h.virtualFiles.get('out.txt')],[65,13,10,66,13,13,10,13,10]);
});

test('CRT _fmode default, explicit modes and error flags remain distinct',()=>{
  const h=host(),setting=h.alloc(4),path=h.string('modes.txt'),data=h.string('\n');
  h.dataSymbols.set('msvcr80.dll!_fmode',setting);h.w32(setting,0x8000);
  let fd=h.exec('fopen',[path,h.string('w')]);assert.equal(h.exec('fwrite',[data,1,1,fd]),1);h.exec('fclose',[fd]);
  assert.deepEqual([...h.virtualFiles.get('modes.txt')],[10]);
  fd=h.exec('fopen',[path,h.string('wt')]);h.exec('fputs',[data,fd]);h.exec('fclose',[fd]);
  assert.deepEqual([...h.virtualFiles.get('modes.txt')],[13,10]);
  fd=h.exec('fopen',[path,h.string('rt')]);assert.equal(h.exec('fputs',[data,fd]),-1);
  assert.equal(h.exec('ferror',[fd]),1);assert.equal(h.exec('feof',[fd]),0);
  const out=h.alloc(8);assert.equal(h.exec('fread',[out,1,8,fd]),1,'prior error flag must not disable valid reads');
  assert.equal(h.exec('ferror',[fd]),1);assert.equal(h.exec('feof',[fd]),1);
  h.exec('clearerr',[fd]);assert.equal(h.exec('ferror',[fd]),0);assert.equal(h.exec('feof',[fd]),0);
  assert.equal(h.exec('fopen',[path,h.string('rbt')]),0);
});
