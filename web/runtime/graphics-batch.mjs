// Asynchronous OpenGL command stream from a guest thread to the broker.
//
// The guest worker defers every void GL import: state changes, immediate mode,
// draws, texture uploads, glFlush/glFinish and buffer swaps. OpenGL reads
// client arrays, indices and pixels when the call is made, so the worker
// captures those bytes into the record; matrices and vectors are likewise
// copied at call time. Executing a record later therefore reads no guest
// memory. The broker runs records strictly in order, in short time slices, so
// translated game code and WebGL submission overlap.
//
// Ordering: every synchronous import carries the worker's pending records,
// which the broker queues before serving the import. The broker executes the
// queue before any graphics-related import handler runs, including GL calls
// made by guest code that the broker itself executes (window procedures).
// Queries thus observe all earlier commands, while other imports neither wait
// for nor reorder GL work. A buffer swap waits until the broker has executed
// the previous frame (one frame in flight), bounding latency like a driver.
const CHUNK_BYTES=4*1024*1024, CHUNKS=6, THUNKS=65536;
// Control words: frame counters, then per chunk the number of open users:
// the writing worker (while the chunk is current) plus unexecuted segments.
const CONTROL_BYTES=64, FRAMES_SUBMITTED=0, FRAMES_COMPLETED=1, CHUNK_USERS=2;
// Registry table: low 16 bits deferred opcode, or flags for synchronous imports.
const ORDERED=0x80000000, RESETS_CLIENT_STATE=0x40000000, RESETS_UNPACK_STATE=0x20000000;
export const GRAPHICS_FLUSH=0xffffffff;
export const GRAPHICS_STREAM_BYTES=CONTROL_BYTES+CHUNKS*CHUNK_BYTES;
const STATE=1, DRAW_ELEMENTS=2, DRAW_ARRAYS=3, TEX_IMAGE=4, TEX_SUB_IMAGE=5, DELETE_TEXTURES=6, SWAP=7;
const F32=0x1406, U8=0x1401, U16=0x1403, U32=0x1405;
const KINDS=['position','color','texcoord','texcoord1','normal'];
const CLIENT_KIND=new Map([[0x8074,'position'],[0x8075,'normal'],[0x8076,'color'],[0x8078,'texcoord']]);
const CHANNELS=new Map([[0x1908,4],[0x80e1,4],[0x1907,3],[0x80e0,3],[0x1906,1],[0x1909,1],[0x190a,2]]);
const ORDERED_USER32=new Set(['FillRect','ChangeDisplaySettingsA','ChangeDisplaySettingsW','ChangeDisplaySettingsExA','ChangeDisplaySettingsExW']);
const fault=(message,details={})=>Object.assign(new Error(message),{name:'GuestFault',details});
const align4=value=>(value+3)&~3;
const byStart=(a,b)=>a.start-b.start;
const indexType=type=>type===U8?Uint8Array:type===U16?Uint16Array:type===U32?Uint32Array:null;

