import {GL,FixedFunctionGL} from './graphics.mjs';
import {WSA,WSAError,addressPeer,peerAddress} from './winsock.mjs';
import {installOverlappedWinsock} from './winsock-overlapped.mjs';
import {installMilesStreams} from './miles-streams.mjs';
import {installMilesSpatial} from './miles-spatial.mjs';

const F32=0x1406,F64=0x140a,U8=0x1401,U16=0x1403,U32=0x1405;
const floatScratch=new DataView(new ArrayBuffer(8));
const f32=bits=>{floatScratch.setUint32(0,bits,true);return floatScratch.getFloat32(0,true);};
const f64=(low,high)=>{floatScratch.setUint32(0,low,true);floatScratch.setUint32(4,high,true);return floatScratch.getFloat64(0,true);};
const fail=(name,message)=>{throw new Error(`Platform HLE ${name}: ${message}`);};
const integer=(name,value,minimum=0,maximum=0x7fffffff)=>{if(!Number.isInteger(value)||value<minimum||value>maximum)fail(name,'integer argument outside supported range');return value;};

export function installPlatform(h) {
  installOpenGL(h);installWinsock(h);installMiles(h);
}

function installOpenGL(h) {
  const state={arrays:new Map(),enabled:new Set(),clientUnit:0,packAlignment:4,wgl:0,current:0,dc:0,strings:new Map()};
  const graphics=()=>h.graphics||fail('OpenGL','WebGL renderer unavailable');
  const gl=()=>graphics().gl||fail('OpenGL','direct WebGL context unavailable');
  const add=(name,count,fn)=>h.add('opengl32.dll',name,count,fn);
  const pixelFormat=(dc,output=0)=>{
    if(!h.getHandle(dc,'dc'))return 0;
    const context=gl();
    if(output){
      h.zero(output,40);h.w16(output,40);h.w16(output+2,1);h.w32(output+4,0x25);
      const red=context.getParameter(context.RED_BITS),green=context.getParameter(context.GREEN_BITS),blue=context.getParameter(context.BLUE_BITS);
      h.w8(output+9,red+green+blue);
      [red,0,green,red,blue,red+green,context.getParameter(context.ALPHA_BITS),red+green+blue].forEach((v,i)=>h.w8(output+10+i,v));
      h.w8(output+23,context.getParameter(context.DEPTH_BITS));h.w8(output+24,context.getParameter(context.STENCIL_BITS));
    }
    return 1;
  };
  h.add('gdi32.dll','ChoosePixelFormat',2,([dc,descriptor])=>{
    if(!descriptor||h.u16(descriptor)!==40||h.u16(descriptor+2)!==1){h.lastError=87;return 0;}
    if(h.u8(descriptor+8)!==0||h.u8(descriptor+26)!==0||h.u32(descriptor+4)&0x1a){h.lastError=2000;return 0;}
    return pixelFormat(dc);
  });
  h.add('gdi32.dll','DescribePixelFormat',4,([dc,index,size,output])=>{
    if(!output)return pixelFormat(dc);
    if(index!==1||size<40){h.lastError=87;return 0;}return pixelFormat(dc,output);
  });
  h.add('gdi32.dll','SetPixelFormat',3,([dc,index])=>{
    const item=h.getHandle(dc,'dc');if(!item)return 0;
    const window=h.handles.get(item.window),previous=window?.pixelFormat||item.pixelFormat;
    if(index!==1||previous){h.lastError=2000;return 0;}
    if(!pixelFormat(dc))return 0;item.pixelFormat=index;if(window)window.pixelFormat=index;return 1;
  });
  h.add('gdi32.dll','GetPixelFormat',1,([dc])=>{const item=h.getHandle(dc,'dc');return item?(h.handles.get(item.window)?.pixelFormat||item.pixelFormat||0):0;});
  // Warcraft's gamma slider programs the display's gamma ramp (3×256 WORDs).
  // The renderer applies the ramp to presented frames, as the display would;
  // Warcraft enables the slider only when it can read the current ramp. The
  // ramp belongs to the display, so it outlives GL contexts: Warcraft restores
  // the original ramp while destroying its window, after wglDeleteContext.
  h.gammaRamp=Uint16Array.from({length:768},(_,i)=>(i&255)*257);
  h.add('gdi32.dll','GetDeviceGammaRamp',2,([dc,ramp])=>{
    if(!h.getHandle(dc,'dc')){h.lastError=6;return 0;}
    h.check(ramp,1536);for(let i=0;i<768;i++)h.w16(ramp+i*2,h.gammaRamp[i]);return 1;
  });
  h.add('gdi32.dll','SetDeviceGammaRamp',2,([dc,ramp])=>{
    if(!h.getHandle(dc,'dc')){h.lastError=6;return 0;}
    h.check(ramp,1536);const values=new Uint16Array(768);for(let i=0;i<768;i++)values[i]=h.u16(ramp+i*2);
    h.gammaRamp=values;if(h.graphics&&!h.graphics.destroyed)h.graphics.setGammaRamp?.(values);return 1;
  });
  // Windowed Warcraft (-window) leaves the desktop ramp alone, so its gamma
  // option (0–100, Video\gamma) would do nothing. Fullscreen game.dll programs
  // exponent 1.2 − gamma/100 (1.2 darkest, 0.9 default, 0.2 brightest); the
  // renderer applies the same exponent for launcher settings and OK in the
  // game's Video options. Without a launcher value the output is unchanged.
  h.gammaExponent=null;
  h.setGammaOption=value=>{
    h.gammaExponent=1.2-value/100;
    if(h.graphics&&!h.graphics.destroyed)h.graphics.setGammaExponent?.(h.gammaExponent);
  };
  if(h.graphicsSettings?.gamma!==undefined)h.setGammaOption(h.graphicsSettings.gamma);
  const direct=(name,count,method,floatArgs=[])=>{
    if(!floatArgs.length){add(name,count,args=>graphics()[method](...args));return;}
    add(name,count,args=>{const values=args.slice();for(const index of floatArgs)values[index]=f32(values[index]);return graphics()[method](...values);});
  };
  for(const [name,count,method,floatArgs] of [
    ['glClearColor',4,'clearColor',[0,1,2,3]],['glClear',1,'clear'],['glViewport',4,'viewport'],
    ['glScissor',4,'scissor'],['glMatrixMode',1,'matrixMode'],['glLoadIdentity',0,'loadIdentity'],
    ['glPushMatrix',0,'pushMatrix'],['glPopMatrix',0,'popMatrix'],['glTranslatef',3,'translate',[0,1,2]],
    ['glScalef',3,'scale',[0,1,2]],['glRotatef',4,'rotate',[0,1,2,3]],['glEnable',1,'enable'],
    ['glDisable',1,'disable'],['glBlendFunc',2,'blendFunc'],['glDepthFunc',1,'depthFunc'],
    ['glDepthMask',1,'depthMask'],['glAlphaFunc',2,'alphaFunc',[1]],['glCullFace',1,'cullFace'],
    ['glFrontFace',1,'frontFace'],['glColorMask',4,'colorMask'],['glBindTexture',2,'bindTexture'],
    ['glTexParameteri',3,'texParameteri'],['glTexEnvi',3,'texEnvi'],['glBegin',1,'begin'],
    ['glEnd',0,'end'],['glColor4f',4,'color',[0,1,2,3]],['glColor3f',3,'color',[0,1,2]],
    ['glTexCoord2f',2,'texCoord',[0,1]],['glVertex2f',2,'vertex',[0,1]],
    ['glVertex3f',3,'vertex',[0,1,2]],['glVertex4f',4,'vertex',[0,1,2,3]],['glFlush',0,'flush'],
    ['glFogf',2,'fogf',[1]],['glIsEnabled',1,'isEnabled'],
    ['glNormal3f',3,'normal',[0,1,2]],['glShadeModel',1,'shadeModel'],['glColorMaterial',2,'colorMaterial'],
  ])direct(name,count,method,floatArgs);
  for(const suffix of ['', 'ARB']){
    add('glActiveTexture'+suffix,1,([unit])=>graphics().activeTexture(unit));
    add('glClientActiveTexture'+suffix,1,([unit])=>{integer('glClientActiveTexture',unit-0x84c0,0,1);state.clientUnit=unit-0x84c0;});
    for(let count=1;count<=4;count++)for(const [type,width,convert] of [['f',4,f32],['d',8,null],['i',4,v=>v|0],['s',2,v=>v<<16>>16]]){
      add(`glMultiTexCoord${count}${type}${suffix}`,1+count*(type==='d'?2:1),args=>{
        const values=Array.from({length:count},(_,i)=>type==='d'?f64(args[1+i*2],args[2+i*2]):convert(args[1+i]));
        graphics().multiTexCoord(args[0],values[0],values[1]??0,values[2]??0,values[3]??1);
      });
      add(`glMultiTexCoord${count}${type}v${suffix}`,2,([unit,pointer])=>{
        const address=h.check(pointer,count*width);const values=Array.from({length:count},(_,i)=>type==='d'?h.view.getFloat64(address+i*8,true):type==='f'?h.view.getFloat32(address+i*4,true):type==='i'?h.i32(pointer+i*4):h.view.getInt16(address+i*2,true));
        graphics().multiTexCoord(unit,values[0],values[1]??0,values[2]??0,values[3]??1);
      });
    }
  }
  add('glTexParameterf',3,([target,parameter,value])=>graphics().texParameteri(target,parameter,Math.round(f32(value))));
  for(const [name,integral] of [['glTexParameterfv',false],['glTexParameteriv',true]])add(name,3,([target,parameter,pointer])=>{
    const count=parameter===0x1004?4:1;h.check(pointer,count*4);
    const values=Array.from({length:count},(_,i)=>integral?h.i32(pointer+i*4):h.view.getFloat32(h.check(pointer+i*4,4),true));
    graphics().texParameterfv(target,parameter,integral&&count===4?values.map(v=>(2*v+1)/4294967295):values);
  });
  add('glFogi',2,([parameter,value])=>graphics().fogf(parameter,value|0));
  for(const [name,integral] of [['glFogfv',false],['glFogiv',true]])add(name,2,([parameter,pointer])=>{
    const count=parameter===GL.FOG_COLOR?4:1;h.check(pointer,count*4);
    const values=Array.from({length:count},(_,i)=>integral?h.i32(pointer+i*4):h.view.getFloat32(h.check(pointer+i*4,4),true));
    graphics().fogfv(parameter,integral&&parameter===GL.FOG_COLOR?values.map(v=>(2*v+1)/4294967295):values);
  });
  // GLint origins are signed even though the guest stack is read as uint32.
  add('glViewport',4,([x,y,width,height])=>graphics().viewport(x|0,y|0,width|0,height|0));
  add('glScissor',4,([x,y,width,height])=>graphics().scissor(x|0,y|0,width|0,height|0));
  const floats=(pointer,count)=>{const at=h.check(pointer,count*4),view=h.view,values=new Float32Array(count);for(let i=0;i<count;i++)values[i]=view.getFloat32(at+i*4,true);return values;};
  for(const [name,method] of [['glLoadMatrixf','loadMatrix'],['glMultMatrixf','multMatrix']])add(name,1,([pointer])=>graphics()[method](floats(pointer,16)));
  for(const [name,method] of [['glOrtho','ortho'],['glFrustum','frustum']])add(name,12,args=>graphics()[method](...Array.from({length:6},(_,i)=>f64(args[i*2],args[i*2+1]))));
  add('glClearDepth',2,args=>graphics().clearDepth(f64(...args)));
  add('glDepthRange',4,args=>{gl().depthRange(f64(args[0],args[1]),f64(args[2],args[3]));graphics()._check('glDepthRange');});
  add('glPolygonOffset',2,([factor,units])=>{gl().polygonOffset(f32(factor),f32(units));graphics()._check('glPolygonOffset');});
  // glFinish only orders GL work against later readback, which WebGL already
  // guarantees, and frame pacing bounds latency. A blocking finish stalls the
  // renderer on the GPU process every frame; strictFinish restores it.
  add('glFinish',0,()=>{if(h.strictFinish){gl().finish();graphics()._check('glFinish',true);}else gl().flush();});
  add('glGetError',0,()=>gl().getError());
  add('glColor4ub',4,args=>graphics().color(...args.map(v=>(v&255)/255)));
  add('glColor4fv',1,([p])=>graphics().color(...floats(p,4)));
  add('glPixelStorei',2,([parameter,value])=>{if(parameter===0x0d05){if(![1,2,4,8].includes(value))fail('glPixelStorei','invalid PACK_ALIGNMENT');state.packAlignment=value;}else graphics().pixelStorei(parameter,value);});
  add('glGenTextures',2,([count,pointer])=>{integer('glGenTextures',count,0,65536);h.check(pointer,count*4);for(let i=0;i<count;i++)h.w32(pointer+i*4,graphics().genTexture());});
  add('glDeleteTextures',2,([count,pointer])=>{integer('glDeleteTextures',count,0,65536);h.check(pointer,count*4);for(let i=0;i<count;i++)graphics().deleteTexture(h.u32(pointer+i*4));});
  const pixelBytes=(width,height,format,type)=>{
    return graphics().pixelLayout(width,height,format,type).required;
  };
  add('glTexImage2D',9,args=>{const[target,level,internal,width,height,border,format,type,pointer]=args;graphics().texImage2D(target,level,internal,width,height,border,format,type,pointer?h.copyOut(pointer,pixelBytes(width,height,format,type)):null);});
  add('glTexSubImage2D',9,args=>{const[target,level,x,y,width,height,format,type,pointer]=args;if(!pointer)fail('glTexSubImage2D','null pixels');graphics().texSubImage2D(target,level,x,y,width,height,format,type,h.copyOut(pointer,pixelBytes(width,height,format,type)));});
  const arrayKind=new Map([[0x8074,'position'],[0x8075,'normal'],[0x8076,'color'],[0x8078,'texcoord']]);
  const clientArray=capability=>{const kind=arrayKind.get(capability);return kind==='texcoord'&&state.clientUnit?'texcoord1':kind;};
  const setArray=(kind,size,type,stride,pointer)=>{
    if(type!==F32&&!(kind==='color'&&type===U8))fail(`${kind}Pointer`,`unsupported component type 0x${type.toString(16)}`);
    if(!Number.isInteger(size)||size<(kind==='texcoord'?1:2)||size>4||(kind==='color'&&size<3)||(kind==='normal'&&size!==3))fail(`${kind}Pointer`,'unsupported component count');
    const width=type===F32?4:1;integer(`${kind}Pointer stride`,stride,0,1024*1024);
    if(stride&&stride<size*width)fail(`${kind}Pointer`,'stride smaller than one element');
    state.arrays.set(kind==='texcoord'&&state.clientUnit?'texcoord1':kind,{size,type,stride:stride||size*width,pointer});
  };
  add('glVertexPointer',4,args=>setArray('position',...args));add('glColorPointer',4,args=>setArray('color',...args));add('glTexCoordPointer',4,args=>setArray('texcoord',...args));
  add('glNormalPointer',3,([type,stride,pointer])=>setArray('normal',3,type,stride,pointer));
  add('glNormal3fv',1,([pointer])=>graphics().normal(...floats(pointer,3)));
  add('glEnableClientState',1,([capability])=>{const kind=clientArray(capability);if(!kind)fail('glEnableClientState',`unsupported capability 0x${capability.toString(16)}`);state.enabled.add(kind);});
  add('glDisableClientState',1,([capability])=>{const kind=clientArray(capability);if(!kind)fail('glDisableClientState',`unsupported capability 0x${capability.toString(16)}`);state.enabled.delete(kind);});
  // Client arrays reach the renderer as raw guest bytes in their original
  // layout; WebGL converts types on the GPU. Interleaved arrays share memory,
  // so overlapping spans are merged and uploaded once.
  const arrayKinds=['position','color','texcoord','texcoord1','normal'];
  const arrays=(first,count)=>{
    if(!state.enabled.has('position'))fail('draw','vertex array is disabled');
    integer('draw first',first,0,0x7fffffff);integer('draw count',count,0,4*1024*1024);
    const spans=[];
    for(const kind of arrayKinds)if(state.enabled.has(kind)){
      const array=state.arrays.get(kind);if(!array||!array.pointer)fail('draw',`${kind} array is unset`);
      const width=array.type===F32?4:1,start=array.pointer+first*array.stride,length=count?(count-1)*array.stride+array.size*width:0;
      if(!Number.isSafeInteger(start+length)||start+length>0x100000000)fail('draw','guest array pointer overflow');
      if(count)h.check(start,length);
      spans.push({kind,array,start:start-start%4,first:start,end:start+length});
    }
    spans.sort((a,b)=>a.start-b.start);
    const raw={},bytes=h.bytes??new Uint8Array(h.memory.buffer);
    for(let i=0;i<spans.length;){
      // Gaps shorter than a page lie on pages that already hold span bytes.
      let j=i+1,end=spans[i].end;while(j<spans.length&&spans[j].start<=end+256){end=Math.max(end,spans[j].end);j++;}
      const start=spans[i].start,view=bytes.subarray(h.check(start,end-start),h.base+end);
      for(;i<j;i++){const {kind,array,first:at}=spans[i];raw[kind]={bytes:view,offset:at-start,type:array.type===F32?GL.FLOAT:GL.UNSIGNED_BYTE,size:array.size,stride:array.stride};}
    }
    return {raw};
  };
  add('glDrawArrays',3,([mode,first,count])=>graphics().drawArrays(mode,0,count,arrays(first,count)));
  add('glDrawElements',4,([mode,count,type,pointer])=>{
    integer('glDrawElements',count,0,4*1024*1024);const width=type===U8?1:type===U16?2:type===U32?4:0;if(!width)fail('glDrawElements','unsupported index type');
    const offset=h.check(pointer,count*width),Type=width===1?Uint8Array:width===2?Uint16Array:Uint32Array;
    let indices=offset%width?new Type(new Uint8Array(h.memory.buffer).slice(offset,offset+count*width).buffer):new Type(h.memory.buffer,offset,count),minimum=count?0xffffffff:0,maximum=-1;
    for(let i=0;i<count;i++){const index=indices[i];if(index>maximum)maximum=index;if(index<minimum)minimum=index;}
    if(maximum>=4*1024*1024)fail('glDrawElements','vertex index exceeds transfer limit');
    // Upload only the referenced vertex range.
    if(minimum>0){const rebased=new Type(count);for(let i=0;i<count;i++)rebased[i]=indices[i]-minimum;indices=rebased;}
    graphics().drawElements(mode,indices,arrays(minimum,maximum+1-minimum),maximum+1-minimum);
  });
  add('glGetString',1,([parameter])=>{
    if(state.strings.has(parameter))return state.strings.get(parameter);
    let value;if(parameter===0x1f00)value=String(gl().getParameter(gl().VENDOR));
    else if(parameter===0x1f01)value=String(gl().getParameter(gl().RENDERER));
    else if(parameter===0x1f02)value='1.1 WC3 browser fixed-function subset';
    else if(parameter===0x1f03)value='GL_ARB_multitexture';else fail('glGetString',`unsupported string 0x${parameter.toString(16)}`);
    const pointer=h.string(value);state.strings.set(parameter,pointer);return pointer;
  });
  const parameterValue=parameter=>{
    if(parameter===GL.FOG)return graphics().fog.enabled;
    const fogParameter=new Map([[GL.FOG_MODE,'mode'],[GL.FOG_DENSITY,'density'],[GL.FOG_START,'start'],[GL.FOG_END,'end'],[GL.FOG_COLOR,'color']]).get(parameter);
    if(fogParameter)return graphics().fog[fogParameter];
    if(parameter===0x0ba0)return graphics().mode;
    if(parameter===0x0d33)return gl().getParameter(gl().MAX_TEXTURE_SIZE);
    if(parameter===0x84e2||parameter===0x8872)return 2;
    if(parameter===0x84e0)return 0x84c0+graphics().activeUnit;
    if(parameter===0x84e1)return 0x84c0+state.clientUnit;
    if(parameter===0x0d31)return 8;
    if(parameter===GL.LIGHT_MODEL_AMBIENT)return graphics().lighting.ambient;
    if(parameter===GL.LIGHT_MODEL_LOCAL_VIEWER)return graphics().lighting.localViewer;
    if(parameter===GL.LIGHT_MODEL_TWO_SIDE)return graphics().lighting.twoSide;
    if(parameter===0x0b54)return graphics().shading;
    if(parameter===0x0d36||parameter===0x0d38||parameter===0x0d39)return 32;
    const unpackKey=new Map([[0x0cf0,'unpackSwapBytes'],[0x0cf1,'unpackLSBFirst'],[0x0cf2,'unpackRowLength'],[0x0cf3,'unpackSkipRows'],[0x0cf4,'unpackSkipPixels'],[0x0cf5,'unpackAlignment']]).get(parameter);
    if(unpackKey)return graphics()[unpackKey];
    if(parameter===0x0d05)return state.packAlignment;
    if(parameter===0x8069)return graphics().boundTexture;
    if([0x0ba6,0x0ba7,0x0ba8].includes(parameter))return graphics()._matrix(parameter===0x0ba6?GL.MODELVIEW:parameter===0x0ba7?GL.PROJECTION:GL.TEXTURE);
    if([0x0ba2,0x0c10,0x0c23,0x0b70,0x0b72,0x0b74,0x0b45,0x0b46,0x0d50,0x0d52,0x0d53,0x0d54,0x0d55,0x0d56,0x0d57].includes(parameter))return gl().getParameter(parameter);
    fail('glGet*',`unsupported parameter 0x${parameter.toString(16)}`);
  };
  for(const [name,type,width] of [['glGetIntegerv','int',4],['glGetFloatv','float',4],['glGetBooleanv','bool',1]])add(name,2,([parameter,pointer])=>{
    const result=parameterValue(parameter),values=ArrayBuffer.isView(result)||Array.isArray(result)?result:[result];h.check(pointer,values.length*width);
    values.forEach((value,index)=>{if(type==='float')h.view.setFloat32(h.check(pointer+index*4,4),Number(value),true);else if(type==='bool')h.w8(pointer+index,value?1:0);else h.w32(pointer+index*4,parameter===GL.FOG_COLOR?Math.round(value*2147483647):Number(value));});
  });
  add('glReadBuffer',1,([buffer])=>{if(![0x0405,0].includes(buffer))fail('glReadBuffer','only default back buffer is supported');gl().readBuffer(buffer?gl().COLOR_ATTACHMENT0:gl().NONE);graphics()._check('glReadBuffer');});
  add('glDrawBuffer',1,([buffer])=>{if(![0x0405,0].includes(buffer))fail('glDrawBuffer','only default back buffer is supported');gl().drawBuffers([buffer?gl().COLOR_ATTACHMENT0:gl().NONE]);graphics()._check('glDrawBuffer');});
  add('glReadPixels',7,([x,y,width,height,format,type,pointer])=>{
    integer('glReadPixels width',width,0,32768);integer('glReadPixels height',height,0,32768);
    if(type!==U8||![GL.RGB,GL.RGBA].includes(format)||width*height>64*1024*1024)fail('glReadPixels','only bounded RGB/RGBA unsigned bytes supported');
    const rgba=new Uint8Array(width*height*4),channels=format===GL.RGB?3:4,row=width*channels,stride=Math.ceil(row/state.packAlignment)*state.packAlignment;
    h.check(pointer,height?stride*(height-1)+row:0);gl().pixelStorei(gl().PACK_ALIGNMENT,1);gl().readPixels(x|0,y|0,width,height,gl().RGBA,gl().UNSIGNED_BYTE,rgba);graphics()._check('glReadPixels',true);
    for(let iy=0;iy<height;iy++)for(let ix=0;ix<width;ix++)h.copyIn(pointer+iy*stride+ix*channels,rgba.subarray((iy*width+ix)*4,(iy*width+ix)*4+channels));
  });
  const vector=(pointer,count)=>Array.from(floats(pointer,count));
  add('glLightModelfv',2,([parameter,pointer])=>graphics().lightModelfv(parameter,vector(pointer,parameter===GL.LIGHT_MODEL_AMBIENT?4:1)));
  add('glLightModelf',2,([parameter,value])=>graphics().lightModelfv(parameter,[f32(value)]));
  add('glLightModeli',2,([parameter,value])=>graphics().lightModelfv(parameter,[value|0]));
  add('glLightfv',3,([light,parameter,pointer])=>graphics().lightfv(light,parameter,vector(pointer,parameter===GL.SPOT_DIRECTION?3:parameter>=GL.AMBIENT&&parameter<=GL.POSITION?4:1)));
  add('glLightf',3,([light,parameter,value])=>graphics().lightfv(light,parameter,[f32(value)]));
  add('glMaterialfv',3,([face,parameter,pointer])=>graphics().materialfv(face,parameter,vector(pointer,parameter===GL.SHININESS?1:4)));
  add('glMaterialf',3,([face,parameter,value])=>graphics().materialfv(face,parameter,[f32(value)]));
  add('glTexGeni',3,([coordinate,parameter,value])=>graphics().texGenfv(coordinate,parameter,[value|0]));
  add('glTexGenf',3,([coordinate,parameter,value])=>graphics().texGenfv(coordinate,parameter,[f32(value)]));
  add('glTexGenfv',3,([coordinate,parameter,pointer])=>graphics().texGenfv(coordinate,parameter,vector(pointer,parameter===GL.TEXTURE_GEN_MODE?1:4)));
  add('wglCreateContext',1,([dc])=>{
    const renderer=graphics();if(state.wgl)fail('wglCreateContext','multiple render contexts are unsupported');
    if(renderer.destroyed){
      h.graphics=new FixedFunctionGL(renderer.canvas,{context:renderer.gl,debugChecks:renderer.debugChecks,legacyClampToEdge:renderer.legacyClampToEdge,nativeTextureShader:renderer.nativeTextureShader});
      if(h.gammaRamp)h.graphics.setGammaRamp(h.gammaRamp);
      if(h.gammaExponent)h.graphics.setGammaExponent(h.gammaExponent);
    }
    state.arrays.clear();state.enabled.clear();state.clientUnit=0;state.packAlignment=4;state.strings.clear();
    state.wgl=h.handle({kind:'wgl',dc});state.dc=dc;return state.wgl;
  });
  add('wglMakeCurrent',2,([dc,context])=>{if(!dc&&!context){state.current=0;return 1;}if(context!==state.wgl||!context){h.lastError=6;return 0;}state.current=context;state.dc=dc;return 1;});
  add('wglDeleteContext',1,([context])=>{if(!context||context!==state.wgl){h.lastError=6;return 0;}graphics().destroy();h.handles.delete(context);state.wgl=state.current=0;return 1;});
  add('wglGetCurrentContext',0,()=>state.current);add('wglGetCurrentDC',0,()=>state.current?state.dc:0);
  add('wglGetProcAddress',1,([pointer])=>{const name=h.cstr(pointer);return h.handlers.has(`opengl32.dll!${name}`)?h.resolve('opengl32.dll',name):0;});
  const swap=()=>{const frame=graphics().swapBuffers();h.presentFrame?.(frame);return 1;};
  add('wglSwapLayerBuffers',2,([dc,planes])=>{if(planes!==1)fail('wglSwapLayerBuffers','only WGL_SWAP_MAIN_PLANE supported');return swap();});
  h.add('gdi32.dll','SwapBuffers',1,swap);
}

