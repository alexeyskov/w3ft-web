import {GuestFault} from './host.mjs';

// COM ABI definitions are the published DirectShow interfaces (IUnknown and
// IDispatch method ordering), not copied implementations of a native codec.
const E_NOINTERFACE=0x80004002,E_POINTER=0x80004003,E_ABORT=0x80004004,E_INVALIDARG=0x80070057;
const baseGuid=part=>`56a868${part}-0ad4-11ce-b03a-0020af0ba770`;
const identities=new Map([
  ['00000000-0000-0000-c000-000000000046','IGraphBuilder'],[baseGuid('a9'),'IGraphBuilder'],
  [baseGuid('9f'),'IGraphBuilder'],[baseGuid('b1'),'IMediaControl'],[baseGuid('b2'),'IMediaPosition'],
  [baseGuid('b3'),'IBasicAudio'],[baseGuid('b4'),'IVideoWindow'],[baseGuid('b5'),'IBasicVideo'],
  ['329bb360-f6ea-11d1-9038-00a0c9697298','IBasicVideo2'],[baseGuid('b6'),'IMediaEventEx'],[baseGuid('c0'),'IMediaEventEx'],
  ['36b73880-c2c8-11cf-8b46-00805f6cef60','IMediaSeeking'],
]);
export function readGUID(h,p){
  const hex=(v,n)=>v.toString(16).padStart(n,'0');h.check(p,16);
  return `${hex(h.u32(p),8)}-${hex(h.u16(p+4),4)}-${hex(h.u16(p+6),4)}-${hex(h.u8(p+8),2)}${hex(h.u8(p+9),2)}-${Array.from(h.copyOut(p+10,6),v=>hex(v,2)).join('')}`;
}

