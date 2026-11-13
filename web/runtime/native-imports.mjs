// ABI shared with runtime/runtime.c. Older WASM keeps its JS implementations.
const operations = [
  [1,'_CIsqrt'],[2,'_CIlog10'],[3,'_CIexp'],[4,'_CIatan'],[5,'_CItan'],
  [6,'_CIacos'],[7,'_CIasin'],[8,'_CIsin'],[9,'_CIcos'],[10,'_CIpow'],[11,'_CIatan2'],[12,'_CIfmod'],
  [20,'floor'],[21,'ceil'],[22,'sqrt'],[30,'memcpy'],[31,'memmove'],[32,'memset'],[33,'memcmp'],
  [34,'strlen'],[35,'strcmp'],[36,'strncmp'],[37,'qsort'],[38,'_stricmp'],[39,'_strnicmp'],
];
const byName = new Map(operations.map(([id,name])=>[name,id]));
export function bindNativeImport(host,id,handler) {
  if(!host.exports?.wc3_bind_native_import || handler?.unsupported ||
     handler?.dll.toLowerCase()!=='msvcr80.dll' || handler.convention!=='cdecl')return;
  const operation=byName.get(handler.name);
  if(operation&&!host.exports.wc3_bind_native_import(id,operation))throw new Error('Native CRT import ABI mismatch');
}
