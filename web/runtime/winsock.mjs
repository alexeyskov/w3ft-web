// Virtual LAN sockets over the room-scoped, reliable FrameTransport.
// This protocol does not expose Internet TCP/UDP or implement Battle.net.
export const WSA = Object.freeze({EWOULDBLOCK:10035,EINPROGRESS:10036,EALREADY:10037,
  ENOTSOCK:10038,EDESTADDRREQ:10039,EMSGSIZE:10040,EPROTOTYPE:10041,
  EOPNOTSUPP:10045,EAFNOSUPPORT:10047,EADDRINUSE:10048,EADDRNOTAVAIL:10049,
  ENETDOWN:10050,ENETUNREACH:10051,ECONNRESET:10054,ENOBUFS:10055,
  EISCONN:10056,ENOTCONN:10057,ESHUTDOWN:10058,ETIMEDOUT:10060,ECONNREFUSED:10061,EINVAL:10022});

export class WSAError extends Error {
  constructor(code, message) { super(message); this.name='WSAError'; this.code=code; }
}
const fail = (code,message) => { throw new WSAError(code,message); };
const HEADER=16, MAX_PAYLOAD=65535-HEADER, MAGIC=0x31535743;
const PACKET={UDP:1,SYN:2,SYN_ACK:3,ACK:4,DATA:5,FIN:6,RST:7};
const bytes = value => {
  if (!(value instanceof Uint8Array)) fail(WSA.EINVAL,'Socket data must be Uint8Array');
  return value;
};

// One relay room is one virtual LAN 10.77.0.0/24: peer IDs 1–254 (the server
// decides the room size, 200 for site lobbies), .255 is the broadcast address.
export const MAX_PEER=254;
export function peerAddress(peer) {
  if (!Number.isInteger(peer)||peer<1||peer>MAX_PEER) fail(WSA.EADDRNOTAVAIL,'Invalid virtual peer');
  return `10.77.0.${peer}`;
}
export function addressPeer(address) {
  if (address==='255.255.255.255'||address==='10.77.0.255') return 0;
  const match=/^10\.77\.0\.(\d+)$/.exec(address);
  if (!match||Number(match[1])<1||Number(match[1])>MAX_PEER) fail(WSA.ENETUNREACH,`Address outside virtual LAN: ${address}`);
  return Number(match[1]);
}

