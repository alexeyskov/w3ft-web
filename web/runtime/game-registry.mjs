// Only Warcraft's settings belong to the browser profile. Installation paths
// and Video are supplied by this runtime/the launcher on every start.
const GAME=/^(user|machine)\\software\\blizzard entertainment\\warcraft iii(?:\\|$)/;
const BOOTSTRAP=new Set(['installpath','installpathx','program','programx','gamepath','allow local files']);
const LIMIT=256*1024;
const allowed=(path,name)=>GAME.test(path)&&!/^.*\\warcraft iii\\video(?:\\|$)/.test(path)&&
  !(name!==undefined&&/\\warcraft iii$/.test(path)&&BOOTSTRAP.has(name));

export class GameRegistry {
  constructor(keys,create){this.keys=keys;this.create=create;this.dirty=false;}
  changed(path,name){if(allowed(path,name))this.dirty=true;}
  encode(){
    const keys=[];
    for(const [path,values] of this.keys){
      if(!allowed(path))continue;
      keys.push([path,[...values].filter(([name])=>allowed(path,name)).map(([name,value])=>
        [name,{type:value.type,data:[...value.data],...(value.string!==undefined?{string:value.string}:{})}])]);
    }
    const data=new TextEncoder().encode(JSON.stringify({format:'w3ft-registry-v1',keys}));
    return data.length<=LIMIT?data:null;
  }
  restore(data){
    try{
      if(!(data instanceof Uint8Array)||data.length>LIMIT)return false;
      const state=JSON.parse(new TextDecoder().decode(data));
      if(state.format!=='w3ft-registry-v1'||!Array.isArray(state.keys)||state.keys.length>512)return false;
      const prepared=[];
      for(const row of state.keys){
        if(!Array.isArray(row)||row.length!==2)return false;
        const [path,values]=row;
        if(typeof path!=='string'||path.length>1024||path!==path.toLowerCase()||path.includes('\\\\')||
           /[\x00-\x1f]/.test(path)||!allowed(path)||!Array.isArray(values)||values.length>1024)return false;
        const cleaned=[];
        for(const entry of values){
          if(!Array.isArray(entry)||entry.length!==2)return false;
          const [name,value]=entry;
          if(typeof name!=='string'||name.length>512||name!==name.toLowerCase()||/[\x00-\x1f]/.test(name)||
             !allowed(path,name)||!value||!Number.isInteger(value.type)||value.type<0||value.type>0xffffffff||
             !Array.isArray(value.data)||value.data.length>65536||value.data.some(n=>!Number.isInteger(n)||n<0||n>255)||
             (value.string!==undefined&&(typeof value.string!=='string'||value.string.length>65536)))return false;
          cleaned.push([name,{type:value.type,data:Uint8Array.from(value.data),...(value.string!==undefined?{string:value.string}:{})}]);
        }
        prepared.push([path,cleaned]);
      }
      // Validate the whole snapshot before touching the live registry.
      for(const [path,values] of prepared)for(const [name,value] of values)this.create(path).set(name,value);
      for(const [path] of prepared)this.create(path);
      this.dirty=false;return true;
    }catch{return false;}
  }
}