function installWinsock(h) {
  // ABI ordinals verified against Wine's wsock32.spec and this game.dll IAT.
  // https://github.com/wine-mirror/wine/blob/master/dlls/wsock32/wsock32.spec
  const state={wsaError:0,startups:0,hostEntries:new Map(),inetPointer:0},observed=new WeakSet();
  Object.defineProperty(state,'error',{get:()=>(h.threadContext||state).wsaError||0,set:value=>{(h.threadContext||state).wsaError=value;}});
  const network=()=>{
    if(!h.network)throw new WSAError(10091,'Virtual LAN is unavailable');
    if(h.threadServices&&!observed.has(h.network)){
      const notify=()=>h.threadServices.notify();
      h.network.addEventListener('change',notify);
      observed.add(h.network);
    }
    return h.network;
  };
  const add=(ordinal,name,count,fn,{raw=false,failure=-1,dlls=['wsock32.dll','ws2_32.dll']}={})=>{
    const call=args=>{
      const context=h.threadContext||state;
      const record=(result,error)=>{
        if(!['select','WSAGetLastError','WSASetLastError','htons','ntohs','htonl','ntohl','__WSAFDIsSet'].includes(name)||error){
          const entries=h.networkOperations??=[];entries.push({name,args:args.slice(),threadId:context.id,result,error});if(entries.length>128)entries.shift();
        }
        return result;
      };
      // After a network game Warcraft keeps closing its INVALID_SOCKET slots;
      // that fails with WSAENOTSOCK, as on Windows, without a log line each time.
      const quiet=error=>[WSA.EWOULDBLOCK,997].includes(error.code)||(name==='closesocket'&&args[0]===0xffffffff);
      const rejected=error=>{if(raw||!(error instanceof WSAError))throw error;context.wsaError=error.code;
        if(!quiet(error))h.log?.(`Winsock ${name}: ${error.code} ${error.message}`);
        return record(failure,{code:error.code,message:error.message});};
      try{const result=fn(args);return result&&typeof result.then==='function'?result.then(value=>record(value)).catch(rejected):record(result);}
      catch(error){return rejected(error);}
    };
    for(const dll of dlls){h.add(dll,name,count,call);if(ordinal!==null)h.add(dll,`#${ordinal}`,count,call);}
  };
  const wsafail=(code,message)=>{throw new WSAError(code,message);};
  const checked=(pointer,length)=>{if(!pointer)wsafail(10014,'Null socket argument');h.check(pointer,length);};
  const ipBytes=address=>{const parts=String(address).split('.').map(Number);if(parts.length!==4||parts.some(v=>!Number.isInteger(v)||v<0||v>255))wsafail(WSA.EINVAL,'Invalid IPv4 address');return parts;};
  const sockaddr=(pointer,length)=>{checked(pointer,16);if(length<16)wsafail(10014,'sockaddr_in too short');if(h.u16(pointer)!==2)wsafail(WSA.EAFNOSUPPORT,'Only AF_INET supported');return{address:[0,1,2,3].map(i=>h.u8(pointer+4+i)).join('.'),port:h.u8(pointer+2)*256+h.u8(pointer+3)};};
  const writeAddress=(pointer,sizePointer,value)=>{if(!pointer)return;checked(sizePointer,4);if(h.u32(sizePointer)<16)wsafail(10014,'sockaddr_in output too short');checked(pointer,16);h.zero(pointer,16);h.w16(pointer,2);h.w8(pointer+2,value.port>>>8);h.w8(pointer+3,value.port&255);ipBytes(value.address).forEach((v,i)=>h.w8(pointer+4+i,v));h.w32(sizePointer,16);};
  const swap16=value=>((value&255)<<8)|((value>>>8)&255);
  const swap32=value=>(((value&255)<<24)|((value&0xff00)<<8)|((value>>>8)&0xff00)|((value>>>24)&255))>>>0;
  add(1,'accept',3,([fd,pointer,size])=>{if(pointer){checked(size,4);if(h.u32(size)<16)wsafail(10014,'sockaddr output too short');checked(pointer,16);}const result=network().accept(fd);writeAddress(pointer,size,result);return result.socket;});
  add(2,'bind',3,([fd,pointer,size])=>network().bind(fd,sockaddr(pointer,size)));
  add(3,'closesocket',1,([fd])=>network().close(fd));
  add(4,'connect',3,([fd,pointer,size])=>network().connect(fd,sockaddr(pointer,size)));
  add(5,'getpeername',3,([fd,pointer,size])=>{checked(pointer,16);writeAddress(pointer,size,network().getpeername(fd));return 0;});
  add(6,'getsockname',3,([fd,pointer,size])=>{checked(pointer,16);const net=network(),value=net.getsockname(fd);if(value.address==='0.0.0.0'&&net.sockets.get(fd)?.state==='connected')value.address=net.address;writeAddress(pointer,size,value);return 0;});
  add(7,'getsockopt',5,([fd,level,option,pointer,size])=>{
    checked(size,4);if(h.u32(size)<4)wsafail(10014,'getsockopt buffer too short');checked(pointer,4);const net=network(),socket=net.sockets.get(fd);if(!socket)wsafail(WSA.ENOTSOCK,'Unknown socket');
    if(level!==0xffff)wsafail(WSA.EOPNOTSUPP,'Only SOL_SOCKET supported');let value;
    if(option===0x1007)value=net.getError(fd);else if(option===0x1008)value=socket.type==='tcp'?1:2;else if(option===0x20)value=Number(socket.broadcast);else if(option===4)value=Number(socket.reuseAddress);else if(option===8)value=Number(socket.keepAlive);else if(option===0x1002)value=net.maxQueuedBytes;else wsafail(WSA.EOPNOTSUPP,'Unsupported getsockopt');h.w32(pointer,value);h.w32(size,4);return 0;
  });
  add(8,'htonl',1,([value])=>swap32(value));add(9,'htons',1,([value])=>swap16(value));
  add(10,'inet_addr',1,([pointer])=>{const text=h.cstr(pointer);if(!/^\d+\.\d+\.\d+\.\d+$/.test(text))return 0xffffffff;let parts;try{parts=ipBytes(text);}catch{return 0xffffffff;}return(parts[0]|parts[1]<<8|parts[2]<<16|parts[3]<<24)>>>0;});
  add(11,'inet_ntoa',1,([value])=>{if(!state.inetPointer)state.inetPointer=h.alloc(16);h.writeString(state.inetPointer,[0,8,16,24].map(shift=>(value>>>shift)&255).join('.'),16);return state.inetPointer;});
  add(12,'ioctlsocket',3,([fd,command,pointer])=>{checked(pointer,4);const net=network(),socket=net.sockets.get(fd);if(!socket)wsafail(WSA.ENOTSOCK,'Unknown socket');if(command===0x8004667e){if(!h.u32(pointer))wsafail(WSA.EOPNOTSUPP,'Blocking sockets cannot block the browser worker');return 0;}if(command===0x4004667f){h.w32(pointer,socket.type==='udp'?(socket.datagrams[0]?.data.length??0):socket.queuedBytes);return 0;}wsafail(WSA.EOPNOTSUPP,'Unsupported socket ioctl');});
  add(13,'listen',2,([fd,backlog])=>network().listen(fd,backlog===0x7fffffff?128:Math.max(1,backlog|0)));
  add(14,'ntohl',1,([value])=>swap32(value));add(15,'ntohs',1,([value])=>swap16(value));
  add(16,'recv',4,([fd,pointer,length,flags])=>{integer('recv',length,0,16*1024*1024);checked(pointer,length);const data=network().recv(fd,length,flags);h.copyIn(pointer,data);return data.length;});
  add(17,'recvfrom',6,([fd,pointer,length,flags,from,fromSize])=>{integer('recvfrom',length,0,16*1024*1024);checked(pointer,length);if(from){checked(fromSize,4);if(h.u32(fromSize)<16)wsafail(10014,'sockaddr output too short');checked(from,16);}const result=network().recvfrom(fd,length,flags);h.copyIn(pointer,result.data);writeAddress(from,fromSize,result);return result.data.length;});
  const readSet=pointer=>{if(!pointer)return[];checked(pointer,4);const count=h.u32(pointer);if(count>64)wsafail(WSA.EINVAL,'fd_set exceeds Windows FD_SETSIZE');checked(pointer,4+count*4);return Array.from({length:count},(_,i)=>h.u32(pointer+4+i*4));};
  const writeSet=(pointer,values)=>{if(!pointer)return;h.w32(pointer,values.length);values.forEach((fd,i)=>h.w32(pointer+4+i*4,fd));};
  add(18,'select',5,([nfds,read,write,except,timeout])=>{
    const requested={read:readSet(read),write:readSet(write),except:readSet(except)};let milliseconds=0xffffffff;
    if(timeout){checked(timeout,8);const seconds=h.i32(timeout),micros=h.i32(timeout+4);if(seconds<0||micros<0||micros>=1000000)wsafail(WSA.EINVAL,'Invalid timeval');milliseconds=Math.min(0xfffffffe,Math.ceil(seconds*1000+micros/1000));}
    const finish=result=>{writeSet(read,result.read);writeSet(write,result.write);writeSet(except,result.except);return result.count;};
    const net=network(),result=net.select(requested);if(result.count||!milliseconds)return finish(result);
    if(!h.scheduler||!h.threadServices)wsafail(WSA.EOPNOTSUPP,'Blocking select requires scheduler integration');
    const pending=h.threadServices.until(()=>{const ready=net.select(requested);return ready.count?finish(ready):null;},milliseconds,()=>finish({count:0,read:[],write:[],except:[]}));
    // Transport backpressure and SYN deadlines may change without a packet.
    const poll=setInterval(()=>h.threadServices.notify(),10);
    return Promise.resolve(pending).finally(()=>clearInterval(poll));
  });
  add(19,'send',4,([fd,pointer,length,flags])=>{if(flags)wsafail(WSA.EOPNOTSUPP,'send flags unsupported');integer('send',length,0,16*1024*1024);checked(pointer,length);return network().send(fd,h.copyOut(pointer,length));});
  add(20,'sendto',6,([fd,pointer,length,flags,to,toLength])=>{if(flags)wsafail(WSA.EOPNOTSUPP,'sendto flags unsupported');integer('sendto',length,0,65535);checked(pointer,length);return network().sendto(fd,h.copyOut(pointer,length),sockaddr(to,toLength));});
  add(21,'setsockopt',5,([fd,level,option,pointer,length])=>{
    if(length<4)wsafail(10014,'setsockopt buffer too short');checked(pointer,4);
    const net=network(),socket=net._get(fd),value=h.u32(pointer);
    if(level===0xffff&&option===0x700b){
      const listener=net._get(value);
      if(socket.state!=='connected'||socket.parent!==value||listener.state!=='listening')wsafail(WSA.EINVAL,'Invalid accept context');
      socket.broadcast=listener.broadcast;socket.reuseAddress=listener.reuseAddress;socket.keepAlive=listener.keepAlive;socket.acceptContext=true;return 0;
    }
    const name={4:'SO_REUSEADDR',8:'SO_KEEPALIVE',32:'SO_BROADCAST'}[option];if(level===0xffff&&name)return net.setsockopt(fd,name,value!==0);
    wsafail(WSA.EOPNOTSUPP,`Unsupported socket option ${level}/${option}`);
  });
  add(22,'shutdown',2,([fd,how])=>network().shutdown(fd,how));
  add(23,'socket',3,([family,type,protocol])=>{if(family!==2)wsafail(WSA.EAFNOSUPPORT,'Only AF_INET supported');if(![1,2].includes(type)||protocol&&protocol!==(type===1?6:17))wsafail(WSA.EPROTOTYPE,'Only TCP and UDP supported');return network().socket(type);});
  const hostname=()=>`wc3-peer-${network().transport.peerId}`;
  add(52,'gethostbyname',1,([pointer])=>{
    const name=h.cstr(pointer);let address;if(name===hostname()||name==='localhost'||name==='127.0.0.1')address=network().address;else{try{addressPeer(name);address=name;}catch{state.error=11001;return 0;}}
    if(state.hostEntries.has(name))return state.hostEntries.get(name);
    const entry=h.alloc(16),aliases=h.alloc(4),addresses=h.alloc(8),ip=h.alloc(4);ipBytes(address).forEach((value,i)=>h.w8(ip+i,value));h.w32(entry,h.string(name));h.w32(entry+4,aliases);h.w16(entry+8,2);h.w16(entry+10,4);h.w32(entry+12,addresses);h.w32(addresses,ip);state.hostEntries.set(name,entry);return entry;
  },{failure:0});
  add(57,'gethostname',2,([pointer,length])=>{const name=hostname();if(length<=name.length)wsafail(10014,'Hostname buffer too short');checked(pointer,length);h.writeString(pointer,name,length);return 0;});
  add(111,'WSAGetLastError',0,()=>state.error,{raw:true});add(112,'WSASetLastError',1,([value])=>{state.error=value;},{raw:true});
  add(115,'WSAStartup',2,([requested,pointer])=>{if(!h.network){state.error=10091;return 10091;}const major=requested&255,minor=requested>>>8&255;if(major<1||major>2){state.error=10092;return 10092;}checked(pointer,400);h.zero(pointer,400);h.w16(pointer,major===1?(minor?0x0101:1):(Math.min(minor,2)<<8)|2);h.w16(pointer+2,0x0202);h.writeString(pointer+4,'WC3 virtual LAN over room frame transport',257);h.writeString(pointer+261,'Running',129);h.w16(pointer+390,64);h.w16(pointer+392,65519);state.startups++;return 0;});
  add(116,'WSACleanup',0,()=>{if(!state.startups)wsafail(10093,'Winsock was not initialized');state.startups--;if(!state.startups)for(const fd of [...network().sockets.keys()])if(network().sockets.has(fd))network().close(fd);return 0;});
  add(151,'__WSAFDIsSet',2,([fd,pointer])=>Number(readSet(pointer).includes(fd)));
  installOverlappedWinsock(h,{add,network,checked,wsafail,ipBytes});
}