export function createFilterGraph(h,classId,outer,iid,output){
  if(!['e436ebb3-524f-11ce-9f53-0020af0ba770','e436ebb8-524f-11ce-9f53-0020af0ba770'].includes(readGUID(h,classId)))return 0x80040154;
  if(outer)return 0x80040110;
  if(!h.video)return 0x80040154;
  const graph={refs:0,interfaces:new Map(),events:[],loaded:false,state:0,owner:0,drain:0,visible:false,autoShow:true,style:0,styleEx:0,
    rect:[0,0,0,0],notifyWindow:0,notifyMessage:0,notifyData:0,notifyFlags:0,volume:0,balance:0,rate:1,stopTime:0,preroll:0};
  graph.id=h.video.create((event,error)=>{
    if(event==='ended')graph.events.push([1,0,0]);
    else if(event==='error'){graph.events.push([3,0x80004005,0]);h.log(`Video playback: ${error}`);}
    else return;
    graph.state=0;if(graph.eventHandle)h.handles.get(graph.eventHandle).signal=true;
    if(graph.notifyWindow&&graph.notifyMessage&&!graph.notifyFlags)h.postWindowMessage?.(graph.notifyWindow,graph.notifyMessage,0,graph.notifyData);
    h.threadServices.notify();
  });
  const output32=(p,value)=>{if(!p)return E_POINTER;h.w32(p,value);return 0;};
  const output64=(p,value)=>{if(!p)return E_POINTER;h.view.setBigInt64(h.check(p,8),BigInt(Math.round(value*1e7)),true);return 0;};
  const outputDouble=(p,value)=>{if(!p)return E_POINTER;h.view.setFloat64(h.check(p,8),value,true);return 0;};
  const double=(low,high)=>{const value=new DataView(new ArrayBuffer(8));value.setUint32(0,low,true);value.setUint32(4,high,true);return value.getFloat64(0,true);};
  const position=()=>graph.loaded?h.video.request(graph.id,'status').position:0;
  const configure=()=>{
    if(!graph.loaded)return;
    const owner=h.handles.get(graph.owner),viewport=[owner?.width||h.graphics?.canvas?.width||640,owner?.height||h.graphics?.canvas?.height||480];
    const rect=graph.rect[2]&&graph.rect[3]?graph.rect:[0,0,...viewport];
    h.video.request(graph.id,'configure',{visible:graph.visible,rect,viewport});
  };
  const load=path=>{
    graph.metadata=h.video.load(graph.id,path);graph.loaded=true;graph.stopTime=graph.metadata.duration;
    graph.source=[0,0,graph.metadata.width,graph.metadata.height];configure();return 0;
  };
  const media=(method,state)=>{
    if(!graph.loaded)return 0x80040227;
    h.video.request(graph.id,method,{autoShow:graph.autoShow});graph.state=state;
    if(method==='play'&&graph.autoShow)graph.visible=true;return 0;
  };
  const query=(guid,output)=>{
    if(!output)return E_POINTER;h.w32(output,0);const name=identities.get(guid);
    if(!name){h.log(`DirectShow interface unavailable: ${guid}`);return E_NOINTERFACE;}
    h.w32(output,makeInterface(name));graph.refs++;return 0;
  };
  const release=()=>{
    if(graph.refs>0)graph.refs--;
    if(!graph.refs){h.video.release(graph.id);for(const item of graph.interfaces.values()){h.free(h.u32(item));h.free(item);}graph.interfaces.clear();if(graph.eventHandle)h.handles.delete(graph.eventHandle);}
    return graph.refs;
  };
  const unknown=[['QueryInterface',3,([self,guid,out])=>query(readGUID(h,guid),out)],['AddRef',1,()=>++graph.refs],['Release',1,release]];
  const dispatch=[...unknown,['GetTypeInfoCount',2,([self,out])=>output32(out,0)],['GetTypeInfo',4,()=>0x80004001],['GetIDsOfNames',6,()=>0x80020006],['Invoke',9,()=>0x80020003]];
  const unimplemented=(name,count)=>[name,count,()=>{throw new GuestFault('Unsupported DirectShow method',{method:name});}];
  const rectGet=(values,args)=>{for(let i=0;i<4;i++)if(!args[i])return E_POINTER;args.forEach((p,i)=>h.w32(p,values[i]));return 0;};
  const videoSize=(width,height)=>{if(!graph.loaded)return 0x80040227;if(!width||!height)return E_POINTER;h.w32(width,graph.metadata.width);h.w32(height,graph.metadata.height);return 0;};
  const eventGet=([self,code,p1,p2,timeout])=>{
    if(!code||!p1||!p2)return E_POINTER;
    if(!graph.events.length){if(timeout)throw new GuestFault('Blocking DirectShow event wait is not implemented');return E_ABORT;}
    const event=graph.events.shift();[code,p1,p2].forEach((p,i)=>h.w32(p,event[i]));
    if(graph.eventHandle&&!graph.events.length)h.handles.get(graph.eventHandle).signal=false;return 0;
  };
  function methods(name){
    if(name==='IGraphBuilder')return [...unknown,
      ...[['AddFilter',3],['RemoveFilter',2],['EnumFilters',2],['FindFilterByName',3],['ConnectDirect',4],['Reconnect',2],['Disconnect',2]].map(([n,c])=>unimplemented(n,c)),
      ['SetDefaultSyncSource',1,()=>0],unimplemented('Connect',3),unimplemented('Render',2),
      ['RenderFile',3,([self,path,playlist])=>playlist?E_INVALIDARG:load(h.wide(path))],unimplemented('AddSourceFilter',4),
      unimplemented('SetLogFile',2),['Abort',1,()=>media('stop',0)],['ShouldOperationContinue',1,()=>0]];
    if(name==='IMediaControl')return [...dispatch,
      ['Run',1,()=>media('play',2)],['Pause',1,()=>media('pause',1)],['Stop',1,()=>media('stop',0)],
      ['GetState',3,([self,timeout,out])=>output32(out,graph.state)],['RenderFile',2,([self,path])=>load(h.wide(path))],
      unimplemented('AddSourceFilter',3),unimplemented('get_FilterCollection',2),unimplemented('get_RegFilterCollection',2),['StopWhenReady',1,()=>media('stop',0)]];
    if(name==='IMediaEventEx')return [...dispatch,
      ['GetEventHandle',2,([self,out])=>{graph.eventHandle??=h.handle({kind:'event',manual:true,signal:!!graph.events.length});return output32(out,graph.eventHandle);}],
      ['GetEvent',5,eventGet],unimplemented('WaitForCompletion',3),unimplemented('CancelDefaultHandling',2),unimplemented('RestoreDefaultHandling',2),
      ['FreeEventParams',4,()=>0],['SetNotifyWindow',4,([self,window,message,data])=>{graph.notifyWindow=window;graph.notifyMessage=message;graph.notifyData=data;return 0;}],
      ['SetNotifyFlags',2,([self,flags])=>{if(flags&~1)return E_INVALIDARG;graph.notifyFlags=flags;return 0;}],['GetNotifyFlags',2,([self,out])=>output32(out,graph.notifyFlags)]];
    if(name==='IMediaPosition')return [...dispatch,
      ['get_Duration',2,([self,out])=>outputDouble(out,graph.metadata?.duration||0)],
      ['put_CurrentPosition',3,([self,lo,hi])=>{h.video.request(graph.id,'seek',{position:double(lo,hi)});return 0;}],
      ['get_CurrentPosition',2,([self,out])=>outputDouble(out,position())],['get_StopTime',2,([self,out])=>outputDouble(out,graph.stopTime)],unimplemented('put_StopTime',3),
      ['get_PrerollTime',2,([self,out])=>outputDouble(out,0)],unimplemented('put_PrerollTime',3),
      ['put_Rate',3,([self,lo,hi])=>{const rate=double(lo,hi);if(rate<=0)return E_INVALIDARG;h.video.request(graph.id,'rate',{rate});graph.rate=rate;return 0;}],
      ['get_Rate',2,([self,out])=>outputDouble(out,graph.rate)],['CanSeekForward',2,([self,out])=>output32(out,0xffffffff)],['CanSeekBackward',2,([self,out])=>output32(out,0xffffffff)]];
    if(name==='IBasicAudio')return [...dispatch,
      ['put_Volume',2,([self,value])=>{value|=0;if(value>0||value< -10000)return E_INVALIDARG;h.video.request(graph.id,'volume',{volume:value===-10000?0:Math.pow(10,value/2000)});graph.volume=value;return 0;}],
      ['get_Volume',2,([self,out])=>output32(out,graph.volume)],['put_Balance',2,([self,value])=>{if(value)return 0x80004001;graph.balance=0;return 0;}],['get_Balance',2,([self,out])=>output32(out,graph.balance)]];
    if(name==='IVideoWindow'){
      const table=[...dispatch];
      for(const[property,field]of[['Caption','caption'],['WindowStyle','style'],['WindowStyleEx','styleEx'],['AutoShow','autoShow'],['WindowState','windowState'],['BackgroundPalette','palette'],['Visible','visible'],['Left','left'],['Width','width'],['Top','top'],['Height','height'],['Owner','owner'],['MessageDrain','drain']]){
        table.push(['put_'+property,2,([self,value])=>{
          graph[field]=field==='caption'?h.wide(value):['visible','autoShow'].includes(field)?!!value:value;
          const index={left:0,top:1,width:2,height:3}[field];if(index!==undefined)graph.rect[index]=value|0;
          configure();return 0;
        }]);
        table.push(['get_'+property,2,([self,out])=>field==='caption'?0x80004001:output32(out,graph[field]||0)]);
      }
      return [...table,['get_BorderColor',2,([self,out])=>output32(out,graph.border||0)],['put_BorderColor',2,([self,value])=>{if(value)return 0x80004001;graph.border=value;return 0;}],
        ['get_FullScreenMode',2,([self,out])=>output32(out,graph.fullscreen?0xffffffff:0)],['put_FullScreenMode',2,([self,value])=>{graph.fullscreen=!!value;configure();return 0;}],
        ['SetWindowForeground',2,()=>{if(graph.owner)h.handlers.get('user32.dll!SetForegroundWindow').fn([graph.owner]);return 0;}],
        ['NotifyOwnerMessage',5,()=>{configure();return 0;}],['SetWindowPosition',5,([self,...rect])=>{graph.rect=rect.map(v=>v|0);configure();return 0;}],
        ['GetWindowPosition',5,([self,...out])=>rectGet(graph.rect,out)],['GetMinIdealImageSize',3,([self,w,h])=>videoSize(w,h)],['GetMaxIdealImageSize',3,([self,w,h])=>videoSize(w,h)],
        ['GetRestorePosition',5,([self,...out])=>rectGet(graph.rect,out)],['HideCursor',2,([self,hidden])=>{graph.cursorHidden=!!hidden;return 0;}],['IsCursorHidden',2,([self,out])=>output32(out,graph.cursorHidden?0xffffffff:0)]];
    }
    if(name==='IBasicVideo'||name==='IBasicVideo2'){
      const table=[...dispatch,['get_AvgTimePerFrame',2,([self,out])=>outputDouble(out,graph.metadata?.frameRate?1/graph.metadata.frameRate:0)],['get_BitRate',2,([self,out])=>output32(out,0)],['get_BitErrorRate',2,([self,out])=>output32(out,0)],
        ['get_VideoWidth',2,([self,out])=>output32(out,graph.metadata?.width||0)],['get_VideoHeight',2,([self,out])=>output32(out,graph.metadata?.height||0)]];
      for(const[source,field]of[['Source','source'],['Destination','rect']])for(const[property,index]of[['Left',0],['Width',2],['Top',1],['Height',3]]){
        table.push([`put_${source}${property}`,2,([self,value])=>{if(field==='source')return 0x80004001;graph[field][index]=value|0;configure();return 0;}]);
        table.push([`get_${source}${property}`,2,([self,out])=>output32(out,graph[field]?.[index]||0)]);
      }
      table.push(unimplemented('SetSourcePosition',5),['GetSourcePosition',5,([self,...out])=>rectGet(graph.source,out)],['SetDefaultSourcePosition',1,()=>0],
        ['SetDestinationPosition',5,([self,...rect])=>{graph.rect=rect.map(v=>v|0);configure();return 0;}],['GetDestinationPosition',5,([self,...out])=>rectGet(graph.rect,out)],
        ['SetDefaultDestinationPosition',1,()=>{graph.rect=[0,0,0,0];configure();return 0;}],['GetVideoSize',3,([self,w,h])=>videoSize(w,h)],
        unimplemented('GetVideoPaletteEntries',5),unimplemented('GetCurrentImage',3),['IsUsingDefaultSource',1,()=>0],['IsUsingDefaultDestination',1,()=>graph.rect[2]?1:0]);
      if(name==='IBasicVideo2')table.push(['GetPreferredAspectRatio',3,([self,w,h])=>videoSize(w,h)]);return table;
    }
    if(name==='IMediaSeeking')return [...unknown,
      ['GetCapabilities',2,([self,out])=>output32(out,0x38)],['CheckCapabilities',2,([self,out])=>{if(!out)return E_POINTER;const requested=h.u32(out),supported=requested&0x38;h.w32(out,supported);return requested===supported?0:supported?1:0x80004005;}],
      ...['IsFormatSupported','QueryPreferredFormat','GetTimeFormat','IsUsingTimeFormat','SetTimeFormat'].map(n=>unimplemented(n,2)),
      ['GetDuration',2,([self,out])=>output64(out,graph.metadata?.duration||0)],['GetStopPosition',2,([self,out])=>output64(out,graph.stopTime)],['GetCurrentPosition',2,([self,out])=>output64(out,position())],
      unimplemented('ConvertTimeFormat',6),unimplemented('SetPositions',5),['GetPositions',3,([self,current,stop])=>output64(current,position())||output64(stop,graph.stopTime)],
      ['GetAvailable',3,([self,start,end])=>output64(start,0)||output64(end,graph.metadata?.duration||0)],
      ['SetRate',3,([self,lo,hi])=>{const rate=double(lo,hi);if(rate<=0)return E_INVALIDARG;h.video.request(graph.id,'rate',{rate});graph.rate=rate;return 0;}],
      ['GetRate',2,([self,out])=>outputDouble(out,graph.rate)],['GetPreroll',2,([self,out])=>output64(out,0)]];
    throw new GuestFault('Unknown DirectShow interface',{name});
  }
  function makeInterface(name){
    if(graph.interfaces.has(name))return graph.interfaces.get(name);
    const entries=methods(name),vtable=h.alloc(entries.length*4),pointer=h.alloc(4);h.w32(pointer,vtable);graph.interfaces.set(name,pointer);
    entries.forEach(([method,count,fn],index)=>{
      const symbol=`graph${graph.id}.${name}.${method}`;
      h.add('quartz.dll',symbol,count,args=>{if(args[0]!==pointer)throw new GuestFault('Invalid DirectShow this pointer',{name,method});return fn(args);});
      h.w32(vtable+index*4,h.resolve('quartz.dll',symbol));
    });return pointer;
  }
  const result=query(readGUID(h,iid),output);if(result)h.video.release(graph.id);return result;
}
