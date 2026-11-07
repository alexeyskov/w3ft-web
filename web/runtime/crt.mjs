import {GuestExit, GuestFault} from './host.mjs';

export function splitCommandLine(command) {
  const result = []; let argument = '', quoted = false, present = false;
  for (let i = 0; i < command.length; i++) {
    let slashes = 0;
    while (command[i] === '\\') { slashes++; i++; }
    if (command[i] === '"') {
      argument += '\\'.repeat(Math.floor(slashes / 2)); present = true;
      if (slashes % 2) argument += '"'; else quoted = !quoted;
    } else {
      argument += '\\'.repeat(slashes);
      if (i >= command.length) { present ||= slashes > 0; break; }
      if (/\s/.test(command[i]) && !quoted) { if (present || argument) result.push(argument); argument = ''; present = false; }
      else { argument += command[i]; present = true; }
    }
  }
  if (present || argument) result.push(argument);
  return result;
}

export function installCRT(h) {
  const add = (name, n, fn) => h.add('MSVCR80.dll', name, n, fn, 'cdecl');
  add('_beginthreadex',6,args=>h.handlers.get('kernel32.dll!CreateThread').fn(args));
  add('_endthreadex',1,args=>h.handlers.get('kernel32.dll!ExitThread').fn(args));
  add('_beginthread',3,([entry,stack,arg])=>h.handlers.get('kernel32.dll!CreateThread').fn([0,stack,entry,arg,0,0]));
  add('_endthread',0,()=>h.handlers.get('kernel32.dll!ExitThread').fn([0]));
  const bytes = p => { let n = 0; while (h.u8(p+n)) { if (++n > 16*1024*1024) throw new GuestFault('Unterminated CRT string'); } return h.copyOut(p,n); };
  // Narrow CRT strings are byte sequences. Decoding UTF-8 game text as the
  // Windows ANSI code page and re-encoding it corrupts formatted quest text.
  const byteString=p=>{const data=bytes(p);let value='';for(let i=0;i<data.length;i+=16384)value+=String.fromCharCode(...data.subarray(i,i+16384));return value;};
  const encodeBytes=value=>Uint8Array.from(value,c=>c.charCodeAt(0));
  const writeBytes=(out,value)=>{h.copyIn(out,encodeBytes(value));h.w8(out+value.length,0);return value.length;};
  const cmp = (a,b,n,fold=false) => { for(let i=0;i<n;i++){let x=h.u8(a+i),y=h.u8(b+i);if(fold){if(x>=65&&x<=90)x+=32;if(y>=65&&y<=90)y+=32;}if(x!==y)return x-y;if(!x)return 0;}return 0; };
  add('malloc',1,([n])=>h.alloc(n)); add('_malloc_crt',1,([n])=>h.alloc(n));
  add('calloc',2,([n,size])=>{if(n*size>0xffffffff) return 0;return h.alloc(n*size);});
  add('free',1,([p])=>h.free(p));
  add('realloc',2,([p,n])=>{if(!p)return h.alloc(n);if(!n){h.free(p);return 0;}const old=h.allocations.get(p);if(old===undefined)throw new GuestFault('Invalid realloc');const next=h.alloc(n);h.copyIn(next,h.copyOut(p,Math.min(old,n)));h.free(p);return next;});
  add('memcpy',3,([d,s,n])=>{h.copyIn(d,h.copyOut(s,n));return d;});
  add('memmove',3,([d,s,n])=>{h.copyIn(d,h.copyOut(s,n));return d;});
  add('memset',3,([d,c,n])=>{h.bytes.fill(c&255,h.check(d,n),h.base+d+n);return d;});
  add('memcmp',3,([a,b,n])=>{for(let i=0;i<n;i++){const d=h.u8(a+i)-h.u8(b+i);if(d)return d;}return 0;});
  add('strlen',1,([p])=>bytes(p).length);
  for(const name of ['strcmp','_stricmp'])add(name,2,([a,b])=>cmp(a,b,16*1024*1024,name==='_stricmp'));
  for(const name of ['strncmp','_strnicmp'])add(name,3,([a,b,n])=>cmp(a,b,n,name==='_strnicmp'));
  add('strcpy',2,([d,s])=>{const b=bytes(s);h.copyIn(d,b);h.w8(d+b.length,0);return d;});
  add('strncpy',3,([d,s,n])=>{const b=bytes(s);h.zero(d,n);h.copyIn(d,b.subarray(0,n));return d;});
  add('strcpy_s',3,([d,n,s])=>{const b=bytes(s);if(!n||b.length>=n){if(n)h.w8(d,0);return 34;}h.copyIn(d,b);h.w8(d+b.length,0);return 0;});
  add('strcat',2,([d,s])=>{const n=bytes(d).length,b=bytes(s);h.copyIn(d+n,b);h.w8(d+n+b.length,0);return d;});
  add('strchr',2,([p,c])=>{const n=bytes(p).length;for(let i=0;i<=n;i++)if(h.u8(p+i)===(c&255))return p+i;return 0;});
  add('strrchr',2,([p,c])=>{for(let i=bytes(p).length;i>=0;i--)if(h.u8(p+i)===(c&255))return p+i;return 0;});
  for(const name of ['strstr','_mbsstr'])add(name,2,([p,s])=>{const hay=bytes(p),needle=bytes(s);outer:for(let i=0;i<=hay.length-needle.length;i++){for(let j=0;j<needle.length;j++)if(hay[i+j]!==needle[j])continue outer;return p+i;}return 0;});
  add('strpbrk',2,([p,s])=>{const chars=new Set(bytes(s));const b=bytes(p);for(let i=0;i<b.length;i++)if(chars.has(b[i]))return p+i;return 0;});
  for(const [name,upper] of [['_strupr',true],['_strlwr',false]])add(name,1,([p])=>{const b=bytes(p);for(let i=0;i<b.length;i++){const c=b[i];h.w8(p+i,upper&&c>=97&&c<=122?c-32:!upper&&c>=65&&c<=90?c+32:c);}return p;});
  for(const [name,predicate] of Object.entries({isdigit:c=>c>=48&&c<=57,isupper:c=>c>=65&&c<=90,isalnum:c=>c>=48&&c<=57||c>=65&&c<=90||c>=97&&c<=122,isprint:c=>c>=32&&c<=126,iswspace:c=>' \t\r\n\v\f'.includes(String.fromCharCode(c)),_ismbcspace:c=>' \t\r\n\v\f'.includes(String.fromCharCode(c)),_ismbblead:c=>false}))add(name,1,([c])=>predicate(c)?1:0);
  add('toupper',1,([c])=>c>=97&&c<=122?c-32:c);
  for(const name of ['atoi','atol'])add(name,1,([p])=>parseInt(h.cstr(p),10)||0);
  for(const [name,unsigned] of [['strtol',false],['strtoul',true]])add(name,3,([p,end,base])=>{
    const s=h.cstr(p), match=/^\s*([+-]?)(.*)/.exec(s);let rest=match[2],prefix=s.length-rest.length;
    if(!base){base=/^0x/i.test(rest)?16:rest[0]==='0'?8:10;}if(base<2||base>36)throw new GuestFault('Invalid integer radix');
    if(base===16&&/^0x/i.test(rest)){rest=rest.slice(2);prefix+=2;}let value=0,n=0;
    for(const c of rest.toLowerCase()){const digit='0123456789abcdefghijklmnopqrstuvwxyz'.indexOf(c);if(digit<0||digit>=base)break;value=value*base+digit;n++;}
    if(end)h.w32(end,n?p+prefix+n:p);value*=match[1]==='-'?-1:1;return unsigned?value>>>0:value|0;
  });
  add('_itoa',3,([value,p,radix])=>{if(radix<2||radix>36)throw new GuestFault('Invalid radix');h.writeString(p,(radix===10?value|0:value).toString(radix),35);return p;});
  const errno=code=>{const context=h.threadContext;if(!context.crtErrno)context.crtErrno=h.alloc(4);if(code!==undefined)h.w32(context.crtErrno,code);return context.crtErrno;};
  add('_errno',0,()=>errno());
  add('_fullpath',3,([out,path,capacity])=>{
    const scratch=h.alloc(32768);let cwd;
    try{h.handlers.get('kernel32.dll!GetCurrentDirectoryA').fn([32768,scratch]);cwd=h.cstr(scratch);}
    finally{h.free(scratch);}
    let value=path?h.cstr(path):'';value=value.replaceAll('/','\\');
    if(!value)value=cwd;
    if(value.startsWith('\\\\'))throw new GuestFault('UNC fullpath resolution is unsupported');
    if(/^[A-Za-z]:/.test(value)){
      if(value[2]!=='\\'){
        if(value.slice(0,2).toLowerCase()!==cwd.slice(0,2).toLowerCase()){errno(22);return 0;}
        value=cwd+'\\'+value.slice(2);
      }
    }else value=value[0]==='\\'?cwd.slice(0,2)+value:cwd+'\\'+value;
    const parts=[];
    for(const part of value.slice(3).split('\\')){
      if(!part||part==='.')continue;if(part==='..'){parts.pop();continue;}
      if(/[\x00-\x1f:]/.test(part)){errno(22);return 0;}parts.push(part);
    }
    const full=value.slice(0,2).toUpperCase()+'\\'+parts.join('\\'),needed=new TextEncoder().encode(full).length+1;
    if(!out){out=h.alloc(needed);capacity=needed;}
    if(capacity<needed){errno(34);return 0;}h.writeString(out,full,capacity);return out;
  });
  const stOffsets=()=>({st:h.exports.wc3_cpu_st_offset(),top:h.exports.wc3_cpu_top_offset()});
  const stRead=index=>{const o=stOffsets(),top=h.view.getInt32(h.currentCPU+o.top,true);return h.view.getFloat64(h.currentCPU+o.st+((top+index)&7)*8,true);};
  const stReturn=(value,pop=0)=>{const o=stOffsets();let top=h.view.getInt32(h.currentCPU+o.top,true);top=(top+pop)&7;h.view.setInt32(h.currentCPU+o.top,top,true);h.view.setFloat64(h.currentCPU+o.st+top*8,value,true);};
  const stPush=value=>{const o=stOffsets(),top=(h.view.getInt32(h.currentCPU+o.top,true)-1)&7;h.view.setInt32(h.currentCPU+o.top,top,true);h.view.setFloat64(h.currentCPU+o.st+top*8,value,true);};
  for(const [name,fn] of Object.entries({_CIsqrt:Math.sqrt,_CIlog10:Math.log10,_CIexp:Math.exp,_CIatan:Math.atan,_CItan:Math.tan,_CIacos:Math.acos,_CIasin:Math.asin,_CIsin:Math.sin,_CIcos:Math.cos}))add(name,0,()=>stReturn(fn(stRead(0))));
  add('_CIpow',0,()=>stReturn(Math.pow(stRead(1),stRead(0)),1));
  add('_CIatan2',0,()=>stReturn(Math.atan2(stRead(1),stRead(0)),1));
  add('_CIfmod',0,()=>stReturn(stRead(1)%stRead(0),1));
  for(const [name,fn] of [['floor',Math.floor],['ceil',Math.ceil],['sqrt',Math.sqrt]])add(name,2,(_args,esp)=>stPush(fn(h.view.getFloat64(h.check(esp+4,8),true))));
  add('atof',1,([p])=>stPush(parseFloat(h.cstr(p))||0));
  h.crtExits=[];h.crtLocks=new Map();
  add('_lock',1,([id])=>{let pointer=h.crtLocks.get(id);if(!pointer){pointer=h.alloc(24);h.threadServices.initializeCritical(pointer);h.crtLocks.set(id,pointer);}return h.threadServices.enterCritical(pointer);});
  add('_unlock',1,([id])=>{const pointer=h.crtLocks.get(id);if(!pointer)throw new GuestFault('CRT unlock without lock');return h.threadServices.leaveCritical(pointer);});
  for(const name of ['_encode_pointer','_decode_pointer'])add(name,1,([p])=>p^0x53a18cd7);
  add('_encoded_null',0,()=>0x53a18cd7);
  for(const name of ['_onexit','atexit'])add(name,1,([p])=>{h.crtExits.push(p);return name==='atexit'?0:p;});
  add('__dllonexit',3,([fn,begin,end])=>{let b=h.u32(begin),e=h.u32(end);const count=b?(e-b)/4:0;if(count<0||count>65536)throw new GuestFault('Invalid dllonexit table');const next=h.alloc((count+1)*4);if(count)h.copyIn(next,h.copyOut(b,count*4));h.w32(next+count*4,fn);h.w32(begin,next);h.w32(end,next+(count+1)*4);return fn;});
  for(const name of ['_initterm','_initterm_e'])add(name,2,([begin,end])=>{if(end<begin||end-begin>4*1024*1024)throw new GuestFault('Invalid CRT initializer table');for(let p=begin;p<end;p+=4){const f=h.u32(p);if(f){const code=h.call(f);if(name==='_initterm_e'&&code)return code;}}return 0;});
  add('__getmainargs',5,([argc,argv,env])=>{const args=splitCommandLine(h.commandLine),array=h.alloc((args.length+1)*4);args.forEach((s,i)=>h.w32(array+i*4,h.string(s)));h.w32(argc,args.length);h.w32(argv,array);h.w32(env,h.alloc(4));return 0;});
  add('__set_app_type',1,([type])=>{h.appType=type;});
  add('__setusermatherr',1,([callback])=>{h.mathErrorCallback=callback;});
  add('_configthreadlocale',1,([mode])=>{const previous=h.localeMode||1;if(mode)h.localeMode=mode;return previous;});
  for(const [name,field] of [['__p__fmode','_fmode'],['__p__commode','_commode']])add(name,0,()=>h.dataSymbols.get('msvcr80.dll!'+field));
  add('_crt_debugger_hook',1,()=>{if(h.debuggerAttached)throw new GuestFault('Debugger integration unavailable');});
  add('_cexit',0,()=>{for(const f of h.crtExits.splice(0).reverse())h.call(f);});
  for(const name of ['exit','_exit'])add(name,1,([code])=>{if(name==='exit')for(const f of h.crtExits.splice(0).reverse())h.call(f);throw new GuestExit(code|0);});
  for(const name of ['_purecall','?terminate@@YAXXZ','_amsg_exit','_invoke_watson'])add(name,0,()=>{throw new GuestFault(`CRT fatal error: ${name}`);});
  const exceptionMap=[[1,0x10],[2,0x80000],[4,8],[8,4],[16,2],[32,1]];
  const exceptions=word=>exceptionMap.reduce((out,[x87,crt])=>out|(word&x87?crt:0),0);
  add('_clearfp',0,()=>{const p=h.currentCPU+h.exports.wc3_cpu_top_offset()+6,prior=h.view.getUint16(p,true);h.view.setUint16(p,prior&0x7f00,true);return exceptions(prior);});
  function control(value,mask){
    const p=h.currentCPU+h.exports.wc3_cpu_top_offset()+4;
    let cw=h.view.getUint16(p,true),current=exceptions(cw);
    current|=((cw>>10)&3)<<8;
    current|=(cw&0x300)===0x200?0x10000:(cw&0x300)===0?0x20000:0;
    current|=cw&0x1000?0x40000:0;
    // CRT masks use a different layout from the x87 word. Reserved mask
    // bits have no hardware counterpart; broad masks such as ~0 are valid.
    mask&=0xf031f;
    const next=(current&~mask)|(value&mask);
    for(const[x87,crt]of exceptionMap)cw=next&crt?cw|x87:cw&~x87;
    cw=(cw&~0x1f00)|((next>>8&3)<<10)|((next&0x30000)===0x10000?0x200:(next&0x30000)===0x20000?0:0x300)|(next&0x40000?0x1000:0);
    h.view.setUint16(p,cw,true);return next;
  }
  add('_control87',2,([v,m])=>control(v,m));
  add('_controlfp',2,([v,m])=>control(v,m&~0x80000));
  add('_controlfp_s',3,([out,v,m])=>{const current=control(v,m&~0x80000);if(out)h.w32(out,current);return 0;});
  add('srand',1,([s])=>{h.threadContext.randomSeed=s;});add('rand',0,()=>{const context=h.threadContext;context.randomSeed=(Math.imul(context.randomSeed??1,214013)+2531011)>>>0;return(context.randomSeed>>>16)&0x7fff;});
  add('_time64',1,([p])=>{const seconds=BigInt(Math.floor(Date.now()/1000));if(p)h.view.setBigInt64(h.check(p,8),seconds,true);h.view.setUint32(h.currentCPU+8,Number(seconds>>32n),true);return Number(seconds&0xffffffffn);});
  add('qsort',4,([base,count,size,compare])=>{if(count*size>32*1024*1024||!size)throw new GuestFault('qsort bounds');const indices=Array.from({length:count},(_,i)=>i);indices.sort((a,b)=>h.call(compare,[base+a*size,base+b*size])|0);const sorted=new Uint8Array(count*size);indices.forEach((from,to)=>sorted.set(h.copyOut(base+from*size,size),to*size));h.copyIn(base,sorted);});

  function format(pattern,va){let cursor=va;return pattern.replace(/%([-+ #0]*)(\d+|\*)?(?:\.(\d*|\*))?(I64|I32|ll|hh|l|h)?([%scdiuxXopfgeE])/g,(whole,flags,width,precision,length,type)=>{
    if(type==='%')return '%';
    if(width==='*'){width=h.i32(cursor);cursor+=4;}
    if(precision==='*'){precision=h.i32(cursor);cursor+=4;}
    let n=Number(width)||0;
    if(n<0){flags+='-';n=-n;}
    precision=precision===undefined||Number(precision)<0?undefined:Number(precision);
    if(n>65536||precision>65536)throw new GuestFault('printf field too large');
    let s,prefix='',zeroPad=flags.includes('0');
    if('fgeE'.includes(type)){
      const v=h.view.getFloat64(h.check(cursor,8),true);cursor+=8;
      const digits=precision===undefined?6:precision;
      if(digits>100)throw new GuestFault('printf floating precision is unsupported');
      const magnitude=Math.abs(v);
      s=type==='f'?magnitude.toFixed(digits):type==='g'?magnitude.toPrecision(digits||1):magnitude.toExponential(digits);
      if(type==='E')s=s.toUpperCase();
      prefix=v<0||Object.is(v,-0)?'-':flags.includes('+')?'+':flags.includes(' ')?' ':'';
    }else if(type==='s'||type==='c'){
      const value=h.u32(cursor);cursor+=4;
      s=type==='s'?(value?byteString(value):'(null)'):String.fromCharCode(value&255);
      if(type==='s'&&precision!==undefined)s=s.slice(0,precision);
      zeroPad=false;
    }else{
      // Win32 varargs have four-byte alignment, including __int64. Keep all
      // 64 bits until conversion: Number would lose profile/save identifiers.
      const bits=type==='p'?32:length==='I64'||length==='ll'?64:length==='hh'?8:length==='h'?16:32;
      let value=bits===64?h.view.getBigUint64(h.check(cursor,8),true):BigInt(h.u32(cursor));
      cursor+=bits===64?8:4;
      const signed=type==='d'||type==='i';
      value=signed?BigInt.asIntN(bits,value):BigInt.asUintN(bits,value);
      if(signed)prefix=value<0n?'-':flags.includes('+')?'+':flags.includes(' ')?' ':'';
      const magnitude=value<0n?-value:value;
      s=magnitude.toString(type==='o'?8:'xXp'.includes(type)?16:10);
      if(precision===0&&magnitude===0n&&type!=='p')s='';
      s=s.padStart(type==='p'?8:precision||0,'0');
      if(type==='X'||type==='p')s=s.toUpperCase();
      if(flags.includes('#')){
        if(type==='o'&&s[0]!=='0')prefix='0';
        else if((type==='x'||type==='X')&&magnitude!==0n)prefix=type==='X'?'0X':'0x';
      }
      if(precision!==undefined)zeroPad=false;
    }
    if(flags.includes('-'))return (prefix+s).padEnd(n,' ');
    if(zeroPad)return prefix+s.padStart(Math.max(0,n-prefix.length),'0');
    return (prefix+s).padStart(n,' ');
  });}
  add('sprintf',2,([out,pattern],esp)=>writeBytes(out,format(byteString(pattern),esp+12)));
  add('vsprintf',3,([out,pattern,va])=>writeBytes(out,format(byteString(pattern),va)));
  function scan(input,pattern,va){
    let cursor=0,assigned=0,converted=0;
    const space=ch=>/[ \t\n\r\v\f]/.test(ch);
    const whitespace=()=>{while(cursor<input.length&&space(input[cursor]))cursor++;};
    for(let i=0;i<pattern.length;i++){
      if(space(pattern[i])){whitespace();continue;}
      if(pattern[i]!=='%'||pattern[i+1]==='%'){
        const literal=pattern[i]==='%'?pattern[++i]:pattern[i];
        if(input[cursor]!==literal)return !converted&&cursor===input.length?-1:assigned;
        cursor++;continue;
      }
      i++;const suppress=pattern[i]==='*';if(suppress)i++;
      let width='';while(/\d/.test(pattern[i]||'x'))width+=pattern[i++];
      const limit=width?Number(width):65536;
      if(!limit||limit>65536)throw new GuestFault('Invalid scanf field width');
      let length='';
      if(pattern.slice(i,i+3)==='I64'){length='I64';i+=3;}
      else if(/[hlL]/.test(pattern[i]||'?')){length=pattern[i++];if(pattern[i]===length&&length!=='L')length+=pattern[i++];}
      const type=pattern[i];let characterClass;
      if(type==='['){
        const inverse=pattern[++i]==='^';if(inverse)i++;
        let characters='';if(pattern[i]===']')characters+=pattern[i++];
        while(i<pattern.length&&pattern[i]!==']')characters+=pattern[i++];
        if(pattern[i]!==']')throw new GuestFault('Unterminated scanf character class');
        characterClass=ch=>{let found=false;for(let j=0;j<characters.length;j++){if(characters[j+1]==='-'&&j+2<characters.length){found||=ch>=characters[j]&&ch<=characters[j+2];j+=2;}else found||=ch===characters[j];}return inverse?!found:found;};
      }
      if(!['c','[','n'].includes(type))whitespace();
      let text='',value;
      if(type==='n')value=cursor;
      else if(type==='s'||type==='c'||type==='['){
        const count=type==='c'&&!width?1:limit;
        while(text.length<count&&cursor+text.length<input.length){const ch=input[cursor+text.length];if(type==='s'&&space(ch)||type==='['&&!characterClass(ch))break;text+=ch;}
        if(!text.length)return !converted&&cursor===input.length?-1:assigned;
      }else{
        const rest=input.slice(cursor,cursor+limit),integerPatterns={d:/^[+-]?\d+/,u:/^[+-]?\d+/,o:/^[+-]?[0-7]+/,x:/^[+-]?(?:0[xX])?[\da-fA-F]+/,X:/^[+-]?(?:0[xX])?[\da-fA-F]+/,i:/^[+-]?(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)/,p:/^(?:0[xX])?[\da-fA-F]+/};
        if(integerPatterns[type]){
          text=rest.match(integerPatterns[type])?.[0]||'';
          if(text){const sign=text[0]==='-'?-1n:1n,digits=text.replace(/^[+-]/,''),base=type==='o'?8:['x','X','p'].includes(type)?16:type==='i'?(digits.match(/^0x/i)?16:digits[0]==='0'?8:10):10;
            value=sign*BigInt(base===16?'0x'+digits.replace(/^0x/i,''):base===8?'0o'+digits:digits);}
        }else if('fFeEgG'.includes(type)){
          text=rest.match(/^[+-]?(?:infinity|inf|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/i)?.[0]||'';
          value=/^[+-]?inf/i.test(text)?(text[0]==='-'?-Infinity:Infinity):Number(text);
        }else throw new GuestFault('Unsupported scanf conversion',{type,length});
        if(!text)return !converted&&cursor===input.length?-1:assigned;
      }
      if(!suppress){
        const out=h.u32(va);va+=4;
        if(type==='s'||type==='c'||type==='['){h.copyIn(out,Uint8Array.from(text,ch=>ch.charCodeAt(0)&255));if(type!=='c')h.w8(out+text.length,0);}
        else if('fFeEgG'.includes(type)){if(length==='L')throw new GuestFault('scanf long double is unsupported');if(length==='l')h.view.setFloat64(h.check(out,8),value,true);else h.view.setFloat32(h.check(out,4),value,true);}
        else if(length==='ll'||length==='I64')h.view.setBigUint64(h.check(out,8),BigInt.asUintN(64,BigInt(value)),true);
        else{const number=Number(BigInt.asUintN(32,BigInt(value)));if(length==='h')h.w16(out,number&65535);else if(length==='hh')h.w8(out,number&255);else h.w32(out,number);}
        if(type!=='n')assigned++;
      }
      cursor+=text.length;if(type!=='n')converted++;
    }
    return assigned;
  }
  add('sscanf',2,([input,pattern],esp)=>scan(byteString(input),byteString(pattern),esp+12));
  add('vsscanf',3,([input,pattern,va])=>scan(byteString(input),byteString(pattern),va));
  for(const name of ['wsprintfA','wvsprintfA'])h.add('user32.dll',name,name==='wsprintfA'?2:3,(args,esp)=>{
    const[out,pattern]=args,text=byteString(pattern);
    if(/%[-+ #0\d.*lhI64]*[fgeE]/.test(text))throw new GuestFault('wsprintf does not support floating formats');
    const s=format(text,name==='wsprintfA'?esp+12:args[2]);
    if(s.length>=1024)throw new GuestFault('wsprintf exceeds its 1024-byte limit');
    return writeBytes(out,s);
  },name==='wsprintfA'?'cdecl':'stdcall');
  for(const name of ['_snprintf','_vsnprintf'])add(name,name==='_snprintf'?3:4,(a,esp)=>{const[out,n,pattern]=a,s=format(byteString(pattern),name==='_snprintf'?esp+16:a[3]),encoded=encodeBytes(s);if(n){h.copyIn(out,encoded.subarray(0,n));if(encoded.length<n)h.w8(out+encoded.length,0);}return encoded.length>=n?-1:encoded.length;});
  add('printf',1,([pattern],esp)=>{const s=format(byteString(pattern),esp+8);h.log(new TextDecoder().decode(encodeBytes(s)));return s.length;});
  add('__iob_func',0,()=>{if(!h.crtIob)h.crtIob=h.alloc(32*3);return h.crtIob;});
  const kernel=(name,args)=>h.handlers.get('kernel32.dll!'+name).fn(args);
  let ioCount=0,ioBuffer=0;
  const countPointer=()=>ioCount||(ioCount=h.alloc(4));
  const textBuffer=()=>ioBuffer||(ioBuffer=h.alloc(16384));
  const ioFailure=(f,code=5)=>{f.error=true;errno(code);return 0;};
  const seekHandle=(handle,offset,origin)=>{
    const position=kernel('SetFilePointer',[handle,offset>>>0,0,origin]);
    return position===0xffffffff&&h.lastError?-1:position;
  };
  add('fopen',2,([name,mode])=>{
    const flags=h.cstr(mode);
    if(!/^[rwa](?:[bt]\+?|\+[bt]?)?$/.test(flags)){errno(22);return 0;}
    const fmode=h.dataSymbols.get('msvcr80.dll!_fmode');
    const text=flags.includes('t')||(!flags.includes('b')&&(!fmode||!(h.u32(fmode)&0x8000)));
    const reading=flags[0]==='r'||flags.includes('+'),writing=flags[0]!=='r'||flags.includes('+');
    const handle=kernel('CreateFileA',[name,((reading?0x80000000:0)|(writing?0x40000000:0))>>>0,3,0,flags[0]==='r'?3:flags[0]==='w'?2:4,0,0]);
    if(handle===0xffffffff){errno(h.lastError===2?2:13);return 0;}
    // Microsoft fopen(a+t) removes a terminal Ctrl-Z if the file is writable.
    // Inspect only its final byte; opening a stream must not fetch a whole MPQ.
    if(text&&flags[0]==='a'&&reading){
      const end=seekHandle(handle,0,2);
      if(end>0&&seekHandle(handle,-1,2)!==-1){
        const buffer=textBuffer(),p=countPointer();
        if(kernel('ReadFile',[handle,buffer,1,p,0])&&h.u32(p)===1&&h.u8(buffer)===26&&seekHandle(handle,-1,2)!==-1)
          kernel('SetEndOfFile',[handle]);
      }
      seekHandle(handle,0,0);
    }
    // Append changes the position immediately before each write, not on open.
    return h.handle({kind:'stdio',handle,reading,writing,text,append:flags[0]==='a',error:false,eof:false});
  });
  const stream=fd=>{const file=h.getHandle(fd,'stdio');if(!file)throw new GuestFault('Invalid FILE pointer',{fd});return file;};
  add('fclose',1,([fd])=>{const f=stream(fd),ok=kernel('CloseHandle',[f.handle]);h.handles.delete(fd);return ok?0:-1;});
  add('fread',4,([out,size,count,fd])=>{
    const f=stream(fd);if(!size||!count)return 0;
    if(size*count>128*1024*1024)throw new GuestFault('FILE read size limit');
    if(!f.reading)return ioFailure(f,9);if(f.eof)return 0;
    const total=size*count,p=countPointer();h.check(out,total);
    if(!f.text){
      if(!kernel('ReadFile',[f.handle,out,total,p,0]))return ioFailure(f);
      const n=h.u32(p);f.eof=n<total;return Math.floor(n/size);
    }
    const buffer=textBuffer();let n=0,readError=false;
    // Consume only bytes represented by returned characters. Physical offsets
    // are consequently valid ftell/fseek cookies even across CRLF boundaries.
    while(n<total&&!f.eof){
      const requested=Math.min(16384,total-n);
      if(!kernel('ReadFile',[f.handle,buffer,requested,p,0])){ioFailure(f);break;}
      const length=h.u32(p);if(!length){f.eof=true;break;}
      const raw=h.copyOut(buffer,length);
      for(let i=0;i<length;i++){
        let value=raw[i];
        if(value===26){
          // Leave the marker at the next raw position, so a saved cookie also
          // restores text EOF instead of silently skipping it after fseek.
          if(seekHandle(f.handle,i-length,1)===-1)ioFailure(f);
          f.eof=true;break;
        }
        if(value===13){
          if(i+1<length){if(raw[i+1]===10){value=10;i++;}}
          else{
            if(!kernel('ReadFile',[f.handle,buffer,1,p,0])){ioFailure(f);readError=true;}
            else if(h.u32(p)){
              if(h.u8(buffer)===10)value=10;
              else if(seekHandle(f.handle,-1,1)===-1){ioFailure(f);readError=true;}
            }
          }
        }
        h.w8(out+n++,value);
      }
      if(readError)break;
    }
    return Math.floor(n/size);
  });
  const write=(fd,data)=>{
    if(fd===1||fd===2||fd===h.crtIob+32||fd===h.crtIob+64){h.log(new TextDecoder().decode(data));return data.length;}
    const f=stream(fd);if(!f.writing)return ioFailure(f,9);if(!data.length)return 0;
    if(f.append&&seekHandle(f.handle,0,2)===-1)return ioFailure(f);
    let encoded=data;
    if(f.text){
      let newlines=0;for(const value of data)if(value===10)newlines++;
      if(data.length+newlines>128*1024*1024)return ioFailure(f,28);
      if(newlines){encoded=new Uint8Array(data.length+newlines);let i=0;for(const value of data){if(value===10)encoded[i++]=13;encoded[i++]=value;}}
    }
    const buffer=h.alloc(encoded.length),p=countPointer();
    try{
      h.copyIn(buffer,encoded);if(!kernel('WriteFile',[f.handle,buffer,encoded.length,p,0]))return ioFailure(f);
      const written=h.u32(p);if(written!==encoded.length)ioFailure(f);
      if(!f.text||written===encoded.length)return f.text?data.length:written;
      let logical=0,raw=0;for(const value of data){raw+=value===10?2:1;if(raw>written)break;logical++;}return logical;
    }
    finally{h.free(buffer);}
  };
  add('fwrite',4,([p,size,count,fd])=>{if(!size||!count)return 0;if(size*count>128*1024*1024)throw new GuestFault('FILE write size limit');return Math.floor(write(fd,h.copyOut(p,size*count))/size);});
  add('fseek',3,([fd,offset,origin])=>{const f=stream(fd);if(seekHandle(f.handle,offset,origin)===-1){errno(22);return -1;}f.eof=false;return 0;});
  add('ftell',1,([fd])=>{const position=seekHandle(stream(fd).handle,0,1);if(position<0||position>0x7fffffff){errno(22);return -1;}return position;});
  add('ferror',1,([fd])=>stream(fd).error?1:0);add('feof',1,([fd])=>stream(fd).eof?1:0);
  add('clearerr',1,([fd])=>{const f=stream(fd);f.error=f.eof=false;});
  add('fflush',1,([fd])=>{if(!fd)return 0;return kernel('FlushFileBuffers',[stream(fd).handle])?0:-1;});
  add('setvbuf',4,([fd])=>{stream(fd);return 0;});
  for(const name of ['fprintf','vfprintf'])add(name,name==='fprintf'?2:3,(a,esp)=>{const data=encodeBytes(format(byteString(a[1]),name==='fprintf'?esp+12:a[2]));const n=write(a[0],data);return n===data.length?n:-1;});
  for(const name of ['fputc','putc'])add(name,2,([c,fd])=>write(fd,new Uint8Array([c&255]))?c&255:-1);
  add('fputs',2,([p,fd])=>{const data=bytes(p),n=write(fd,data);return n===data.length?n:-1;});
}