function installMiles(h) {
  // AILSOUNDINFO's 32-bit layout and sample format bits follow MSS 6.x headers.
  // Compressed samples, XMIDI and DLS are separate from PCM/spatial playback.
  const state={started:false,error:'',errorPointer:0,redist:'',redistPointer:0,malloc:0,free:0,fileCallbacks:[0,0,0,0],drivers:new Set(),samples:new Set()};
  const audio=()=>h.audio||fail('Miles','PCM output unavailable');
  const add=(name,count,fn)=>{
    const call=args=>{try{const result=fn(args);return result&&typeof result.then==='function'?result.catch(error=>{state.error=error.message;throw error;}):result;}catch(error){state.error=error.message;throw error;}};
    h.add('mss32.dll',`_${name}@${count*4}`,count,call);h.add('mss32.dll',name,count,call);
  };
  const driver=id=>h.getHandle(id,'miles-driver')||fail('Miles driver','invalid handle');
  const sample=id=>h.getHandle(id,'miles-sample')||fail('Miles sample','invalid handle');
  const panValue=value=>(value-64)/(value<64?64:63);
  const sampleDefaults=dig=>({kind:'miles-sample',driver:dig,data:0,length:0,rate:driver(dig).rate,
    bits:driver(dig).bits,channels:driver(dig).channels,volume:127,pan:64,loopCount:1,
    offset:0,status:2,buffer:null,voice:null,userData:new Uint32Array(8),eos:0,eosDelivered:false});
  const releasePlayback=s=>{if(s.voice!==null){audio().releaseVoice(s.voice);s.voice=null;}if(s.buffer!==null){audio().deleteBuffer(s.buffer);s.buffer=null;}};
  const duration=s=>s.length/(s.channels*s.bits/8*s.rate);
  const position=s=>{
    if(s.voice===null)return s.offset;
    const value=audio().getPosition(s.voice),length=duration(s);
    return s.loopCount===0&&length?value%length:Math.min(length,value);
  };
  // Miles calls EOS and stream callbacks from its own service thread as soon
  // as playback ends. Warcraft relies on them rather than on status polling:
  // they return voices to its sample pool, end portrait talk animations and
  // let queued sounds start. A guest thread waits in a host import, and the
  // broker runs each callback on it, one at a time, beside the game thread.
  const service={item:null,waiting:false,queue:[],busy:false,timer:null};
  h.add('wc3host.dll','MilesServiceThread',1,()=>new Promise(()=>{service.waiting=true;setTimeout(pump,0);}));
  function pump(){
    if(service.busy||!service.waiting||!service.queue.length||h.scheduler?.stopped)return;
    const [address,args]=service.queue.shift();service.busy=true;
    h.scheduler.call(service.item.cpu,address,args).then(()=>{service.busy=false;pump();},error=>{service.busy=false;h.scheduler.fail?.(error,service.item);});
  }
  const deliver=(address,args)=>{
    if(!address)return;
    if(!h.scheduler){h.call(address,args);return;} // isolated host: no guest threads
    if(!service.item)service.item=h.scheduler.create(h.resolve('wc3host.dll','MilesServiceThread'),0,0,256*1024);
    service.queue.push([address,args]);setTimeout(pump,0);
  };
  // Playback ends are detected from the expected end time and confirmed with
  // the AudioContext clock, so the callback follows the audible end closely.
  const watch=()=>{
    if(service.timer||!h.scheduler)return;
    let next=Infinity;const now=performance.now();
    for(const item of [...state.samples].map(id=>h.handles.get(id)).concat(state.streamWatch?.()||[]))
      if(item&&item.status===4&&item.voice!==null&&item.loopCount!==0&&(item.eos||item.callback)&&!(item.eosDelivered||item.notified))next=Math.min(next,item.endsAt);
    if(next<Infinity)service.timer=setTimeout(checkEnded,Math.max(1,Math.min(50,next-now)));
  };
  function checkEnded(){
    service.timer=null;if(h.scheduler?.stopped)return;
    const now=performance.now();
    for(const id of [...state.samples]){const s=h.handles.get(id);if(s?.eos&&!s.eosDelivered&&s.status===4&&s.loopCount!==0&&now>=s.endsAt)status(id,s);}
    state.checkStreams?.(now);
    watch();
  }
  const playing=(s,offset)=>{s.endsAt=performance.now()+Math.max(0,duration(s)-offset)*1000;watch();};
  const ended=(id,s)=>{s.status=2;if(s.eos&&!s.eosDelivered){s.eosDelivered=true;deliver(s.eos,[id]);}};
  const status=(id,s)=>{if(s.voice!==null&&s.status===4&&audio().getState(s.voice)==='ended'){s.offset=duration(s);ended(id,s);}return s.status;};
  const start=(id,offset=0)=>{
    const s=sample(id);audio();if(!s.data||!s.length)fail('AIL_start_sample','no PCM data assigned');
    if(offset>=duration(s)){releasePlayback(s);s.offset=duration(s);ended(id,s);return;}
    releasePlayback(s);
    s.buffer=audio().createBuffer({data:h.copyOut(s.data,s.length),format:s.bits===16?'s16le':'u8',channels:s.channels,sampleRate:s.rate});
    try{s.voice=audio().play(s.buffer,{loop:s.loopCount===0,volume:s.volume/127*driver(s.driver).volume,offset,pan:panValue(s.pan),...state.spatialOptions?.(s)});}
    catch(error){audio().deleteBuffer(s.buffer);s.buffer=null;throw error;}
    s.offset=offset;s.status=4;s.eosDelivered=false;playing(s,offset);
  };
  const parseWav=(pointer,maximum=256*1024*1024)=>{
    h.check(pointer,12);
    const tag=offset=>String.fromCharCode(...h.copyOut(pointer+offset,4));
    if(tag(0)!=='RIFF'||tag(8)!=='WAVE')fail('WAV','RIFF/WAVE required; compressed codecs are unavailable');
    const size=h.u32(pointer+4)+8;if(size<12||size>maximum||size>256*1024*1024)fail('WAV','invalid RIFF size');h.check(pointer,size);
    let format=null,payload=null;
    for(let offset=12;offset+8<=size;){
      const name=tag(offset),length=h.u32(pointer+offset+4),body=offset+8;
      if(body+length>size)fail('WAV','chunk exceeds RIFF bounds');
      if(name==='fmt '){if(length<16)fail('WAV','short fmt chunk');format={encoding:h.u16(pointer+body),channels:h.u16(pointer+body+2),rate:h.u32(pointer+body+4),block:h.u16(pointer+body+12),bits:h.u16(pointer+body+14)};}
      else if(name==='data'&&!payload)payload={data:pointer+body,length};
      offset=body+length+(length&1);
    }
    if(!format||!payload)fail('WAV','fmt/data chunks required');
    if(format.encoding!==1||![8,16].includes(format.bits)||![1,2].includes(format.channels))fail('WAV','only 8/16-bit mono/stereo integer PCM is implemented');
    if(format.rate<3000||format.rate>192000||format.block!==format.channels*format.bits/8||!payload.length||payload.length%format.block)fail('WAV','invalid PCM format/block alignment');
    return {...payload,...format,samples:payload.length/format.block};
  };
  const setWav=(id,pointer,length)=>{
    const wav=parseWav(pointer,length),s=sample(id);releasePlayback(s);Object.assign(s,{data:wav.data,length:wav.length,rate:wav.rate,bits:wav.bits,channels:wav.channels,offset:0,status:2,eosDelivered:false});return 1;
  };
  add('AIL_startup',0,()=>{if(!h.audio){state.error='PCM output unavailable';return 0;}state.started=true;return 1;});
  state.deliverCallback=deliver;state.watchPlayback=watch;
  add('AIL_shutdown',0,()=>{clearTimeout(service.timer);service.timer=null;state.closeSpatial();state.closeStreams();for(const id of [...state.samples]){releasePlayback(sample(id));h.handles.delete(id);}for(const id of state.drivers)h.handles.delete(id);state.samples.clear();state.drivers.clear();state.started=false;});
  add('AIL_last_error',0,()=>{if(!state.errorPointer)state.errorPointer=h.alloc(2048);h.writeString(state.errorPointer,state.error,2048);return state.errorPointer;});
  add('AIL_set_redist_directory',1,([pointer])=>{const previous=h.string(state.redist);state.redist=h.cstr(pointer);return previous;});
  add('AIL_mem_use_malloc',1,([callback])=>{const previous=state.malloc;state.malloc=callback;return previous;});
  add('AIL_mem_use_free',1,([callback])=>{const previous=state.free;state.free=callback;return previous;});
  add('AIL_mem_alloc_lock',1,([size])=>state.malloc?h.call(state.malloc,[size]):h.alloc(size));
  add('AIL_mem_free_lock',1,([pointer])=>{if(state.free)h.call(state.free,[pointer]);else h.free(pointer);});
  add('AIL_set_file_callbacks',4,args=>{state.fileCallbacks=args.slice();});
  add('AIL_open_digital_driver',4,([rate,bits,channels,flags])=>{
    if(!state.started)fail('AIL_open_digital_driver','AIL_startup has not succeeded');audio();
    if(![8,16].includes(bits)||![1,2].includes(channels)||rate<3000||rate>192000||flags!==0)fail('AIL_open_digital_driver','unsupported output format/flags');
    const id=h.handle({kind:'miles-driver',rate,bits,channels,volume:1});state.drivers.add(id);return id;
  });
  add('AIL_close_digital_driver',1,([id])=>{driver(id);state.closeStreams(id);for(const sampleId of [...state.samples])if(sample(sampleId).driver===id){releasePlayback(sample(sampleId));state.samples.delete(sampleId);h.handles.delete(sampleId);}state.drivers.delete(id);h.handles.delete(id);});
  add('AIL_set_digital_master_volume',2,([id,volume])=>{const d=driver(id);integer('Miles volume',volume,0,127);d.volume=volume/127;for(const sampleId of state.samples){const s=sample(sampleId);if(s.driver===id&&s.voice!==null)audio().setVolume(s.voice,s.volume/127*d.volume);}state.updateStreamVolume(id);});
  add('AIL_allocate_sample_handle',1,([dig])=>{driver(dig);const id=h.handle(sampleDefaults(dig));state.samples.add(id);return id;});
  add('AIL_release_sample_handle',1,([id])=>{releasePlayback(sample(id));state.samples.delete(id);h.handles.delete(id);});
  add('AIL_init_sample',1,([id])=>{const s=sample(id);releasePlayback(s);Object.assign(s,sampleDefaults(s.driver));});
  add('AIL_set_sample_type',3,([id,format,flags])=>{const s=sample(id);if(format>3||flags&~1)fail('AIL_set_sample_type','only standard unsigned 8-bit/signed 16-bit PCM supported');releasePlayback(s);s.bits=format&1?16:8;s.channels=format&2?2:1;s.status=2;s.offset=0;});
  add('AIL_set_sample_address',3,([id,pointer,length])=>{const s=sample(id);integer('sample bytes',length,1,256*1024*1024);h.check(pointer,length);if(length%(s.channels*s.bits/8))fail('AIL_set_sample_address','incomplete PCM frame');releasePlayback(s);Object.assign(s,{data:pointer,length,offset:0,status:2});});
  add('AIL_set_named_sample_file',5,([id,name,pointer,length,block])=>{if(block!==0&&block!==0xffffffff)fail('AIL_set_named_sample_file','VOC block selection unsupported');if(name)h.cstr(name);return setWav(id,pointer,length);});
  add('AIL_set_sample_file',3,([id,pointer,block])=>{if(block!==0&&block!==0xffffffff)fail('AIL_set_sample_file','VOC block selection unsupported');return setWav(id,pointer);});
  add('AIL_WAV_info',2,([pointer,info])=>{
    let wav;try{wav=parseWav(pointer);}catch(error){state.error=error.message;return 0;}
    h.check(info,36);[1,wav.data,wav.length,wav.rate,wav.bits,wav.channels,wav.samples,wav.block,pointer].forEach((value,i)=>h.w32(info+i*4,value));return 1;
  });
  add('AIL_file_type',2,([pointer,length])=>{try{parseWav(pointer,length);return 1;}catch(error){state.error=error.message;return 0;}});
  add('AIL_start_sample',1,([id])=>start(id));
  add('AIL_stop_sample',1,([id])=>{const s=sample(id);if(status(id,s)===4){s.offset=position(s);audio().pause(s.voice);s.status=8;}});
  add('AIL_resume_sample',1,([id])=>{const s=sample(id);if(status(id,s)===4)return;if(s.voice!==null&&s.status===8){audio().resume(s.voice);s.status=4;playing(s,s.offset);}else start(id,s.offset>=duration(s)?0:s.offset);});
  add('AIL_end_sample',1,([id])=>{const s=sample(id);const wasLive=status(id,s)!==2;releasePlayback(s);s.offset=duration(s);s.status=2;if(wasLive)ended(id,s);});
  add('AIL_sample_status',1,([id])=>status(id,sample(id)));
  add('AIL_set_sample_volume',2,([id,value])=>{integer('sample volume',value,0,127);const s=sample(id);s.volume=value;if(s.voice!==null)audio().setVolume(s.voice,value/127*driver(s.driver).volume);});
  add('AIL_sample_volume',1,([id])=>sample(id).volume);
  add('AIL_set_sample_pan',2,([id,value])=>{integer('sample pan',value,0,127);const s=sample(id);s.pan=value;if(s.voice!==null)audio().setPan(s.voice,panValue(value));});
  add('AIL_sample_pan',1,([id])=>sample(id).pan);
  add('AIL_set_sample_loop_count',2,([id,count])=>{if(count!==0&&count!==1)fail('AIL_set_sample_loop_count','finite repetition counts above one are unsupported');const s=sample(id),offset=position(s),playing=status(id,s)===4;s.loopCount=count;if(playing)start(id,offset);});
  add('AIL_sample_loop_count',1,([id])=>sample(id).loopCount);
  add('AIL_set_sample_playback_rate',2,([id,rate])=>{integer('sample rate',rate,3000,192000);const s=sample(id),fraction=duration(s)?position(s)/duration(s):0,playing=status(id,s)===4;s.rate=rate;s.offset=fraction*duration(s);if(playing)start(id,s.offset);else releasePlayback(s);});
  add('AIL_sample_playback_rate',1,([id])=>sample(id).rate);
  add('AIL_sample_position',1,([id])=>{const s=sample(id);return Math.floor(position(s)*s.rate)*s.channels*s.bits/8;});
  const seek=(id,seconds)=>{const s=sample(id),playing=status(id,s)===4;s.offset=Math.min(duration(s),seconds);if(playing)start(id,s.offset);else{releasePlayback(s);s.status=8;}};
  add('AIL_set_sample_position',2,([id,offset])=>{const s=sample(id);seek(id,offset/(s.rate*s.channels*s.bits/8));});
  add('AIL_set_sample_ms_position',2,([id,ms])=>seek(id,ms/1000));
  add('AIL_sample_ms_position',3,([id,total,current])=>{const s=sample(id);if(total)h.w32(total,Math.floor(duration(s)*1000));if(current)h.w32(current,Math.floor(position(s)*1000));});
  add('AIL_set_sample_user_data',3,([id,index,value])=>{integer('sample user data index',index,0,7);sample(id).userData[index]=value;});
  add('AIL_sample_user_data',2,([id,index])=>{integer('sample user data index',index,0,7);return sample(id).userData[index];});
  add('AIL_register_EOS_callback',2,([id,callback])=>{const s=sample(id),previous=s.eos;s.eos=callback;if(callback&&s.status===4)watch();return previous;});
  // Driver discovery can fail normally. Do not manufacture a working MIDI
  // synthesizer or let the absence of a MIDI device disable digital output.
  add('AIL_open_XMIDI_driver',1,([flags])=>{state.error=flags&~1?'Invalid XMIDI driver flags':'No XMIDI synthesis driver is available in this browser runtime';return 0;});
  installMilesStreams(h,{state,add,audio,driver,fail,integer,panValue});
  installMilesSpatial(h,{state,add,audio,sample,sampleDefaults,releasePlayback,fail,integer,f32});
  // Discovering no optional provider is a genuine unavailable result. Invoking
  // an unsupported codec/provider is an explicit fault at its import thunk.
  for(const [name,count] of [
    ['AIL_DLS_open',7],['AIL_DLS_load_memory',3],
    ['AIL_decompress_ASI',6],
    ['AIL_decompress_ADPCM',3],['AIL_MIDI_to_XMI',5],['AIL_extract_DLS',7],['AIL_find_DLS',6],
  ])add(name,count,()=>fail(name,'compressed sample codecs and XMIDI/DLS are not implemented'));
}
