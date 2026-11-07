import {WSA,WSAError} from './winsock.mjs';

// Warcraft's mswsock/ws2_32 path uses IOCP, not APC completion routines.
// https://learn.microsoft.com/en-us/windows/win32/api/mswsock/nf-mswsock-acceptex
// https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-wsarecv
export function installOverlappedWinsock(h,{add,network,checked,wsafail,ipBytes}) {
  const PENDING=0x103,IO_PENDING=997,ABORTED=995,INFINITE=0xffffffff;
  const statuses=new Map([[ABORTED,0xc0000120],[WSA.ECONNRESET,0xc000020d],
    [WSA.ENETDOWN,0xc00000c4],[WSA.ENOBUFS,0xc000009a],[WSA.ESHUTDOWN,0xc00000b0]]);
  const active=new Set();
  const ws2=(name,count,fn,options={})=>add(null,name,count,fn,{dlls:['ws2_32.dll'],...options});
  const ms=(name,count,fn,options={})=>add(null,name,count,fn,{dlls:['mswsock.dll'],...options});
  const buffers=(pointer,count)=>{
    if(!count||count>1024)wsafail(WSA.EINVAL,'Invalid WSABUF count');checked(pointer,count*8);
    let length=0;const list=[];
    for(let i=0;i<count;i++){
      const size=h.u32(pointer+i*8),address=h.u32(pointer+i*8+4);length+=size;
      if(length>16*1024*1024)wsafail(WSA.EMSGSIZE,'Socket transfer exceeds 16 MiB');
      if(size)checked(address,size);list.push({address,size});
    }
    // WSABUF itself can be on the caller's stack. Capture its values now.
    return {list,length};
  };
  const scatter=(list,data)=>{let offset=0;for(const {address,size} of list){const take=Math.min(size,data.length-offset);if(take)h.copyIn(address,data.subarray(offset,offset+take));offset+=take;}};
  const gather=({list,length})=>{const data=new Uint8Array(length);let offset=0;for(const {address,size} of list){if(size)data.set(h.copyOut(address,size),offset);offset+=size;}return data;};
  const address=(pointer,value)=>{h.zero(pointer,16);h.w16(pointer,2);h.w8(pointer+2,value.port>>>8);h.w8(pointer+3,value.port&255);ipBytes(value.address).forEach((v,i)=>h.w8(pointer+4+i,v));};
  const overlappedInfo=overlapped=>{
    checked(overlapped,20);if(active.has(overlapped))wsafail(WSA.EINVAL,'OVERLAPPED is already in use');
    const eventValue=h.u32(overlapped+16),eventId=(eventValue&~1)>>>0,event=eventId?h.getHandle(eventId,'event'):null;
    if(eventId&&!event)wsafail(6,'Invalid OVERLAPPED event');
    return {overlapped,event,eventValue};
  };
  const complete=(socket,op,{bytes=0,error=0})=>{
    active.delete(op.overlapped);
    const status=error?(statuses.get(error)||0xc0000001):0,queued=socket.port&&!(op.eventValue&1);
    h.w32(op.overlapped,queued?PENDING:status);h.w32(op.overlapped+4,queued?0:bytes);
    if(op.event)op.event.signal=true;
    if(queued)socket.port.queue.push({bytes,key:socket.completionKey,overlapped:op.overlapped,status,error});
    h.threadServices.notify();
  };
  const io=(socket,overlapped,attempt,{bytesPointer=0,success=0,poll=false,onFinish=()=>{}}={})=>{
    if(bytesPointer)checked(bytesPointer,4);
    const op=overlapped?overlappedInfo(overlapped):null,net=network();
    const check=()=>{
      if(net.sockets.get(socket.fd)!==socket)return {error:ABORTED};
      if(net.disconnected)return {error:WSA.ENETDOWN};
      try{return {bytes:attempt()};}
      catch(error){if(!(error instanceof WSAError))throw error;if(error.code===WSA.EWOULDBLOCK)return null;return {error:error.code};}
    };
    const initial=check();
    if(initial?.error){onFinish();wsafail(initial.error,'Socket operation failed');}
    if(!op){if(!initial)wsafail(WSA.EWOULDBLOCK,'Socket operation would block');if(bytesPointer)h.w32(bytesPointer,initial.bytes);onFinish();return success;}
    if(!initial&&!h.scheduler){onFinish();wsafail(WSA.EOPNOTSUPP,'Overlapped sockets require the guest scheduler');}
    active.add(overlapped);h.w32(overlapped,PENDING);h.w32(overlapped+4,0);if(op.event)op.event.signal=false;
    if(initial){if(bytesPointer)h.w32(bytesPointer,initial.bytes);onFinish();complete(socket,op,initial);return success;}
    const context=h.threadContext,cpu=h.currentCPU;
    // Pending outputs may point to a stack frame which disappears on return.
    // Only buffers and OVERLAPPED remain owned by this asynchronous operation.
    const pending=h.threadServices.until(check,INFINITE,()=>({error:ABORTED}));
    const timer=poll?setInterval(()=>h.threadServices.notify(),10):null;
    Promise.resolve(pending).then(result=>{onFinish();complete(socket,op,result);}).catch(error=>{
      active.delete(overlapped);onFinish();
      if(!h.scheduler?.stopped){if(h.scheduler?.fail)h.scheduler.fail(error,{id:context.id,cpu});else queueMicrotask(()=>{throw error;});}
    }).finally(()=>clearInterval(timer));
    wsafail(IO_PENDING,'Overlapped socket operation pending');
  };
  ms('AcceptEx',8,([listenerFd,targetFd,output,receiveLength,localLength,remoteLength,bytesPointer,overlapped])=>{
    const net=network(),listener=net._get(listenerFd),target=net._get(targetFd);
    if(listener.state!=='listening'||target.type!=='tcp'||target.state!=='new'||target.acceptPending)wsafail(WSA.EINVAL,'Invalid AcceptEx sockets');
    if(localLength<32||remoteLength<32||receiveLength>16*1024*1024)wsafail(WSA.EINVAL,'Invalid AcceptEx buffer sizes');
    checked(output,receiveLength+localLength+remoteLength);overlappedInfo(overlapped);if(bytesPointer)checked(bytesPointer,4);
    let accepted=false;target.acceptPending=true;
    return io(listener,overlapped,()=>{
      if(net.sockets.get(targetFd)!==target)wsafail(ABORTED,'Accept socket closed');
      if(!accepted){
        net.acceptInto(listenerFd,targetFd);accepted=true;
        const local=net.getsockname(targetFd);if(local.address==='0.0.0.0')local.address=net.address;
        address(output+receiveLength+16,local);
        address(output+receiveLength+localLength+16,net.getpeername(targetFd));
      }
      if(!receiveLength)return 0;
      const data=net.recv(targetFd,receiveLength);h.copyIn(output,data);return data.length;
    },{bytesPointer,success:1,onFinish:()=>{target.acceptPending=false;}});
  },{failure:0});
  ms('GetAcceptExSockaddrs',8,([output,receiveLength,localLength,remoteLength,local,localSize,remote,remoteSize])=>{
    if(localLength<32||remoteLength<32)wsafail(WSA.EINVAL,'Invalid AcceptEx address sizes');checked(output,receiveLength+localLength+remoteLength);
    for(const pointer of [local,localSize,remote,remoteSize])checked(pointer,4);
    h.w32(local,output+receiveLength+16);h.w32(localSize,16);h.w32(remote,output+receiveLength+localLength+16);h.w32(remoteSize,16);
  });
  ws2('WSARecv',7,([fd,pointer,count,bytesPointer,flagsPointer,overlapped,routine])=>{
    if(routine)wsafail(WSA.EOPNOTSUPP,'APC socket completion routines are unavailable');
    checked(flagsPointer,4);const flags=h.u32(flagsPointer),net=network(),socket=net._get(fd),{list,length}=buffers(pointer,count);
    if(flags!==0&&flags!==2)wsafail(WSA.EOPNOTSUPP,'Unsupported WSARecv flags');
    const result=io(socket,overlapped,()=>{const data=net.recv(fd,length,flags);scatter(list,data);return data.length;},{bytesPointer});
    h.w32(flagsPointer,0);return result;
  });
  ws2('WSASend',7,([fd,pointer,count,bytesPointer,flags,overlapped,routine])=>{
    if(routine||flags)wsafail(WSA.EOPNOTSUPP,'Unsupported WSASend flags or APC routine');
    const net=network(),socket=net._get(fd),data=gather(buffers(pointer,count));
    return io(socket,overlapped,()=>net.send(fd,data),{bytesPointer,poll:true});
  });
  ws2('WSAGetOverlappedResult',5,([fd,overlapped,bytesPointer,wait,flagsPointer])=>{
    network()._get(fd);checked(overlapped,20);checked(bytesPointer,4);checked(flagsPointer,4);
    const context=h.threadContext;
    return h.threadServices.until(()=>{
      const status=h.u32(overlapped);if(status===PENDING)return null;
      h.w32(bytesPointer,h.u32(overlapped+4));h.w32(flagsPointer,0);
      if(status){context.wsaError=[...statuses].find(([,value])=>value===status)?.[0]||WSA.EINVAL;return 0;}return 1;
    },wait?INFINITE:0,()=>{context.wsaError=996;return 0;});
  },{failure:0});
  ws2('WSAIoctl',9,([fd,code,input,inputLength,output,outputLength,bytesPointer,overlapped,routine])=>{
    if(routine)wsafail(WSA.EOPNOTSUPP,'APC socket completion routines are unavailable');
    const socket=network()._get(fd);if(inputLength)checked(input,inputLength);if(outputLength)checked(output,outputLength);
    return io(socket,overlapped,()=>{
      if(code===0x9800000c){ // SIO_UDP_CONNRESET: disable ICMP port-unreachable reports.
        if(socket.type!=='udp'||inputLength!==4)wsafail(WSA.EINVAL,'Invalid UDP reset ioctl');
        if(h.u32(input))wsafail(WSA.EOPNOTSUPP,'Virtual UDP has no ICMP error reporting');
        return 0;
      }
      if(code===0xc8000006){ // SIO_GET_EXTENSION_FUNCTION_POINTER
        if(inputLength!==16||outputLength<4)wsafail(10014,'Extension function buffer too short');
        const guid=Array.from(h.copyOut(input,16),v=>v.toString(16).padStart(2,'0')).join('');
        const name={'f17d36b5accbcf1195ca00805f48a192':'AcceptEx','f27d36b5accbcf1195ca00805f48a192':'GetAcceptExSockaddrs'}[guid];
        if(!name)wsafail(WSA.EOPNOTSUPP,'Unknown Winsock extension GUID');
        h.w32(output,h.resolve('mswsock.dll',name,0));return 4;
      }
      if(code===0x4004667f){if(outputLength<4)wsafail(10014,'FIONREAD buffer too short');h.w32(output,socket.type==='udp'?(socket.datagrams[0]?.data.length||0):socket.queuedBytes);return 4;}
      if(code===0x8004667e){if(inputLength<4)wsafail(10014,'FIONBIO buffer too short');if(!h.u32(input))wsafail(WSA.EOPNOTSUPP,'Blocking socket mode unavailable');return 0;}
      wsafail(WSA.EOPNOTSUPP,`Unsupported WSAIoctl 0x${code.toString(16)}`);
    },{bytesPointer});
  });
}
