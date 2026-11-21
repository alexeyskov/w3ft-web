// The maps LAN hosts offer this game, read from Warcraft's own TCP streams:
// W3GS_MAPCHECK (0x3D) names the host's map path and its size. A map Warcraft
// downloads into Maps/Download is kept in the browser's map store only when
// its file has that size; an interrupted download leaves a shorter file that
// Warcraft closes all the same. Nothing in the streams is changed.
// Packet layout: GHost++ gameprotocol.cpp, SEND_W3GS_MAPCHECK
// https://github.com/dcramer/ghostplusplus/blob/master/ghost/gameprotocol.cpp
const W3GS=0xf7,MAPCHECK=0x3d,MAX_BUFFER=65536;
const ansi=new TextDecoder('windows-1252');
// The kernel's key for a path relative to the installation (kernel.mjs pathKey).
export const pathKey=path=>path.replaceAll('\\','/').split('/').filter(part=>part&&part!=='.').join('/').toLowerCase();

export class MapOffers {
  constructor(network){
    this.network=network;this.sizes=new Map();this.streams=new WeakMap();
    this.observe=(socket,data)=>{try{this.receive(socket,data);}catch{this.streams.set(socket,null);}};
    network?.streamObservers?.add(this.observe);
  }
  receive(socket,data){
    let buffer=this.streams.get(socket);
    if(buffer===null)return; // not a W3GS stream
    if(buffer?.length){const joined=new Uint8Array(buffer.length+data.length);joined.set(buffer);joined.set(data,buffer.length);buffer=joined;}else buffer=data;
    let at=0;
    while(buffer.length-at>=4){
      const size=buffer[at+2]|buffer[at+3]<<8;
      if(buffer[at]!==W3GS||size<4){this.streams.set(socket,null);return;}
      if(buffer.length-at<size)break;
      if(buffer[at+1]===MAPCHECK)this.mapCheck(buffer.subarray(at,at+size));
      at+=size;
    }
    const rest=buffer.slice(at);
    this.streams.set(socket,rest.length>MAX_BUFFER?null:rest);
  }
  // Header, a 32-bit field, the path (zero-terminated), the size, CRCs, SHA-1.
  mapCheck(packet){
    const end=packet.indexOf(0,8);
    if(end<0||end+5>packet.length)return;
    const key=pathKey(ansi.decode(packet.subarray(8,end)));
    if(key)this.sizes.set(key,new DataView(packet.buffer,packet.byteOffset+end+1,4).getUint32(0,true));
  }
  destroy(){this.network?.streamObservers?.delete(this.observe);}
}