const operations=[null], byKey=new Map();
function add(name,argc,kind=STATE,{pointer=-1,bytes=()=>0,dll='opengl32.dll',result=0}={}){
  byKey.set(dll+'!'+name,operations.length);operations.push({name,argc,kind,pointer,bytes,dll,result});
}
for(const [name,argc] of Object.entries({
  glClearColor:4,glClear:1,glViewport:4,glScissor:4,glMatrixMode:1,glLoadIdentity:0,
  glPushMatrix:0,glPopMatrix:0,glTranslatef:3,glScalef:3,glRotatef:4,glEnable:1,glDisable:1,
  glBlendFunc:2,glDepthFunc:1,glDepthMask:1,glAlphaFunc:2,glCullFace:1,glFrontFace:1,
  glColorMask:4,glBindTexture:2,glTexParameteri:3,glTexParameterf:3,glTexEnvi:3,
  glColor4f:4,glColor3f:3,glColor4ub:4,glTexCoord2f:2,glFogf:2,glFogi:2,
  glNormal3f:3,glShadeModel:1,glColorMaterial:2,glOrtho:12,glFrustum:12,
  glClearDepth:2,glDepthRange:4,glPolygonOffset:2,glPixelStorei:2,
  glVertexPointer:4,glColorPointer:4,glTexCoordPointer:4,glNormalPointer:3,
  glEnableClientState:1,glDisableClientState:1,glReadBuffer:1,glDrawBuffer:1,
  glLightModelf:2,glLightModeli:2,glLightf:3,glMaterialf:3,glTexGeni:3,glTexGenf:3,
  glBegin:1,glEnd:0,glVertex2f:2,glVertex3f:3,glVertex4f:4,glFlush:0,glFinish:0,
}))add(name,argc);
for(const suffix of ['', 'ARB']){
  add('glActiveTexture'+suffix,1);add('glClientActiveTexture'+suffix,1);
  for(const [type,width] of [['f',4],['d',8],['i',4],['s',2]])for(let n=1;n<=4;n++){
    add(`glMultiTexCoord${n}${type}${suffix}`,1+n*(type==='d'?2:1));
    add(`glMultiTexCoord${n}${type}v${suffix}`,2,STATE,{pointer:1,bytes:()=>n*width});
  }
}
for(const name of ['glLoadMatrixf','glMultMatrixf'])add(name,1,STATE,{pointer:0,bytes:()=>64});
add('glColor4fv',1,STATE,{pointer:0,bytes:()=>16});add('glNormal3fv',1,STATE,{pointer:0,bytes:()=>12});
for(const name of ['glTexParameterfv','glTexParameteriv'])add(name,3,STATE,{pointer:2,bytes:a=>a[1]===0x1004?16:4});
for(const name of ['glFogfv','glFogiv'])add(name,2,STATE,{pointer:1,bytes:a=>a[0]===0x0b66?16:4});
add('glLightModelfv',2,STATE,{pointer:1,bytes:a=>a[0]===0x0b53?16:4});
add('glLightfv',3,STATE,{pointer:2,bytes:a=>a[1]===0x1204?12:a[1]>=0x1200&&a[1]<=0x1203?16:4});
add('glMaterialfv',3,STATE,{pointer:2,bytes:a=>a[1]===0x1601?4:16});
add('glTexGenfv',3,STATE,{pointer:2,bytes:a=>a[1]===0x2500?4:16});
add('glDrawElements',4,DRAW_ELEMENTS);add('glDrawArrays',3,DRAW_ARRAYS);
add('glTexImage2D',9,TEX_IMAGE);add('glTexSubImage2D',9,TEX_SUB_IMAGE);add('glDeleteTextures',2,DELETE_TEXTURES);
add('wglSwapLayerBuffers',2,SWAP,{result:1});add('SwapBuffers',1,SWAP,{dll:'gdi32.dll',result:1});

