import {VirtualWinsock,WSA,WSAError} from './winsock.mjs';

// Single-player Winsock initialization uses a private loopback adapter. It
// never sends frames to the server and cannot communicate with another peer.
class LoopbackTransport extends EventTarget {
  constructor(){super();this.peerId=1;this.isOffline=true;}
  send(destination){if(destination!==0&&destination!==1)throw new WSAError(WSA.ENETUNREACH,'Offline socket cannot reach a remote peer');}
}
class LoopbackWinsock extends VirtualWinsock {
  constructor(options){super(new LoopbackTransport(),options);this.address='127.0.0.1';this.peers=new Set([1]);this.isOffline=true;}
  _destination(destination){const address=destination?.address;return super._destination({...destination,address:address==='localhost'||address==='127.0.0.1'?'10.77.0.1':address});}
  accept(fd){return {...super.accept(fd),address:this.address};}
  recvfrom(fd,length,flags=0){return {...super.recvfrom(fd,length,flags),address:this.address};}
  getpeername(fd){return {...super.getpeername(fd),address:this.address};}
}
export function createOfflineNetwork(options){return new LoopbackWinsock(options);}