export class VirtualWinsock extends EventTarget {
  constructor(transport,{maxQueuedBytes=4*1024*1024,maxDatagrams=4096,connectTimeout=10000,now=Date.now}={}) {
    super();
    if (!transport||typeof transport.send!=='function'||!transport.peerId) throw new Error('Connected FrameTransport required');
    if(!Number.isInteger(maxQueuedBytes)||maxQueuedBytes<1||!Number.isInteger(maxDatagrams)||maxDatagrams<1)throw new Error('Positive integer queue limits required');
    this.transport=transport; this.address=peerAddress(transport.peerId);
    this.maxQueuedBytes=maxQueuedBytes; this.maxDatagrams=maxDatagrams;
    if(!Number.isFinite(connectTimeout)||connectTimeout<=0||typeof now!=='function')throw new Error('Valid connection timeout and clock required');
    this.connectTimeout=connectTimeout;this.now=now;
    // SOCKET values must not alias the broker's small Win32 HANDLE values.
    this.sockets=new Map(); this.nextFd=0x10000000; this.nextPort=49152; this.nextConnection=globalThis.crypto?.getRandomValues(new Uint32Array(1))[0]||1;
    this.lastError=0; this.disconnected=false; this.peers=null;
    this.onPacket=event=>this._receive(event.detail);
    this.onDisconnect=()=>{this.disconnected=true;for(const socket of this.sockets.values()) if(socket.type==='tcp') socket.error=WSA.ENETDOWN;this.changed();};
    this.onPeers=event=>{
      const peers=new Set(event.detail); this.peers=peers;
      for(const socket of this.sockets.values()) if(socket.remotePeer&&!peers.has(socket.remotePeer)&&socket.type==='tcp') socket.error=WSA.ECONNRESET;
      this.changed();
    };
    transport.addEventListener('packet',this.onPacket);
    transport.addEventListener('disconnect',this.onDisconnect);
    transport.addEventListener('peers',this.onPeers);
  }
  _get(fd) {
    this.poll();
    const socket=this.sockets.get(fd);
    if(!socket) fail(WSA.ENOTSOCK,`Unknown virtual socket ${fd}`);
    return socket;
  }
  _network() { if(this.disconnected) fail(WSA.ENETDOWN,'Virtual LAN disconnected'); }
  poll(){const now=this.now();for(const socket of this.sockets.values())if(socket.deadline&&now>=socket.deadline){socket.deadline=0;if(socket.state==='connecting'){socket.state='failed';socket.error=WSA.ETIMEDOUT;}else if(socket.state==='syn-received')this.sockets.delete(socket.fd);}}
  _backpressured(){return (this.transport.socket?.bufferedAmount??0)>4*1024*1024;}
  socket(type='udp') {
    if(type===2) type='udp'; else if(type===1) type='tcp';
    if(type!=='udp'&&type!=='tcp') fail(WSA.EPROTOTYPE,'Only TCP and UDP virtual sockets are supported');
    const fd=this.nextFd++;
    this.sockets.set(fd,{fd,type,state:'new',localPort:0,localAddress:'0.0.0.0',remotePeer:null,
      remotePort:0,connection:0,chunks:[],datagrams:[],queuedBytes:0,pending:[],backlog:0,
      remoteFin:false,readClosed:false,writeClosed:false,error:0,parent:null,broadcast:false,reuseAddress:false,keepAlive:false});
    return fd;
  }
  _portFree(type,port) {
    return ![...this.sockets.values()].some(s=>s.type===type&&s.localPort===port&&s.parent===null);
  }
  _bindEphemeral(socket) {
    for(let i=0;i<16384;i++) {
      const port=this.nextPort++; if(this.nextPort>65535)this.nextPort=49152;
      if(this._portFree(socket.type,port)){socket.localPort=port;socket.state='bound';return;}
    }
    fail(WSA.EADDRINUSE,'No ephemeral ports available');
  }
  bind(fd,{address='0.0.0.0',port=0}={}) {
    const socket=this._get(fd);
    if(socket.localPort) fail(WSA.EINVAL,'Socket is already bound');
    if(address!=='0.0.0.0'&&address!==this.address) fail(WSA.EADDRNOTAVAIL,'Cannot bind another virtual peer address');
    if(!Number.isInteger(port)||port<0||port>65535) fail(WSA.EINVAL,'Invalid port');
    if(port===0)this._bindEphemeral(socket);
    else {if(!socket.reuseAddress&&!this._portFree(socket.type,port)) fail(WSA.EADDRINUSE,'Port already in use');socket.localPort=port;socket.state='bound';}
    socket.localAddress=address; return 0;
  }
  setsockopt(fd,option,value) {
    const socket=this._get(fd);
    if(option==='SO_BROADCAST'){socket.broadcast=Boolean(value);return 0;}
    if(option==='SO_REUSEADDR'){socket.reuseAddress=Boolean(value);return 0;}
    if(option==='SO_KEEPALIVE'){
      if(socket.type!=='tcp')fail(WSA.EOPNOTSUPP,'Keepalive requires TCP');
      // The shared room transport already probes peers (server heartbeat 20s).
      // Its disconnect/peers events fail affected streams and wake pending I/O.
      socket.keepAlive=Boolean(value);return 0;
    }
    fail(WSA.EOPNOTSUPP,`Unsupported socket option ${option}`);
  }
  listen(fd,backlog=8) {
    const socket=this._get(fd);
    if(socket.type!=='tcp')fail(WSA.EOPNOTSUPP,'listen requires TCP');
    if(!Number.isInteger(backlog)||backlog<1)fail(WSA.EINVAL,'Invalid listen backlog');
    // Winsock providers cap oversized requests at their supported backlog.
    // Warcraft passes 250; the virtual provider can queue up to 128 peers.
    backlog=Math.min(backlog,128);
    if(!['new','bound','listening'].includes(socket.state))fail(WSA.EINVAL,'Socket cannot listen in current state');
    if(!socket.localPort)this._bindEphemeral(socket);
    socket.state='listening';socket.backlog=backlog;return 0;
  }
  accept(fd) {
    const socket=this._get(fd);
    if(socket.state!=='listening')fail(WSA.EINVAL,'Socket is not listening');
    while(socket.pending.length){const child=this.sockets.get(socket.pending.shift());if(child&&!child.error)return{socket:child.fd,address:peerAddress(child.remotePeer),port:child.remotePort};}
    fail(WSA.EWOULDBLOCK,'No pending TCP connection');
  }
  acceptInto(fd,targetFd) {
    const target=this._get(targetFd);
    if(target.type!=='tcp'||target.state!=='new')fail(WSA.EINVAL,'AcceptEx requires an unbound TCP socket');
    const accepted=this.accept(fd),child=this._get(accepted.socket);
    // Keep the preallocated SOCKET and its IOCP association. No FIN is sent
    // when the internal handshake socket becomes the application's socket.
    const {port,completionKey}=target;
    Object.assign(target,child,{fd:targetFd,port,completionKey});
    this.sockets.delete(child.fd);
    return {...accepted,socket:targetFd};
  }
  changed(){this.dispatchEvent(new Event('change'));}
  _destination({address,port}={}) {
    if(!Number.isInteger(port)||port<1||port>65535)fail(WSA.EINVAL,'Invalid destination port');
    const peer=addressPeer(address);
    if(peer&&this.peers&&!this.peers.has(peer)&&peer!==this.transport.peerId)fail(WSA.ENETUNREACH,'Virtual peer is not in this room');
    return {peer,port};
  }
  connect(fd,destination) {
    this._network();const socket=this._get(fd),{peer,port}=this._destination(destination);
    if(!peer)fail(WSA.EOPNOTSUPP,'connect cannot target broadcast');
    if(socket.state==='connecting')fail(WSA.EALREADY,'TCP handshake already in progress');
    if(socket.state==='connected')fail(WSA.EISCONN,'Socket already connected');
    if(!['new','bound'].includes(socket.state))fail(WSA.EINVAL,'Socket cannot connect in current state');
    if(!socket.localPort)this._bindEphemeral(socket);
    socket.remotePeer=peer;socket.remotePort=port;
    if(socket.type==='udp'){socket.state='connected';return 0;}
    socket.connection=this.nextConnection++>>>0||this.nextConnection++;
    socket.state='connecting';socket.deadline=this.now()+this.connectTimeout;
    try{this._sendPacket(PACKET.SYN,socket,new Uint8Array());}
    catch(error){socket.state='bound';socket.remotePeer=null;socket.remotePort=0;throw error;}
    if(socket.state==='connected')return 0;
    fail(WSA.EWOULDBLOCK,'TCP handshake in progress');
  }
  _sendPacket(type,socket,payload,destination=socket.remotePeer,dstPort=socket.remotePort) {
    this._network();
    if(this._backpressured())fail(WSA.EWOULDBLOCK,'Frame transport is temporarily backpressured');
    const packet=new Uint8Array(HEADER+payload.length),view=new DataView(packet.buffer);
    view.setUint32(0,MAGIC,true);view.setUint8(4,type);view.setUint8(5,0);
    view.setUint16(6,socket.localPort,true);view.setUint16(8,dstPort,true);
    view.setUint16(10,payload.length,true);view.setUint32(12,type===PACKET.UDP?0:socket.connection,true);
    packet.set(payload,HEADER);
    if(destination===this.transport.peerId){queueMicrotask(()=>this._receive({source:this.transport.peerId,data:packet}));return;}
    try{this.transport.send(destination,packet);}catch(error){fail(WSA.ENOBUFS,`Frame transport rejected packet: ${error.message}`);}
    if(destination===0)queueMicrotask(()=>this._receive({source:this.transport.peerId,data:packet}));
  }
  sendto(fd,data,destination) {
    const socket=this._get(fd);bytes(data);
    if(socket.type!=='udp')fail(WSA.EOPNOTSUPP,'sendto requires UDP');
    if(socket.writeClosed)fail(WSA.ESHUTDOWN,'Socket send side is shut down');
    if(data.length>MAX_PAYLOAD)fail(WSA.EMSGSIZE,`UDP payload exceeds ${MAX_PAYLOAD} bytes`);
    const {peer,port}=this._destination(destination);
    if(!peer&&!socket.broadcast)fail(WSA.EOPNOTSUPP,'Enable SO_BROADCAST before broadcasting');
    if(!socket.localPort)this._bindEphemeral(socket);
    this._sendPacket(PACKET.UDP,socket,data,peer,port);return data.length;
  }
  recvfrom(fd,length,flags=0) {
    const socket=this._get(fd);this._recvArguments(length,flags);
    if(socket.type!=='udp')fail(WSA.EOPNOTSUPP,'recvfrom requires UDP');
    if(socket.readClosed)fail(WSA.ESHUTDOWN,'Socket receive side is shut down');
    if(!socket.datagrams.length)fail(WSA.EWOULDBLOCK,'No queued UDP datagram');
    const item=flags&2?socket.datagrams[0]:socket.datagrams.shift();
    if(!(flags&2))socket.queuedBytes-=item.data.length;
    if(length<item.data.length)fail(WSA.EMSGSIZE,'Receive buffer is smaller than UDP datagram');
    return {data:item.data.slice(),address:peerAddress(item.peer),port:item.port};
  }
  send(fd,data) {
    const socket=this._get(fd);bytes(data);
    if(socket.type==='udp'){
      if(!socket.remotePeer)fail(WSA.EDESTADDRREQ,'UDP socket has no connected destination');
      return this.sendto(fd,data,{address:peerAddress(socket.remotePeer),port:socket.remotePort});
    }
    if(socket.error)fail(socket.error,'TCP socket failed');
    if(socket.state!=='connected')fail(WSA.ENOTCONN,'TCP socket is not connected');
    if(socket.writeClosed)fail(WSA.ESHUTDOWN,'TCP send side is shut down');
    let sent=0;
    while(sent<data.length){const block=data.subarray(sent,sent+MAX_PAYLOAD);try{this._sendPacket(PACKET.DATA,socket,block);}catch(error){if(sent)return sent;throw error;}sent+=block.length;}
    return sent;
  }
  _recvArguments(length,flags) {
    if(!Number.isInteger(length)||length<0||length>0x7fffffff)fail(WSA.EINVAL,'Invalid receive length');
    if(flags!==0&&flags!==2)fail(WSA.EOPNOTSUPP,'Only MSG_PEEK is supported');
  }
  recv(fd,length,flags=0) {
    const socket=this._get(fd);this._recvArguments(length,flags);
    if(socket.type==='udp')return this.recvfrom(fd,length,flags).data;
    if(socket.error)fail(socket.error,'TCP socket failed');
    if(socket.state!=='connected')fail(WSA.ENOTCONN,'TCP socket is not connected');
    if(socket.readClosed)fail(WSA.ESHUTDOWN,'TCP receive side is shut down');
    if(length===0)return new Uint8Array();
    if(!socket.queuedBytes){if(socket.remoteFin)return new Uint8Array();fail(WSA.EWOULDBLOCK,'No queued TCP bytes');}
    const result=new Uint8Array(Math.min(length,socket.queuedBytes));let written=0;
    for(const block of socket.chunks){const take=Math.min(block.length,result.length-written);result.set(block.subarray(0,take),written);written+=take;if(written===result.length)break;}
    if(!(flags&2)){
      let remaining=result.length;
      while(remaining){const block=socket.chunks[0];if(block.length<=remaining){remaining-=block.length;socket.chunks.shift();}else{socket.chunks[0]=block.subarray(remaining);remaining=0;}}
      socket.queuedBytes-=result.length;
    }
    return result;
  }
  shutdown(fd,how=2) {
    const socket=this._get(fd);
    if(![0,1,2].includes(how))fail(WSA.EINVAL,'Invalid shutdown mode');
    if(socket.type==='tcp'&&socket.state!=='connected')fail(WSA.ENOTCONN,'TCP socket is not connected');
    if(how===0||how===2){socket.readClosed=true;socket.chunks=[];socket.datagrams=[];socket.queuedBytes=0;}
    if((how===1||how===2)&&!socket.writeClosed){if(socket.type==='tcp')this._sendPacket(PACKET.FIN,socket,new Uint8Array());socket.writeClosed=true;}
    this.changed();return 0;
  }
  close(fd) {
    const socket=this._get(fd);
    if(socket.type==='tcp'&&!socket.writeClosed&&socket.state==='connected'&&!this.disconnected){try{this._sendPacket(PACKET.FIN,socket,new Uint8Array());}catch{}}
    if(socket.state==='listening')for(const child of [...this.sockets.values()])if(child.parent===fd&&(child.state==='syn-received'||socket.pending.includes(child.fd))){try{this._sendPacket(PACKET.RST,child,new Uint8Array());}catch{}this.sockets.delete(child.fd);}
    this.sockets.delete(fd);this.changed();return 0;
  }
  getsockname(fd) {const socket=this._get(fd);return{address:socket.localAddress,port:socket.localPort};}
  getpeername(fd) {const socket=this._get(fd);if(!socket.remotePeer||socket.state!=='connected')fail(WSA.ENOTCONN,'Socket is not connected');return{address:peerAddress(socket.remotePeer),port:socket.remotePort};}
  getError(fd) {const socket=this._get(fd),error=socket.error;socket.error=0;return error;}
  select({read=[],write=[],except=[]}={}) {
    const readable=read.filter(fd=>{const s=this._get(fd);return s.state==='listening'?s.pending.length>0:s.type==='udp'?s.datagrams.length>0:s.state==='connected'&&(s.queuedBytes>0||s.remoteFin||s.error);});
    const writable=write.filter(fd=>{const s=this._get(fd);return !this.disconnected&&!this._backpressured()&&!s.error&&!s.writeClosed&&(s.type==='udp'||s.state==='connected');});
    const exceptional=except.filter(fd=>this._get(fd).error!==0);
    return{read:readable,write:writable,except:exceptional,count:new Set([...readable,...writable,...exceptional]).size};
  }
  _receive({source,data}={}) {
    try{return this._receivePacket({source,data});}finally{this.changed();}
  }
  _receivePacket({source,data}={}) {
    this.poll();
    if(this.disconnected||!Number.isInteger(source)||source<1||source>MAX_PEER||!(data instanceof Uint8Array)||data.length<HEADER)return;
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
    if(view.getUint32(0,true)!==MAGIC||view.getUint8(5)!==0||view.getUint16(10,true)!==data.length-HEADER)return;
    const type=view.getUint8(4),srcPort=view.getUint16(6,true),dstPort=view.getUint16(8,true),connection=view.getUint32(12,true);
    if(!srcPort||!dstPort)return;
    const payload=data.subarray(HEADER);
    if(type===PACKET.UDP){
      if(connection)return;
      for(const s of this.sockets.values())if(s.type==='udp'&&s.localPort===dstPort&&!s.readClosed&&(!s.remotePeer||(s.remotePeer===source&&s.remotePort===srcPort))){
        if(s.queuedBytes+payload.length<=this.maxQueuedBytes&&s.datagrams.length<this.maxDatagrams){s.datagrams.push({data:payload.slice(),peer:source,port:srcPort});s.queuedBytes+=payload.length;}
      }
      return;
    }
    if(!connection||type<PACKET.SYN||type>PACKET.RST||(type!==PACKET.DATA&&payload.length))return;
    let socket=[...this.sockets.values()].find(s=>s.type==='tcp'&&s.localPort===dstPort&&s.remotePort===srcPort&&s.remotePeer===source&&s.connection===connection);
    if(type===PACKET.SYN){
      if(socket){if(socket.state==='syn-received')this._safeReply(PACKET.SYN_ACK,socket);return;}
      const listener=[...this.sockets.values()].find(s=>s.type==='tcp'&&s.state==='listening'&&s.localPort===dstPort);
      if(!listener||[...this.sockets.values()].filter(s=>s.parent===listener.fd&&s.state==='syn-received').length+listener.pending.length>=listener.backlog){
        this._safeReply(PACKET.RST,{localPort:dstPort,remotePort:srcPort,remotePeer:source,connection});return;
      }
      socket=this._get(this.socket('tcp'));Object.assign(socket,{state:'syn-received',deadline:this.now()+this.connectTimeout,parent:listener.fd,localPort:dstPort,localAddress:listener.localAddress,remotePeer:source,remotePort:srcPort,connection});
      this._safeReply(PACKET.SYN_ACK,socket);return;
    }
    if(!socket)return;
    if(type===PACKET.RST){socket.error=socket.state==='connecting'?WSA.ECONNREFUSED:WSA.ECONNRESET;socket.state='failed';return;}
    if(type===PACKET.SYN_ACK&&socket.state==='connecting'){socket.state='connected';socket.deadline=0;this._safeReply(PACKET.ACK,socket);return;}
    if(type===PACKET.ACK&&socket.state==='syn-received'){const listener=this.sockets.get(socket.parent);if(!listener){this._safeReply(PACKET.RST,socket);this.sockets.delete(socket.fd);return;}socket.state='connected';socket.deadline=0;listener.pending.push(socket.fd);return;}
    if(socket.state!=='connected')return;
    if(type===PACKET.FIN){socket.remoteFin=true;return;}
    if(type===PACKET.DATA&&!socket.readClosed&&!socket.remoteFin){
      if(socket.queuedBytes+payload.length>this.maxQueuedBytes){socket.error=WSA.ENOBUFS;this._safeReply(PACKET.RST,socket);return;}
      if(payload.length){socket.chunks.push(payload.slice());socket.queuedBytes+=payload.length;}
    }
  }
  _safeReply(type,socket){try{this._sendPacket(type,socket,new Uint8Array());}catch{socket.error=WSA.ENETDOWN;}}
  destroy() {
    for(const fd of [...this.sockets.keys()])if(this.sockets.has(fd))this.close(fd);
    this.transport.removeEventListener('packet',this.onPacket);
    this.transport.removeEventListener('disconnect',this.onDisconnect);
    this.transport.removeEventListener('peers',this.onPeers);
    this.disconnected=true;
  }
}