// Broker side: owns the opcode table and executes submitted chunks in order.
export class GraphicsBatchRegistry {
  constructor(host,{onError=null,sliceMs=4,doorbell=null,vsync=false,maxFps=0}={}){
    this.host=host;this.buffer=new SharedArrayBuffer(THUNKS*4);this.table=new Uint32Array(this.buffer);this.doorbell=doorbell;
    // Swaps are presented on display frames when the worker can observe them
    // (requestAnimationFrame of an OffscreenCanvas). Otherwise frames committed
    // between two refreshes advance the image unevenly (1 or 2 game frames).
    this.vsync=vsync&&typeof globalThis.requestAnimationFrame==='function';
    this.vsyncReady=false;this.vsyncRequested=false;this.vsyncStalled=false;this.vsyncTimer=null;
    // Frame-rate cap (launcher setting, 0 = every display refresh): a swap is
    // presented no sooner than 1000/maxFps ms after the previous one, on the
    // nearest refresh. The game, at most one frame ahead, runs at that rate.
    this.frameInterval=maxFps>0?1000/maxFps:0;this.lastPresent=-Infinity;this.presentAt=null;
    this.refresh=1000/60;this.lastRaf=0;this.capTimer=null;
    this.commands=0;this.batches=0;this.queue=[];this.streams=new WeakMap();this.onError=onError;this.sliceMs=sliceMs;this.scheduled=false;
    host.thunks.forEach((handler,id)=>this.register(id,handler));
  }
  register(id,handler){
    if(id>=THUNKS||!handler)return;
    const dll=handler.dll.toLowerCase(),opcode=byKey.get(dll+'!'+handler.name),op=operations[opcode];
    let code=0;
    if(op&&!handler.unsupported&&handler.argc===op.argc&&handler.convention==='stdcall')code=opcode;
    else if(dll==='opengl32.dll'||dll==='gdi32.dll'||dll==='user32.dll'&&ORDERED_USER32.has(handler.name)){
      code=ORDERED;
      if(dll==='opengl32.dll'&&handler.name==='wglCreateContext')code|=RESETS_CLIENT_STATE;
      if(dll==='opengl32.dll'&&handler.name==='wglDeleteContext')code|=RESETS_UNPACK_STATE;
    }
    // The host drains the queue before any graphics-related handler runs,
    // whoever calls it (a worker import or guest code run by the broker).
    if(code&&!handler.unsupported)handler.graphics=true;
    Atomics.store(this.table,id,code);
  }
  _stream(buffer){
    let stream=this.streams.get(buffer);
    if(!stream){
      if(!(buffer instanceof SharedArrayBuffer)||buffer.byteLength!==GRAPHICS_STREAM_BYTES)throw fault('Invalid graphics command batch');
      stream={buffer,control:new Int32Array(buffer,0,CONTROL_BYTES/4),words:new Uint32Array(buffer),bytes:new Uint8Array(buffer)};
      this.streams.set(buffer,stream);
    }
    return stream;
  }
  // Queues one submitted segment of a worker's stream. Its envelope is checked
  // before anything runs; execution happens in slices or on the next drain.
  submit(owner,{stream:buffer=owner.graphicsStream,chunk,start,end}){
    if(buffer)owner.graphicsStream=buffer;
    const stream=this._stream(buffer);
    if(!Number.isInteger(chunk)||chunk<0||chunk>=CHUNKS||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>CHUNK_BYTES||start%4||end%4)throw fault('Invalid graphics command batch');
    if(Atomics.load(stream.control,CHUNK_USERS+chunk)<1)throw fault('Graphics command batch was not submitted');
    const base=CONTROL_BYTES+chunk*CHUNK_BYTES;
    try{this._validate(stream,base+start,base+end);}
    catch(error){this._release(stream,chunk);throw error;}
    this.queue.push({owner,stream,chunk,offset:base+start,end:base+end});this.batches++;
    this._schedule();
  }
  _validate({words},offset,end){
    const h=this.host;
    for(let at=offset;at<end;){
      const w=at>>2,length=words[w],id=words[w+1],code=id<THUNKS?Atomics.load(this.table,id):0,op=!(code&ORDERED)&&operations[code],handler=h.thunks[id];
      if(length<16||length%4||at+length>end||!op||!handler||handler.name!==op.name||handler.argc!==op.argc)throw fault('Invalid graphics command opcode');
      at+=length;
    }
  }
  _release({control},chunk){Atomics.sub(control,CHUNK_USERS+chunk,1);Atomics.notify(control,CHUNK_USERS+chunk);}
  // Executes every queued record now (graphics-related imports, thread exit).
  drain(){
    if(this.draining||!this.queue.length)return;
    this.draining=true;
    try{this._run(Infinity);}
    catch(error){this._abort();throw error;}
    finally{this.draining=false;}
  }
  cancel(){this._abort();this.cancelled=true;clearTimeout(this.vsyncTimer);clearTimeout(this.capTimer);}
  _abort(){for(const entry of this.queue.splice(0))this._release(entry.stream,entry.chunk);}
  _schedule(){
    if(this.scheduled||!this.queue.length||this.cancelled)return;
    this.scheduled=true;
    // MessageChannel tasks are not clamped like nested timers, and messages
    // from guest workers already queued are served between two slices.
    if(!this.channel){
      this.channel=new MessageChannel();this.channel.port1.onmessage=()=>this._tick();
      this.channel.port1.unref?.();this.channel.port2.unref?.();
    }
    this.channel.port2.postMessage(0);
  }
  _tick(){
    this.scheduled=false;
    if(this.cancelled||this.draining)return;
    let waiting;
    try{waiting=this._run(performance.now()+this.sliceMs)==='vsync';}
    catch(error){const owner=this.failedOwner;this._abort();if(this.onError)this.onError(error,owner);else throw error;return;}
    // A swap waiting for the display is resumed by its animation frame or the
    // stall timer; rescheduling here would spin the event loop until then.
    if(!waiting)this._schedule();
  }
  // True when a swap may be presented now. Without display frames for 40 ms
  // (hidden page) presentation stops waiting for them, so the game keeps
  // running; the frame-rate cap then paces swaps by time.
  _vsyncGate(){
    if(this.vsyncReady)return true;
    if(this.vsync&&!this.vsyncStalled){
      if(!this.vsyncRequested)this._requestFrame();
      if(!this.vsyncTimer)this._armStall();
      return false;
    }
    const wait=this.frameInterval?this.lastPresent+this.frameInterval-performance.now():0;
    if(wait<=0)return true;
    if(!this.capTimer)this.capTimer=setTimeout(()=>{this.capTimer=null;this.vsyncReady=true;if(!this.cancelled&&!this.draining)this._tick();},wait);
    return false;
  }
  _armStall(){this.vsyncTimer=setTimeout(()=>{this.vsyncTimer=null;this.vsyncStalled=true;this._schedule();},40);}
  _requestFrame(){
    this.vsyncRequested=true;
    globalThis.requestAnimationFrame(now=>{
      this.vsyncRequested=false;this.vsyncStalled=false;clearTimeout(this.vsyncTimer);this.vsyncTimer=null;
      if(this.lastRaf&&now>this.lastRaf)this.refresh+=(Math.min(100,now-this.lastRaf)-this.refresh)*.1;
      this.lastRaf=now;
      if(this.cancelled)return;
      // Under a cap, skip refreshes until the one nearest to the due time.
      if(this.frameInterval&&now-this.lastPresent<this.frameInterval-this.refresh/2){this._requestFrame();this._armStall();return;}
      this.vsyncReady=true;this.presentAt=now;
      if(!this.draining)this._tick(); // present inside the display frame
    });
  }
  _nextIsSwap({stream,offset}){return operations[Atomics.load(this.table,stream.words[(offset>>2)+1])]?.kind===SWAP;}
  _run(deadline){
    let executed=0;
    while(this.queue.length){
      const entry=this.queue[0];
      while(entry.offset<entry.end){
        if(deadline!==Infinity&&this._nextIsSwap(entry)){
          if(!this._vsyncGate())return 'vsync';
          this.vsyncReady=false;this.lastPresent=this.presentAt??performance.now();this.presentAt=null;
        }
        this.failedOwner=entry.owner;this._execute(entry);
        // A slice ends early when a guest worker waits for the broker.
        if(deadline!==Infinity&&(this.doorbell&&Atomics.load(this.doorbell,0)>0||(++executed&15)===0&&performance.now()>deadline))return;
      }
      this.queue.shift();this._release(entry.stream,entry.chunk);
    }
  }
  _execute(entry){
    const {stream,owner}=entry,{words}=stream,h=this.host,at=entry.offset,w=at>>2;
    const length=words[w],id=words[w+1],returnAddress=words[w+2],op=operations[Atomics.load(this.table,id)],handler=h.thunks[id],cpu=owner.cpu;
    entry.offset=at+length;
    const name=handler.key??=handler.dll+'!'+handler.name,previous=h.currentCPU,started=h.hostTimings?performance.now():0;
    h.calls.set(name,(h.calls.get(name)||0)+1);this.commands++;
    h.recordCall(name,h.threadContexts.get(cpu)?.id||owner.id||1,returnAddress);
    h.currentCPU=cpu;
    let args;
    try{
      if(op.kind===STATE||op.kind===SWAP){
        // One argument array per count, a new one if a handler nests a record.
        const argc=words[w+3];args=this.executing?new Array(argc):((this.argPool??=[])[argc]??=new Array(argc));
        for(let k=0;k<argc;k++)args[k]=words[w+4+k];
        if(op.pointer>=0){
          const size=words[w+4+argc],data=at+(5+argc)*4;
          // Vectors and matrices, up to 64 bytes: copied without a view per record.
          this.scratch??=h.alloc(64);const target=h.check(this.scratch,size),guest=h._bytes,source=stream.bytes;
          for(let i=0;i<size;i++)guest[target+i]=source[data+i];args[op.pointer]=this.scratch;
        }
        const nested=this.executing;this.executing=true;let result;
        try{result=handler.fn(args,0,cpu);}finally{this.executing=nested;}
        if(result&&typeof result.then==='function'){result.catch(()=>{});throw fault('Asynchronous graphics command cannot be batched');}
        if(op.kind===SWAP){Atomics.add(stream.control,FRAMES_COMPLETED,1);Atomics.notify(stream.control,FRAMES_COMPLETED);}
      }else if(op.kind===DRAW_ELEMENTS||op.kind===DRAW_ARRAYS)this._draw(stream,at,op.kind);
      else if(op.kind===TEX_IMAGE||op.kind===TEX_SUB_IMAGE){
        args=Array.from(words.subarray(w+4,w+13));
        const size=words[w+13],pixels=words[w+14]?stream.bytes.subarray(at+60,at+60+size):null;
        this._graphics()[op.kind===TEX_IMAGE?'texImage2D':'texSubImage2D'](...args.slice(0,8),pixels);
      }else if(op.kind===DELETE_TEXTURES){
        const graphics=this._graphics();
        for(let i=0,count=words[w+3];i<count;i++)graphics.deleteTexture(words[w+4+i]);
      }
    }catch(error){h.lastFaultCPU=cpu;error.details={...error.details,import:name,...(args?{arguments:Array.from(args)}:{}),returnAddress,graphicsBatch:true};throw error;}
    finally{
      h.currentCPU=previous;
      if(h.hostTimings){const elapsed=performance.now()-started,timing=h.hostTimings.get(name)||{count:0,totalMs:0,maxMs:0};timing.count++;timing.totalMs+=elapsed;timing.maxMs=Math.max(timing.maxMs,elapsed);h.hostTimings.set(name,timing);}
    }
  }
  _graphics(){const graphics=this.host.graphics;if(!graphics)throw fault('OpenGL: WebGL renderer unavailable');return graphics;}
  // Captured client arrays keep the guest layout in one contiguous region,
  // which the renderer uploads with a single buffer transfer.
  _draw({buffer,words,bytes},at,kind){
    const w=at>>2,mode=words[w+4],count=words[w+5],type=words[w+6],vertexCount=words[w+7],arrayCount=words[w+8],vertexBytes=words[w+9];
    const vertexStart=at+40+arrayCount*20,region=bytes.subarray(vertexStart,vertexStart+vertexBytes),raw={};
    for(let i=0,p=w+10;i<arrayCount;i++,p+=5)raw[KINDS[words[p]]]={bytes:region,offset:words[p+4],type:words[p+2],size:words[p+1],stride:words[p+3]};
    if(kind===DRAW_ARRAYS){this._graphics().drawArrays(mode,0,count,{raw});return;}
    const Type=indexType(type);
    this._graphics().drawElements(mode,new Type(buffer,vertexStart+align4(vertexBytes),count),{raw},vertexCount);
  }
}

