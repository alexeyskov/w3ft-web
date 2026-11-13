// A LAN host has no remote W3GS stream when it plays against only computers.
// Observe its existing advertisement, writable replay and rendered scene.
// Loading screens are flat; the first later depth-tested perspective scene
// confirms that the match reached the map. Nothing in the game is modified.
const MAGIC=0x31535743, MATCH=9, SERVER=255;

export function matchStatusPacket(port,active){
  const packet=new Uint8Array(16),view=new DataView(packet.buffer);
  view.setUint32(0,MAGIC,true);view.setUint8(4,MATCH);
  view.setUint16(6,port,true);view.setUint32(12,active?1:0,true);
  return packet;
}

export class LANMatchReporter {
  constructor(network,{clock=()=>performance.now()}={}){
    this.network=network;this.clock=clock;this.host=null;this.reportedPort=0;this.lastReport=-Infinity;
    this.datagram=event=>this.advertisement(event.detail);
    // listen() may refresh the backlog of a live match. After recording has
    // begun, only closing its replay/socket (or a new advertisement) ends it.
    this.reset=event=>{if(this.host?.socket===event.detail&&(event.type==='socketclosed'||!this.host.replay))this.clear();};
    network.addEventListener('datagramsent',this.datagram);
    network.addEventListener('listening',this.reset);
    network.addEventListener('socketclosed',this.reset);
  }
  advertisement({socket,data,destination,port}){
    if(destination!==0||port!==6112||data.length<4||data[0]!==0xf7)return;
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
    if(view.getUint16(2,true)!==data.length)return;
    if(data[1]===0x31&&data.length===16){ // W3GS_CREATEGAME, no player/map strings
      const listeners=[...this.network.sockets.values()].filter(s=>s.type==='tcp'&&s.state==='listening');
      const listener=listeners.find(s=>s.localPort===socket.localPort)||(listeners.length===1?listeners[0]:null);
      if(!listener)return;
      this.clear();
      this.host={socket:listener,counter:view.getUint32(12,true),loading:false,replay:null,perspective:0,active:false};
    }else if(data[1]===0x33&&data.length===8&&this.host?.counter===view.getUint32(4,true)){
      this.host.loading=true; // also emitted on cancellation: insufficient on its own
    }else if(data[1]===0x2f){
      this.clear(); // returning to the LAN game list, including a cancelled host
    }
  }
  clear(){
    this.host=null;
    if(this.reportedPort)this.report(0);
  }
  report(port){
    try{
      // Server-only telemetry, never injected into another game's sockets.
      this.network.transport.send(SERVER,matchStatusPacket(port||this.reportedPort,!!port));
      this.reportedPort=port;this.lastReport=this.clock();
    }catch{ /* Losing telemetry must never interrupt the game. */ }
  }
  frame(host,frame){
    const candidate=this.host;
    if(!candidate)return;
    if(this.network.disconnected||this.network.sockets.get(candidate.socket.fd)!==candidate.socket){this.clear();return;}
    if(!candidate.loading)return;
    if(!candidate.replay){
      for(const [id,file] of host.handles){
        if(file.kind==='file'&&file.writing&&file.key==='tempreplay.w3g'){
          candidate.replay=file;candidate.replayHandle=id;candidate.perspective=frame.perspectiveDraws||0;break;
        }
      }
      return; // exclude menu/transition draws made before replay recording
    }
    if(host.handles.get(candidate.replayHandle)!==candidate.replay){this.clear();return;}
    if((frame.perspectiveDraws||0)>candidate.perspective)candidate.active=true;
    if(candidate.active&&(this.reportedPort!==candidate.socket.localPort||this.clock()-this.lastReport>=10000))
      this.report(candidate.socket.localPort);
  }
  destroy(){
    this.clear();
    this.network.removeEventListener('datagramsent',this.datagram);
    this.network.removeEventListener('listening',this.reset);
    this.network.removeEventListener('socketclosed',this.reset);
  }
}