// Guest worker side: writes records, mirrors the client-array and pixel
// unpack state needed to capture draws and uploads, and paces frames.
export class GraphicsCommandQueue {
  constructor(host,registry,{post=globalThis.postMessage?.bind(globalThis),waitTimeout=120000,framesInFlight=1}={}){
    if(!(registry instanceof SharedArrayBuffer)||registry.byteLength!==THUNKS*4)throw fault('Invalid graphics command registry');
    this.host=host;this.table=new Uint32Array(registry);this.post=post;this.waitTimeout=waitTimeout;this.framesInFlight=framesInFlight;
    this.buffer=null;this.announced=false;this.chunk=-1;this.offset=0;this.segment=0;this.next=0;this.frames=0;this.records=0;this.args=new Array(16);
    this.resetClientState();this.resetUnpackState();
  }
  resetClientState(){this.arrays=new Map();this.enabled=new Set();this.clientUnit=0;}
  resetUnpackState(){this.unpack={alignment:4,rowLength:0,skipRows:0,skipPixels:0};}
  _allocate(){
    this.buffer=new SharedArrayBuffer(GRAPHICS_STREAM_BYTES);
    this.control=new Int32Array(this.buffer,0,CONTROL_BYTES/4);this.words=new Uint32Array(this.buffer);this.bytes=new Uint8Array(this.buffer);
  }
  _waitWhile(index,busy,what){
    let value=Atomics.load(this.control,index);
    if(!busy(value))return;
    const deadline=performance.now()+this.waitTimeout;
    while(busy(value)){
      const remaining=deadline-performance.now();
      if(remaining<=0)throw fault(`Graphics stream stalled waiting for ${what}`,{timeout:this.waitTimeout});
      Atomics.wait(this.control,index,value,Math.min(remaining,1000));value=Atomics.load(this.control,index);
    }
  }
  // Chunks are claimed round-robin; segments execute in submission order, so
  // the next chunk is always the one that becomes free first.
  _acquire(){
    if(!this.buffer)this._allocate();
    const index=CHUNK_USERS+this.next;
    this._waitWhile(index,users=>users!==0,'a free command buffer');
    Atomics.store(this.control,index,1);this.chunk=this.next;this.next=(this.next+1)%CHUNKS;this.offset=this.segment=0;
  }
  _reserve(bytes){
    if(bytes>CHUNK_BYTES)return -1;
    if(this.chunk<0)this._acquire();
    else if(this.offset+bytes>CHUNK_BYTES){this._retire();this._acquire();}
    const at=CONTROL_BYTES+this.chunk*CHUNK_BYTES+this.offset;
    this.offset+=bytes;this.records++;this.words[at>>2]=bytes;return at;
  }
  // Records written since the previous submission, handed to the broker.
  _segment(){
    if(this.chunk<0||this.offset===this.segment)return undefined;
    Atomics.add(this.control,CHUNK_USERS+this.chunk,1);
    const descriptor={chunk:this.chunk,start:this.segment,end:this.offset};this.segment=this.offset;
    if(!this.announced){descriptor.stream=this.buffer;this.announced=true;}
    return descriptor;
  }
  // Leaves a full chunk: submits its tail and drops the writer's use.
  _retire(){
    this.submit();
    if(Atomics.sub(this.control,CHUNK_USERS+this.chunk,1)===1)Atomics.notify(this.control,CHUNK_USERS+this.chunk);
    this.chunk=-1;
  }
  // Asynchronous submission: swaps, full chunks, callback returns, exit.
  submit(){const descriptor=this._segment();if(descriptor)this.post({type:'gl-chunk',...descriptor});}
  // Pending records travel with every synchronous import; the broker queues
  // them before the import runs and executes them before graphics handlers.
  syncPoint(){return this._segment();}
  // Mirrors the broker's context resets after a successful WGL call.
  afterSync(id,cpu){
    const code=id<THUNKS?Atomics.load(this.table,id):0;
    if(code&RESETS_CLIENT_STATE)this.resetClientState();
    if(code&RESETS_UNPACK_STATE&&this.host.view.getUint32(cpu,true))this.resetUnpackState();
  }
  enqueue(id,cpu){
    const code=id<THUNKS?Atomics.load(this.table,id):0;
    if(!code||code&ORDERED)return false;
    const op=operations[code];if(!op)return false;
    const h=this.host,esp=h.view.getUint32(cpu+16,true),argc=op.argc,stack=h.check(esp,4+argc*4),view=h._view,args=this.args;
    const returnAddress=view.getUint32(stack,true);
    for(let k=0;k<argc;k++)args[k]=view.getUint32(stack+4+k*4,true);
    let handled;
    switch(op.kind){
      case STATE:case SWAP:handled=this._state(id,op,returnAddress,argc,args);break;
      case DRAW_ELEMENTS:handled=this._drawElements(id,returnAddress,args);break;
      case DRAW_ARRAYS:handled=this._drawArrays(id,returnAddress,args);break;
      case TEX_IMAGE:case TEX_SUB_IMAGE:handled=this._texture(id,returnAddress,args,op.kind===TEX_SUB_IMAGE);break;
      case DELETE_TEXTURES:handled=this._deleteTextures(id,returnAddress,args);break;
      default:handled=false;
    }
    // Not deferrable (too large, invalid or unknown state): the synchronous
    // broker import executes it after the queued work and reports errors.
    if(!handled)return false;
    const cpuView=h.view;cpuView.setUint32(cpu,op.result,true);cpuView.setUint32(cpu+16,esp+4+argc*4,true);cpuView.setUint32(cpu+32,returnAddress,true);
    if(op.kind===SWAP)this._frame();
    return true;
  }
  _header(at,id,returnAddress){const w=at>>2;this.words[w+1]=id;this.words[w+2]=returnAddress;return w;}
  _state(id,op,returnAddress,argc,args){
    const h=this.host;let size=0,source=0;
    if(op.pointer>=0){
      size=op.bytes(args);
      try{source=h.check(args[op.pointer],size);}catch{return false;}
    }
    const at=this._reserve(16+argc*4+(op.pointer>=0?4+align4(size):0));if(at<0)return false;
    const w=this._header(at,id,returnAddress),words=this.words;
    words[w+3]=argc;for(let k=0;k<argc;k++)words[w+4+k]=args[k];
    if(op.pointer>=0){
      words[w+4+argc]=size;
      // Vectors and matrices of at most 64 bytes: a loop, not a view per call.
      const target=at+(5+argc)*4,memory=h._bytes,bytes=this.bytes;for(let i=0;i<size;i++)bytes[target+i]=memory[source+i];
    }
    this._mirror(op.name,args);
    return true;
  }
  _mirror(name,args){
    switch(name){
      case 'glVertexPointer':this._array('position',args[0],args[1],args[2],args[3]);break;
      case 'glColorPointer':this._array('color',args[0],args[1],args[2],args[3]);break;
      case 'glTexCoordPointer':this._array(this.clientUnit?'texcoord1':'texcoord',args[0],args[1],args[2],args[3]);break;
      case 'glNormalPointer':this._array('normal',3,args[0],args[1],args[2]);break;
      case 'glEnableClientState':case 'glDisableClientState':{
        let kind=CLIENT_KIND.get(args[0]);if(!kind)break;
        if(kind==='texcoord'&&this.clientUnit)kind='texcoord1';
        if(name==='glEnableClientState')this.enabled.add(kind);else this.enabled.delete(kind);break;
      }
      case 'glClientActiveTexture':case 'glClientActiveTextureARB':{const unit=args[0]-0x84c0;if(unit===0||unit===1)this.clientUnit=unit;break;}
      case 'glPixelStorei':{
        const [parameter,value]=args,u=this.unpack;
        if(parameter===0x0cf5)u.alignment=value;else if(parameter===0x0cf2)u.rowLength=value;else if(parameter===0x0cf3)u.skipRows=value;else if(parameter===0x0cf4)u.skipPixels=value;
        break;
      }
    }
  }
  _array(kind,size,type,stride,pointer){
    // Invalid layouts are rejected by the broker when it executes this call;
    // draws fall back to the synchronous path, which reaches that error first.
    const width=type===F32?4:type===U8&&kind==='color'?1:0;
    const invalid=!width||size<1||size>4||stride>1024*1024||(stride&&stride<size*width);
    // Updated in place: a draw reads the entry while it builds its record.
    let entry=this.arrays.get(kind);if(!entry)this.arrays.set(kind,entry={});
    entry.size=size;entry.type=type;entry.stride=stride||size*width;entry.pointer=pointer;entry.width=width;entry.invalid=invalid;
  }
  // Byte spans of the enabled arrays for vertices [first, first+count),
  // merged when they overlap (interleaved layouts) and checked like the
  // broker's synchronous draw path.
  // One plan reused by every draw: it is written to the stream at once.
  _spans(first,count){
    const h=this.host,spans=this.planSpans??=[],groups=this.planGroups??=[];
    const spanPool=this.spanPool??=KINDS.map(()=>({})),groupPool=this.groupPool??=KINDS.map(()=>({}));
    spans.length=0;groups.length=0;
    for(let k=0;k<KINDS.length;k++){
      const kind=KINDS[k];
      if(!this.enabled.has(kind))continue;
      const array=this.arrays.get(kind);if(!array||!array.pointer||array.invalid)return null;
      const start=array.pointer+first*array.stride,length=count?(count-1)*array.stride+array.size*array.width:0;
      if(!Number.isSafeInteger(start+length)||start+length>0x100000000)return null;
      if(count)try{h.check(start,length);}catch{return null;}
      const span=spanPool[spans.length];span.kind=kind;span.array=array;span.first=start;span.start=start-start%4;span.end=start+length;span.offset=0;spans.push(span);
    }
    spans.sort(byStart);
    let bytes=0;
    for(let i=0;i<spans.length;){
      // Gaps shorter than a page lie on pages that already hold span bytes.
      let j=i+1,end=spans[i].end;while(j<spans.length&&spans[j].start<=end+256){end=Math.max(end,spans[j].end);j++;}
      const start=spans[i].start;let source;
      try{source=h.check(start,end-start);}catch{return null;}
      const group=groupPool[groups.length];group.source=source;group.length=end-start;group.offset=bytes;groups.push(group);
      for(;i<j;i++)spans[i].offset=bytes+(spans[i].first-start);
      bytes+=align4(end-start);
    }
    const plan=this.plan??={spans,groups,bytes:0};plan.bytes=bytes;return plan;
  }
  _writeDraw(at,mode,count,type,vertexCount,plan){
    const w=at>>2,words=this.words,{spans,groups,bytes}=plan;
    words[w+3]=0;words[w+4]=mode;words[w+5]=count;words[w+6]=type;words[w+7]=vertexCount;words[w+8]=spans.length;words[w+9]=bytes;
    for(let i=0,p=w+10;i<spans.length;i++,p+=5){const {kind,array,offset}=spans[i];words[p]=KINDS.indexOf(kind);words[p+1]=array.size;words[p+2]=array.type;words[p+3]=array.stride;words[p+4]=offset;}
    const vertexStart=at+40+spans.length*20,memory=this.host._bytes;
    for(const group of groups)this.bytes.set(memory.subarray(group.source,group.source+group.length),vertexStart+group.offset);
    return vertexStart+bytes;
  }
  _drawElements(id,returnAddress,[mode,count,type,pointer]){
    const Type=indexType(type),width=Type?.BYTES_PER_ELEMENT;
    if(!Type||count>4*1024*1024||!this.enabled.has('position'))return false;
    const h=this.host;let at;
    try{at=h.check(pointer,count*width);}catch{return false;}
    if(at%width)return false;
    const indices=new Type(h._bytes.buffer,at,count);let minimum=count?0xffffffff:0,maximum=-1;
    for(let i=0;i<count;i++){const index=indices[i];if(index>maximum)maximum=index;if(index<minimum)minimum=index;}
    if(maximum>=4*1024*1024)return false;
    // Only the referenced vertex range is captured; indices are rebased to it.
    const vertexCount=maximum+1-minimum,plan=this._spans(minimum,vertexCount);if(!plan)return false;
    const record=this._reserve(40+plan.spans.length*20+plan.bytes+align4(count*width));if(record<0)return false;
    this._header(record,id,returnAddress);
    const indexStart=this._writeDraw(record,mode,count,type,vertexCount,plan);
    if(!minimum)this.bytes.set(new Uint8Array(indices.buffer,indices.byteOffset,count*width),indexStart);
    else{const rebased=new Type(this.buffer,indexStart,count);for(let i=0;i<count;i++)rebased[i]=indices[i]-minimum;}
    return true;
  }
  _drawArrays(id,returnAddress,[mode,first,count]){
    if(first>0x7fffffff||count>4*1024*1024||!this.enabled.has('position'))return false;
    const plan=this._spans(first,count);if(!plan)return false;
    const record=this._reserve(40+plan.spans.length*20+plan.bytes);if(record<0)return false;
    this._header(record,id,returnAddress);this._writeDraw(record,mode,count,0,count,plan);
    return true;
  }
  // Byte count of an upload under the mirrored unpack state (pixelLayout()).
  _pixelBytes(width,height,format,type){
    const channels=CHANNELS.get(format),u=this.unpack;
    if(width>32768||height>32768||type!==U8||!channels||![1,2,4,8].includes(u.alignment))return -1;
    const stride=Math.ceil((u.rowLength||width)*channels/u.alignment)*u.alignment,offset=u.skipRows*stride+u.skipPixels*channels;
    const required=width&&height?offset+stride*(height-1)+width*channels:0;
    return required>256*1024*1024?-1:required;
  }
  _texture(id,returnAddress,args,sub){
    const width=args[sub?4:3],height=args[sub?5:4],pointer=args[8],h=this.host;
    let size=0,source=0;
    if(pointer){
      size=this._pixelBytes(width,height,args[6],args[7]);if(size<0)return false;
      try{source=h.check(pointer,size);}catch{return false;}
    }else if(sub)return false;
    const at=this._reserve(60+align4(size));if(at<0)return false;
    const w=this._header(at,id,returnAddress),words=this.words;
    words[w+3]=9;for(let k=0;k<9;k++)words[w+4+k]=args[k];words[w+13]=size;words[w+14]=pointer?1:0;
    if(size)this.bytes.set(h._bytes.subarray(source,source+size),at+60);
    return true;
  }
  _deleteTextures(id,returnAddress,[count,pointer]){
    if(count>65536)return false;
    const h=this.host;let source;
    try{source=h.check(pointer,count*4);}catch{return false;}
    const at=this._reserve(16+count*4);if(at<0)return false;
    const w=this._header(at,id,returnAddress);this.words[w+3]=count;
    this.bytes.set(h._bytes.subarray(source,source+count*4),at+16);
    return true;
  }
  // Submits the frame and keeps at most framesInFlight frames queued.
  _frame(){
    this.submit();this.frames++;Atomics.store(this.control,FRAMES_SUBMITTED,this.frames);
    const target=this.frames-this.framesInFlight;
    if(target>0)this._waitWhile(FRAMES_COMPLETED,completed=>completed<target,'frame presentation');
  }
}
