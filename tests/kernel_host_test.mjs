import assert from 'node:assert/strict';
import {WarcraftHost, GuestFault, GuestExit} from '../web/runtime/host.mjs';
import {installKernel} from '../web/runtime/kernel.mjs';

const source = new Map([['Maps/Test.w3x', Uint8Array.of(10,20,30,40,50)], ['Data.bin', Uint8Array.of(1,2,3)], ['Maps/Web/Test.w3x', Uint8Array.of(10,20,30,40,50)]]);
const hiddenFiles = new Set(['Maps/Web/Test.w3x']);
let now = 1000, cursor = 0x10000;
const reads = [], callbacks = [];
const h = new WarcraftHost({
  memory: new WebAssembly.Memory({initial: 256}), clock: () => now,
  listFiles: () => [...source.keys()].map(path => hiddenFiles.has(path) ? {path, hidden: true} : path), fileSize: path => source.get(path).length,
  readFile: (path, offset = 0, length = undefined) => { reads.push({path,offset,length}); return source.get(path)?.slice(offset, length === undefined ? undefined : offset+length); },
});
h.base = 0;
h.exports = {wc3_guest_alloc(size) {const result=cursor;cursor+=size;return result;}};
h.fileSize = path => source.get(path).length;
h.module = () => 0;
h.proc = () => 0;
h.commandPointer = h.string(h.commandLine);
h.call = (address, args) => {callbacks.push({address,args:args.slice(),creation:args[1]===0x81?h.copyOut(args[3],48):null});return args[1]===0x81?1:0;};
// Exercise this implementation even if platform-specific adapters replace an
// overlapping entry in the complete host installation.
installKernel(h);
const invoke = (name, args = [], dll = 'kernel32.dll') => {
  const handler = h.handlers.get(`${dll}!${name}`);assert.ok(handler,`Handler ${dll}!${name}`);
  assert.equal(args.length,handler.argc,`${name} argument count`);
  return (handler.fn(args.map(value=>value>>>0)) ?? 0)>>>0;
};
const user = (name,args=[]) => invoke(name,args,'user32.dll');
const adv = (name,args=[]) => invoke(name,args,'advapi32.dll');
const pointer = size => h.alloc(size);
const string = value => h.string(value);
const wide = value => {const p=pointer((value.length+1)*2);for(let i=0;i<value.length;i++)h.w16(p+i*2,value.charCodeAt(i));return p;};

const heap=invoke('GetProcessHeap');
const block=invoke('HeapAlloc',[heap,8,12]);h.w32(block,0x12345678);
const grown=invoke('HeapReAlloc',[heap,8,block,64]);assert.equal(h.u32(grown),0x12345678);
assert.equal(invoke('HeapSize',[heap,0,grown]),64);
assert.equal(invoke('HeapFree',[heap,0,grown]),1);
assert.equal(invoke('HeapFree',[heap,0,grown]),0);
const tls=invoke('TlsAlloc');assert.equal(invoke('TlsSetValue',[tls,123]),1);assert.equal(invoke('TlsGetValue',[tls]),123);assert.equal(invoke('TlsFree',[tls]),1);assert.equal(invoke('TlsGetValue',[tls]),0);assert.equal(h.lastError,87);
const atomic=pointer(4);h.w32(atomic,0xffffffff);assert.equal(invoke('InterlockedIncrement',[atomic]),0);assert.equal(invoke('InterlockedCompareExchange',[atomic,42,0]),0);assert.equal(h.u32(atomic),42);

// Test the permission API contract with a real bitmap checked by WarcraftHost.
// The separate native CPU suite verifies that translated guest accesses use it.
h.permissionsBase=0xf00000;
h.bytes.fill(255,h.permissionsBase,h.permissionsBase+0xf000);
h.exports.wc3_protect_guest=(address,size,access)=>{
  if(address+size>0xf00000)return 0;
  const first=address>>>12,last=(address+size-1)>>>12;
  for(let page=first;page<=last;page++){const at=h.permissionsBase+(page>>>3),mask=1<<(page&7);if(access)h.bytes[at]|=mask;else h.bytes[at]&=~mask;}
  return 1;
};
const reserved=invoke('VirtualAlloc',[0,8192,0x2000,1]);assert.equal(reserved%65536,0);
assert.throws(()=>h.w8(reserved,1),GuestFault);
assert.equal(invoke('VirtualAlloc',[reserved+4099,1,0x1000,4]),reserved+4096);
assert.throws(()=>h.w8(reserved,1),GuestFault);h.w8(reserved+4096,73);
assert.equal(invoke('VirtualAlloc',[reserved+4096,4096,0x1000,4]),reserved+4096);assert.equal(h.u8(reserved+4096),73,'Recommit preserves existing data');
const query=pointer(28);assert.equal(invoke('VirtualQuery',[reserved,query,28]),28);assert.equal(h.u32(query+16),0x2000);assert.equal(h.u32(query+12),4096);
assert.equal(invoke('VirtualFree',[reserved+4096,4096,0x4000]),1);assert.throws(()=>h.u8(reserved+4096),GuestFault);
invoke('VirtualAlloc',[reserved+4096,4096,0x1000,4]);assert.equal(h.u8(reserved+4096),0);
const previousProtection=pointer(4);assert.equal(invoke('VirtualProtect',[reserved+4096,4096,1,previousProtection]),1);assert.equal(h.u32(previousProtection),4);assert.throws(()=>h.u8(reserved+4096),GuestFault);
assert.equal(invoke('VirtualProtect',[reserved+4096,4096,4,previousProtection]),1);assert.equal(h.u32(previousProtection),1);
assert.equal(invoke('VirtualFree',[reserved,0,0x8000]),1);assert.throws(()=>h.u8(reserved),GuestFault);

const event=invoke('CreateEventA',[0,0,1,0]);assert.equal(invoke('WaitForSingleObject',[event,0]),0);assert.equal(invoke('WaitForSingleObject',[event,0]),258);
assert.throws(()=>invoke('WaitForSingleObject',[event,0xffffffff]),GuestFault);
assert.equal(invoke('SetEvent',[event]),1);
const semaphore=invoke('CreateSemaphoreA',[0,0,2,0]), handles=pointer(8);h.w32(handles,event);h.w32(handles+4,semaphore);
assert.equal(invoke('WaitForMultipleObjects',[2,handles,1,0]),258);
assert.equal(invoke('WaitForSingleObject',[event,0]),0,'Wait-all failure must not consume an auto-reset event');
assert.equal(invoke('ReleaseSemaphore',[semaphore,1,0]),1);assert.equal(invoke('WaitForSingleObject',[semaphore,0]),0);
assert.throws(()=>invoke('CreateThread',[0,0,0,0,0,0]),GuestFault);
assert.throws(()=>invoke('ExitProcess',[7]),error=>error instanceof GuestExit&&error.code===7);

const name=string('C:\\Warcraft III\\MAPS\\TEST.W3X');
const file=invoke('CreateFileA',[name,0x80000000,1,0,3,0,0]);assert.notEqual(file,0xffffffff);assert.equal(reads.length,0,'Open uses fileSize without downloading MPQ contents');
const output=pointer(16), count=pointer(4);
assert.equal(invoke('ReadFile',[file,output,2,count,0]),1);assert.equal(h.u32(count),2);assert.deepEqual([...h.copyOut(output,2)],[10,20]);
assert.deepEqual(reads.at(-1),{path:'Maps/Test.w3x',offset:0,length:2});
assert.equal(invoke('SetFilePointer',[file,0xffffffff,0,2]),4);
assert.equal(invoke('ReadFile',[file,output,8,count,0]),1);assert.equal(h.u32(count),1);assert.equal(h.u8(output),50);
assert.equal(invoke('ReadFile',[file,output,8,count,0]),1);assert.equal(h.u32(count),0,'EOF is a successful zero-byte read');
assert.equal(invoke('CreateFileA',[name,0x40000000,3,0,3,0,0]),0xffffffff);assert.equal(h.lastError,32,'Share-read prevents opening a writer');
const before=reads.length;
assert.equal(invoke('CreateFileA',[string('../secret'),0x80000000,3,0,3,0,0]),0xffffffff);assert.equal(reads.length,before);
assert.equal(invoke('CreateFileA',[string('C:\\Windows\\system.ini'),0x80000000,3,0,3,0,0]),0xffffffff);
const save=invoke('CreateFileA',[string('Save\\Campaign.w3v'),0xc0000000,3,0,2,0,0]);assert.notEqual(save,0xffffffff);
h.copyIn(output,Uint8Array.of(6,7,8));assert.equal(invoke('WriteFile',[save,output,3,count,0]),1);assert.equal(invoke('SetFilePointer',[save,0,0,0]),0);assert.equal(invoke('ReadFile',[save,output,3,count,0]),1);assert.deepEqual([...h.copyOut(output,3)],[6,7,8]);
assert.deepEqual([...h.virtualFiles.get('save/campaign.w3v')],[6,7,8]);
// Deleting a profile: Warcraft deletes its files, then save\<profile>. A
// restored profile's folder exists only through its files and must outlive them.
h.virtualFiles.set('save/profile2/campaigns.w3p',Uint8Array.of(1));h.virtualFiles.set('save/profile2/fog.w3z',Uint8Array.of(2));
assert.equal(invoke('RemoveDirectoryA',[string('Save\\Profile2')]),0);assert.equal(h.lastError,145,'ERROR_DIR_NOT_EMPTY');
assert.equal(invoke('DeleteFileA',[string('Save\\Profile2\\campaigns.w3p')]),1);assert.equal(invoke('DeleteFileA',[string('Save\\Profile2\\fog.w3z')]),1);
assert.equal(invoke('GetFileAttributesA',[string('Save\\Profile2')]),0x10,'the folder outlives its files');
assert.equal(invoke('RemoveDirectoryA',[string('Save\\Profile2')]),1);
assert.equal(invoke('GetFileAttributesA',[string('Save\\Profile2')]),0xffffffff);
assert.equal(invoke('RemoveDirectoryA',[string('Save\\Profile2')]),0);assert.equal(h.lastError,2);
assert.equal(invoke('RemoveDirectoryA',[string('Save\\Campaign.w3v')]),0);assert.equal(h.lastError,267,'ERROR_DIRECTORY');
assert.equal(invoke('CreateDirectoryA',[string('Save\\Empty'),0]),1);assert.equal(invoke('RemoveDirectoryA',[string('Save\\Empty')]),1);
// Leaving a network game: the replay is written to a temporary file, then
// moved to Replay\LastReplay.w3g.
h.virtualFiles.set('replay/temp.w3g',Uint8Array.of(1,2,3));
assert.equal(invoke('MoveFileA',[string('Replay\\Temp.w3g'),string('Replay\\LastReplay.w3g')]),1);
assert.equal(h.virtualFiles.has('replay/temp.w3g'),false);assert.deepEqual([...h.virtualFiles.get('replay/lastreplay.w3g')],[1,2,3]);
assert.ok(h.virtualFiles.deleted.has('replay/temp.w3g'),'The move is saved as a deletion and a new file');
h.virtualFiles.set('replay/temp.w3g',Uint8Array.of(4));
assert.equal(invoke('MoveFileA',[string('Replay\\Temp.w3g'),string('Replay\\LastReplay.w3g')]),0);assert.equal(h.lastError,183,'MoveFile does not replace');
assert.equal(invoke('MoveFileExA',[string('Replay\\Temp.w3g'),string('Replay\\LastReplay.w3g'),1]),1);assert.deepEqual([...h.virtualFiles.get('replay/lastreplay.w3g')],[4]);
assert.equal(invoke('MoveFileA',[string('Replay\\Missing.w3g'),string('Replay\\Other.w3g')]),0);assert.equal(h.lastError,2);
assert.equal(invoke('MoveFileA',[string('Data.bin'),string('Moved.bin')]),0);assert.equal(h.lastError,5,'Installation files are read-only');
assert.equal(invoke('MoveFileA',[string('Save\\Campaign.w3v'),string('Save\\Moved.w3v')]),0);assert.equal(h.lastError,32,'Open without FILE_SHARE_DELETE');
assert.equal(invoke('MoveFileExA',[string('Replay\\LastReplay.w3g'),0,4]),0);assert.equal(h.lastError,87,'No reboot to delay until');
assert.equal(invoke('CopyFileA',[string('Data.bin'),string('Replay\\Copy.bin'),1]),1);assert.deepEqual([...h.virtualFiles.get('replay/copy.bin')],[1,2,3],'Copies installation files');
assert.equal(invoke('CopyFileA',[string('Replay\\LastReplay.w3g'),string('Replay\\Copy.bin'),1]),0);assert.equal(h.lastError,80);
assert.equal(invoke('CopyFileA',[string('Replay\\LastReplay.w3g'),string('Replay\\Copy.bin'),0]),1);assert.deepEqual([...h.virtualFiles.get('replay/copy.bin')],[4]);
assert.equal(invoke('CopyFileA',[string('Save\\Campaign.w3v'),string('Replay\\Campaign.w3v'),0]),0);assert.equal(h.lastError,32,'Source open for writing');
assert.equal(invoke('SetFileAttributesA',[string('Replay\\Copy.bin'),0x80]),1);
assert.equal(invoke('SetFileAttributesA',[string('Replay\\None.bin'),0x80]),0);assert.equal(h.lastError,2);
// Dates and times of the virtual en-US Windows.
const systemTime=pointer(16);[2026,11,6,7,13,5,9,0].forEach((value,i)=>h.w16(systemTime+i*2,value));
const dateText=pointer(64),formatTime=(name,flags,picture,capacity=64)=>{const length=invoke(name,[0x409,flags,systemTime,picture?string(picture):0,dateText,capacity]);return length?h.cstr(dateText):null;};
assert.equal(formatTime('GetDateFormatA',0),'11/7/2026');assert.equal(formatTime('GetDateFormatA',2),'Saturday, November 07, 2026');
assert.equal(formatTime('GetDateFormatA',0,"yyyy'-'MM'-'dd ddd MMM yy"),'2026-11-07 Sat Nov 26');
assert.equal(formatTime('GetTimeFormatA',0),'1:05:09 PM');assert.equal(formatTime('GetTimeFormatA',8|2),'13:05 PM','A 24-hour clock keeps the marker');assert.equal(formatTime('GetTimeFormatA',8|4|2),'13:05');
assert.equal(formatTime('GetTimeFormatA',0,"HH'h'mm ''tt''"),"13h05 'PM'");
assert.equal(invoke('GetDateFormatA',[0x409,0,systemTime,0,dateText,0]),10,'Length with the terminator');
assert.equal(formatTime('GetDateFormatA',0,null,4),null);assert.equal(h.lastError,122);
const findData=pointer(320),find=invoke('FindFirstFileA',[string('Maps\\*.w3x'),findData]);assert.notEqual(find,0xffffffff);assert.equal(h.cstr(findData+44),'test.w3x');assert.equal(invoke('FindNextFileA',[find,findData]),0);assert.equal(h.lastError,18);assert.equal(invoke('FindClose',[find]),1);
// A hidden alias (maps recorded by old saves under Maps\Web) opens by its
// path and is listed inside its own folder, but Maps does not show the folder.
const listing=pattern=>{const names=[],id=invoke('FindFirstFileA',[string(pattern),findData]);if(id===0xffffffff)return names;do names.push(h.cstr(findData+44));while(invoke('FindNextFileA',[id,findData]));invoke('FindClose',[id]);return names;};
assert.deepEqual(listing('Maps\\*'),['test.w3x']);
assert.deepEqual(listing('Maps\\Web\\*'),['test.w3x']);
const alias=invoke('CreateFileA',[string('Maps\\Web\\Test.w3x'),0x80000000,1,0,3,0,0]);assert.notEqual(alias,0xffffffff);
assert.equal(invoke('ReadFile',[alias,output,5,count,0]),1);assert.deepEqual([...h.copyOut(output,5)],[10,20,30,40,50]);assert.equal(invoke('CloseHandle',[alias]),1);

// Shared mapping ranges genuinely alias the same guest memory; closing a
// mapping handle does not invalidate a live view, and writeback reaches VFS.
h.virtualFiles.set('save/mapping.bin',new Uint8Array(131072));
const mappedFile=invoke('CreateFileA',[string('Save\\Mapping.bin'),0xc0000000,3,0,3,0,0]);
const mappingName=string('Local\\KernelMapping');
const mapping=invoke('CreateFileMappingA',[mappedFile,0,4,0,0,mappingName]);assert.ok(mapping);
const whole=invoke('MapViewOfFile',[mapping,2,0,0,131072]);assert.ok(whole);assert.equal(whole%65536,0);
const overlap=invoke('MapViewOfFile',[mapping,2,0,65536,4096]);assert.equal(overlap,whole+65536);
h.w8(overlap,99);assert.equal(h.u8(whole+65536),99);
const otherMapping=invoke('CreateFileMappingA',[mappedFile,0,4,0,0,0]);
const otherView=invoke('MapViewOfFile',[otherMapping,2,0,65536,4096]);assert.equal(otherView,overlap);h.w8(otherView+1,77);assert.equal(h.u8(overlap+1),77);
assert.equal(invoke('FlushViewOfFile',[overlap,2]),1);assert.equal(h.virtualFiles.get('save/mapping.bin')[65536],99);assert.equal(h.virtualFiles.get('save/mapping.bin')[65537],77);
assert.equal(invoke('MapViewOfFile',[mapping,2,0,1,4096]),0);assert.equal(h.lastError,1132);
assert.equal(invoke('MapViewOfFile',[mapping,2,0,65536,131072]),0);assert.equal(h.lastError,87);
assert.throws(()=>invoke('MapViewOfFile',[mapping,4,0,0,4096]),GuestFault,'Readonly views cannot silently become writable');
assert.throws(()=>invoke('MapViewOfFile',[mapping,1,0,0,4096]),GuestFault,'Copy-on-write needs actual write-fault semantics');
const limitedMapping=invoke('OpenFileMappingA',[4,0,mappingName]);assert.ok(limitedMapping);assert.equal(invoke('MapViewOfFile',[limitedMapping,2,0,0,4096]),0);assert.equal(h.lastError,5);invoke('CloseHandle',[limitedMapping]);
assert.equal(invoke('SetEndOfFile',[mappedFile]),0);assert.equal(h.lastError,1224);
assert.equal(invoke('CloseHandle',[mapping]),1);assert.equal(invoke('CloseHandle',[otherMapping]),1);assert.equal(invoke('CloseHandle',[mappedFile]),1);
assert.equal(h.u8(whole+65536),99,'Views keep mapping and file objects alive after handle close');
const reopened=invoke('OpenFileMappingA',[2,0,mappingName]);assert.ok(reopened);invoke('CloseHandle',[reopened]);
assert.equal(invoke('UnmapViewOfFile',[overlap]),1);assert.equal(h.u8(overlap),99);
assert.equal(invoke('UnmapViewOfFile',[overlap]),1);assert.equal(h.u8(whole+65536),99,'Containing view still owns the shared page');
assert.equal(invoke('UnmapViewOfFile',[whole]),1);assert.throws(()=>h.u8(whole),GuestFault);
assert.equal(invoke('OpenFileMappingA',[2,0,mappingName]),0);assert.equal(h.lastError,2);
assert.equal(invoke('UnmapViewOfFile',[whole]),0);assert.equal(h.lastError,487);

const anonymous=invoke('CreateFileMappingA',[0xffffffff,0,4,0,131072,0]);assert.ok(anonymous);
const anonymousFirst=invoke('MapViewOfFile',[anonymous,2,0,0,65536]);assert.equal(h.u32(anonymousFirst),0);h.w32(anonymousFirst,0x10203040);
const anonymousSecond=invoke('MapViewOfFile',[anonymous,2,0,65536,65536]);assert.equal(h.u32(anonymousSecond),0);
assert.throws(()=>invoke('MapViewOfFile',[anonymous,2,0,0,131072]),/virtual aliases/,'An expanding overlap cannot be replaced with incoherent copies');
invoke('UnmapViewOfFile',[anonymousFirst]);assert.throws(()=>h.u32(anonymousFirst),GuestFault);
const anonymousAgain=invoke('MapViewOfFile',[anonymous,2,0,0,65536]);assert.equal(h.u32(anonymousAgain),0x10203040,'Anonymous object retains data between views');
assert.equal(invoke('FlushViewOfFile',[anonymousAgain,0]),1);invoke('UnmapViewOfFile',[anonymousAgain]);invoke('UnmapViewOfFile',[anonymousSecond]);invoke('CloseHandle',[anonymous]);
assert.equal(invoke('timeGetTime',[],'winmm.dll'),invoke('GetTickCount'));

const keyOut=pointer(4),length=pointer(4),type=pointer(4);
assert.equal(adv('RegOpenKeyExA',[0x80000002,string('Software\\Blizzard Entertainment\\Warcraft III'),0,1,keyOut]),0);
const key=h.u32(keyOut),installName=string('InstallPath');h.w32(length,0);
assert.equal(adv('RegQueryValueExA',[key,installName,0,type,0,length]),0);assert.equal(h.u32(type),1);assert.equal(h.u32(length),'C:\\Warcraft III'.length+1);
const required=h.u32(length),value=pointer(64);h.zero(value,64);h.w8(value,0xaa);h.w32(length,2);
assert.equal(adv('RegQueryValueExA',[key,installName,0,type,value,length]),234);assert.equal(h.u32(length),required);assert.equal(h.u8(value),0xaa,'Small registry buffers remain untouched');
h.w32(length,64);assert.equal(adv('RegQueryValueExA',[key,installName,0,type,value,length]),0);assert.equal(h.cstr(value),'C:\\Warcraft III');
const number=pointer(4);h.w32(number,0x12345678);assert.equal(adv('RegSetValueExA',[key,string('test'),0,4,number,4]),0);h.w32(length,64);assert.equal(adv('RegQueryValueExA',[key,string('test'),0,type,value,length]),0);assert.equal(h.u32(value),0x12345678);assert.equal(h.u32(type),4);
const wideValue=wide('Азерот');assert.equal(adv('RegSetValueExW',[key,wide('Название'),0,1,wideValue,14]),0);h.w32(length,64);assert.equal(adv('RegQueryValueExW',[key,wide('Название'),0,type,value,length]),0);assert.equal(h.wide(value),'Азерот');

const klass=pointer(40);h.w32(klass+4,0x500000);h.w32(klass+36,string('GameWindow'));
const atom=user('RegisterClassA',[klass]);assert.ok(atom);
const recordCallback=h.call;
h.call=(address,args)=>{const result=recordCallback(address,args);return args[1]===0x47?user('DefWindowProcA',args):result;};
const hwnd=user('CreateWindowExA',[0,atom,string('Warcraft'),0,20,30,800,600,0,0,0,0xfeed]);assert.ok(hwnd);
assert.equal(callbacks[0].args[1],0x81);assert.equal(new DataView(callbacks[0].creation.buffer).getUint32(0,true),0xfeed);
assert.equal(callbacks[1].args[1],1);
assert.ok(callbacks.some(c=>c.args[0]===hwnd&&c.args[1]===5&&c.args[3]===(600<<16|800)),'Default WM_WINDOWPOSCHANGED sends WM_SIZE during creation');
const rectangle=pointer(16);assert.equal(user('GetClientRect',[hwnd,rectangle]),1);assert.equal(h.u32(rectangle+8),800);assert.equal(h.u32(rectangle+12),600);
const message=pointer(28);assert.equal(user('PeekMessageA',[message,0,0,0,0]),0);assert.throws(()=>user('GetMessageA',[message,0,0,0]),GuestFault);
assert.equal(user('PostMessageA',[hwnd,0x400,11,22]),1);assert.equal(user('GetMessageA',[message,0,0,0]),1);assert.equal(h.u32(message+4),0x400);user('DispatchMessageA',[message]);assert.deepEqual(callbacks.at(-1).args,[hwnd,0x400,11,22]);
user('PostQuitMessage',[9]);assert.equal(user('GetMessageA',[message,0,0,0]),0);assert.equal(h.u32(message+8),9);
const timer=user('SetTimer',[hwnd,10,100,0]);now+=101;assert.equal(user('PeekMessageA',[message,0,0,0,1]),1);assert.equal(h.u32(message+4),0x113);assert.equal(h.u32(message+8),timer);assert.equal(user('KillTimer',[hwnd,timer]),1);
// Movie playback resets window timer zero from its callback. This must keep
// exactly one timer and deliver ID zero, even though SetTimer returns success.
for(let i=0;i<100;i++){
  assert.ok(user('SetTimer',[hwnd,0,100,0]));now+=101;
  assert.equal(user('PeekMessageA',[message,hwnd,0x113,0x113,1]),1);
  assert.equal(h.u32(message+8),0);
  assert.equal(user('PeekMessageA',[message,hwnd,0x113,0x113,1]),0);
}
assert.equal(user('KillTimer',[hwnd,0]),1);now+=200;
assert.equal(user('PeekMessageA',[message,hwnd,0x113,0x113,1]),0);
const threadTimer=user('SetTimer',[0,0,100,0]);
now+=50;assert.equal(user('SetTimer',[0,threadTimer,100,0]),threadTimer);
h.registerContext(0x5555,2);h.currentCPU=0x5555;now+=101;
assert.equal(user('PeekMessageA',[message,0,0x113,0x113,1]),0,'Timer messages stay with their creating thread');
h.currentCPU=undefined;
assert.equal(user('PeekMessageA',[message,0,0x113,0x113,1]),1);assert.equal(h.u32(message+8),threadTimer);
assert.equal(user('PeekMessageA',[message,0,0x113,0x113,1]),0);
assert.equal(user('KillTimer',[0,threadTimer]),1);
assert.throws(()=>invoke('BitBlt',[0,0,0,0,0,0,0,0,0],'gdi32.dll'),GuestFault);
const dc=user('GetDC',[hwnd]);assert.ok(dc);assert.equal(user('ReleaseDC',[hwnd,dc]),1);
for(const [suffix,size,unit,modeSize,sizeOffset,bitsOffset] of [['A',424,1,156,36,104],['W',840,2,220,68,168]]){
  const device=pointer(size),mode=pointer(modeSize);h.w32(device,size);
  assert.equal(user('EnumDisplayDevices'+suffix,[0,0,device,0]),1);
  const name=suffix==='A'?h.cstr(device+4):h.wide(device+4);assert.equal(name,'\\\\.\\DISPLAY1');
  assert.equal(h.u32(device+4+160*unit),5);
  assert.equal(user('EnumDisplayDevices'+suffix,[0,1,device,0]),0);
  h.w16(mode+sizeOffset,modeSize);assert.equal(user('EnumDisplaySettings'+suffix,[0,0,mode]),1);
  assert.equal(h.u32(mode+bitsOffset),32);assert.equal(h.u32(mode+bitsOffset+4),640);assert.equal(h.u32(mode+bitsOffset+8),480);
  assert.equal(user('EnumDisplaySettings'+suffix,[0,99,mode]),0);
}
user('ShowWindow',[hwnd,5]);
const beforeResize=callbacks.length;
user('SetWindowPos',[hwnd,0,0,0,1024,768,0x16]);
assert.ok(callbacks.slice(beforeResize).some(c=>c.args[1]===5&&c.args[3]===(768<<16|1024)));
const beforeMove=callbacks.length;
user('SetWindowPos',[hwnd,0,40,50,0,0,0x15]);
assert.ok(callbacks.slice(beforeMove).some(c=>c.args[1]===3&&c.args[3]===(50<<16|40)));
assert.equal(callbacks.slice(beforeMove).some(c=>c.args[1]===5),false,'SWP_NOSIZE suppresses WM_SIZE');
// A quick down/up may already be in the browser queue before the guest reads
// either message. GetKeyState follows the removed message, not physical input.
h.injectInput({type:'keydown',keyCode:65,text:'a'});h.injectInput({type:'keyup',keyCode:65});
assert.equal(user('GetAsyncKeyState',[65]),1);assert.equal(user('GetAsyncKeyState',[65]),0);
assert.equal(user('GetKeyState',[65]),0);
assert.equal(user('PeekMessageA',[message,hwnd,0x100,0x101,0]),1);assert.equal(user('GetKeyState',[65]),0);
assert.equal(user('PeekMessageA',[message,hwnd,0x100,0x101,1]),1);assert.equal(user('GetKeyState',[65]),0x8000);
assert.equal(user('PeekMessageA',[message,hwnd,0x100,0x101,1]),1);assert.equal(user('GetKeyState',[65]),0);
h.injectInput({type:'pointerdown',button:0,x:.5,y:.5});h.injectInput({type:'pointerup',button:0,x:.5,y:.5});
assert.equal(user('PeekMessageA',[message,hwnd,0x201,0x202,1]),1);assert.equal(user('GetKeyState',[1]),0x8000);
assert.equal(user('PeekMessageA',[message,hwnd,0x201,0x202,1]),1);assert.equal(user('GetKeyState',[1]),0);
// The canvas shows the whole emulated screen and a Windows cursor never leaves
// it: a locked or clamped pointer at the right edge is the last column.
h.injectInput({type:'pointermove',x:1,y:-.25});
assert.equal(user('PeekMessageA',[message,hwnd,0x200,0x200,1]),1);assert.equal(h.u32(message+12),1023,'x=1023, y=0 in the 1024x768 window');
// IMM contexts are stateful. Warcraft restores the default with IACE_DEFAULT
// during normal Quit; child-only association must not alter owned popups or
// descendants belonging to another guest thread.
const imm=(name,args=[])=>invoke(name,args,'imm32.dll');
const defaultIme=imm('ImmGetContext',[hwnd]);assert.ok(defaultIme);
const customIme=imm('ImmCreateContext'),otherIme=imm('ImmCreateContext');
for(const context of [defaultIme,customIme,otherIme])assert.equal(imm('ImmGetOpenStatus',[context]),0,'New input contexts start closed');
let notificationCount=callbacks.filter(item=>item.args[1]===0x282).length;
assert.equal(imm('ImmSetOpenStatus',[defaultIme,123]),1);assert.equal(imm('ImmGetOpenStatus',[defaultIme]),1);
assert.deepEqual(callbacks.at(-1).args,[hwnd,0x282,8,0],'Opening the focused input context sends IMN_SETOPENSTATUS');
assert.equal(imm('ImmSetOpenStatus',[defaultIme,1]),1);
assert.equal(callbacks.filter(item=>item.args[1]===0x282).length,notificationCount+1,'An unchanged status does not duplicate notifications');
assert.equal(imm('ImmGetOpenStatus',[customIme]),0,'Independent context state stays closed');
assert.equal(imm('ImmSetOpenStatus',[defaultIme,0]),1);assert.equal(imm('ImmGetOpenStatus',[defaultIme]),0);
const imeChild=parent=>user('CreateWindowExA',[0,atom,string('IME child'),0x40000000,0,0,100,100,parent,0,0,0]);
const child=imeChild(hwnd),grandchild=imeChild(child);
const owned=user('CreateWindowExA',[0,atom,string('Owned popup'),0x80000000,0,0,100,100,hwnd,0,0,0]);
h.currentCPU=0x5555;
const foreignChild=imeChild(hwnd),foreignIme=imm('ImmGetContext',[foreignChild]);
h.currentCPU=undefined;
assert.notEqual(foreignIme,defaultIme,'Default contexts belong to creating threads');
assert.equal(imm('ImmGetContext',[child]),defaultIme);
assert.equal(imm('ImmSetOpenStatus',[defaultIme,1]),1);assert.equal(imm('ImmGetOpenStatus',[imm('ImmGetContext',[child])]),1,'Windows sharing a context share open status');
assert.equal(imm('ImmSetOpenStatus',[defaultIme,0]),1);
assert.equal(imm('ImmSetOpenStatus',[foreignIme,1]),0,'A foreign thread context cannot be modified');
assert.equal(imm('ImmGetOpenStatus',[foreignIme]),0);
assert.equal(imm('ImmAssociateContext',[hwnd,customIme]),defaultIme);
assert.equal(imm('ImmGetContext',[hwnd]),customIme);
assert.equal(imm('ImmDestroyContext',[customIme]),0,'Associated contexts cannot be destroyed');
assert.equal(imm('ImmAssociateContextEx',[hwnd,0,0]),1);assert.equal(imm('ImmGetContext',[hwnd]),0);
assert.equal(imm('ImmAssociateContextEx',[hwnd,0xdeadbeef,0x10]),1,'IACE_DEFAULT ignores HIMC');
assert.equal(imm('ImmGetContext',[hwnd]),defaultIme);
assert.equal(imm('ImmAssociateContextEx',[hwnd,customIme,1]),1);
assert.equal(imm('ImmGetContext',[hwnd]),defaultIme,'IACE_CHILDREN excludes the parent');
assert.equal(imm('ImmGetContext',[child]),customIme);assert.equal(imm('ImmGetContext',[grandchild]),customIme);
assert.equal(imm('ImmGetContext',[foreignChild]),foreignIme);assert.equal(imm('ImmGetContext',[owned]),defaultIme);
const laterChild=imeChild(hwnd);assert.equal(imm('ImmGetContext',[laterChild]),defaultIme,'Later child windows keep their default context');
assert.equal(imm('ImmAssociateContext',[child,0]),customIme);
assert.equal(imm('ImmAssociateContextEx',[hwnd,otherIme,0x21]),1);
assert.equal(imm('ImmGetContext',[child]),0,'IACE_IGNORENOCONTEXT preserves disabled windows');
assert.equal(imm('ImmGetContext',[grandchild]),otherIme);assert.equal(imm('ImmGetContext',[laterChild]),otherIme);
assert.equal(imm('ImmAssociateContextEx',[child,0,0x30]),1);assert.equal(imm('ImmGetContext',[child]),0);
assert.equal(imm('ImmAssociateContextEx',[hwnd,0,0x11]),1);
for(const id of [child,grandchild,laterChild])assert.equal(imm('ImmGetContext',[id]),defaultIme);
for(const args of [[hwnd,customIme,2],[hwnd,0xdeadbeef,0],[hwnd,foreignIme,0],[0xdeadbeef,0,0x10]])assert.equal(imm('ImmAssociateContextEx',args),0);
assert.equal(imm('ImmGetContext',[hwnd]),defaultIme,'Failed association leaves the window unchanged');
assert.equal(imm('ImmReleaseContext',[hwnd,defaultIme]),1);
assert.equal(imm('ImmDestroyContext',[defaultIme]),0,'The default context is thread-owned');
assert.equal(imm('ImmDestroyContext',[customIme]),1);assert.equal(imm('ImmDestroyContext',[otherIme]),1);
assert.equal(imm('ImmAssociateContextEx',[hwnd,customIme,0]),0,'Destroyed context handles are rejected');
for(const context of [0,0xdeadbeef,hwnd,customIme]){
  assert.equal(imm('ImmGetOpenStatus',[context]),0);assert.equal(h.lastError,6);
  assert.equal(imm('ImmSetOpenStatus',[context,1]),0);assert.equal(h.lastError,6);
}
assert.equal(imm('ImmGetOpenStatus',[defaultIme]),0,'Invalid operations do not alter live contexts');
for(const id of [grandchild,child,laterChild,foreignChild,owned])assert.equal(user('DestroyWindow',[id]),1);
const popup=user('CreateWindowExA',[0,atom,string('Video'),0x90000000,0,0,800,600,0,0,0,0]);
assert.equal(user('GetActiveWindow'),popup);assert.equal(user('GetFocus'),popup);
assert.equal(user('DestroyWindow',[popup]),1);assert.equal(user('GetActiveWindow'),hwnd);assert.equal(user('GetFocus'),hwnd);
assert.deepEqual(callbacks.at(-1).args,[hwnd,7,popup,0],'Destroying the video popup restores focus to the game');
assert.equal(user('DestroyWindow',[hwnd]),1);assert.equal(user('IsWindow',[hwnd]),0);

const library=invoke('LoadLibraryA',[string('kernel32.dll')]);assert.ok(library);
assert.ok(invoke('GetProcAddress',[library,string('GetTickCount')]));
assert.equal(invoke('GetProcAddress',[library,string('MissingFunction')]),0);assert.equal(h.lastError,127);

const formatted=pointer(128),allocated=pointer(4);
assert.ok(invoke('FormatMessageA',[0x1200,0,2,0,formatted,128,0]));assert.match(h.cstr(formatted),/cannot find the file/);
assert.equal(invoke('FormatMessageA',[0x1200,0,0xdead,0,formatted,128,0]),0);assert.equal(h.lastError,317);
const insertions=pointer(8);h.w32(insertions,string('test'));h.w32(insertions+4,0x2a);
assert.equal(invoke('FormatMessageA',[0x2500,string('%1!s! %2!04X!'),0,0,allocated,0,insertions]),9);assert.equal(h.cstr(h.u32(allocated)),'test 002A');assert.equal(invoke('LocalFree',[h.u32(allocated)]),0);
const russian=wide('Азерот'),encoded=pointer(32),decoded=pointer(64),usedDefault=pointer(4);
assert.equal(invoke('WideCharToMultiByte',[1251,0,russian,0xffffffff,encoded,32,0,usedDefault]),7);assert.equal(h.u32(usedDefault),0);
assert.equal(invoke('MultiByteToWideChar',[1251,0,encoded,0xffffffff,decoded,32]),7);assert.equal(h.wide(decoded),'Азерот');

const image=h.allocAligned(4096,4096);h.w16(image,0x5a4d);h.w32(image+0x3c,0x80);h.w32(image+0x80,0x4550);h.w16(image+0x98,0x10b);h.w32(image+0x98+56,4096);h.w32(image+0x98+112,0x300);h.w32(image+0x98+116,0x300);
for(const[offset,id,child]of[[0,6,0x80000020],[0x20,1,0x80000040],[0x40,1033,0x60]]){h.w16(image+0x300+offset+14,1);h.w32(image+0x300+offset+16,id);h.w32(image+0x300+offset+20,child);}
h.w32(image+0x360,0x400);let resourceOffset=0;
for(let id=0;id<16;id++){const value=id===3?'Resource':'';h.w16(image+0x400+resourceOffset,value.length);resourceOffset+=2;for(let j=0;j<value.length;j++){h.w16(image+0x400+resourceOffset,value.charCodeAt(j));resourceOffset+=2;}}
h.w32(image+0x364,resourceOffset);
assert.equal(user('LoadStringA',[image,3,formatted,128]),8);assert.equal(h.cstr(formatted),'Resource');
const resourceHandle=invoke('FindResourceA',[image,1,6]);assert.ok(resourceHandle);assert.equal(invoke('SizeofResource',[image,resourceHandle]),resourceOffset);assert.equal(invoke('LockResource',[invoke('LoadResource',[image,resourceHandle])]),image+0x400);
const localeBuffer=h.alloc(64);
assert.equal(invoke('GetLocaleInfoA',[0x400,7,0,0]),4);
assert.equal(invoke('GetLocaleInfoA',[0x400,7,localeBuffer,64]),4);assert.equal(h.cstr(localeBuffer),'USA');
assert.equal(invoke('GetLocaleInfoA',[0x409,7,localeBuffer,3]),0);assert.equal(h.lastError,122);
assert.equal(invoke('GetLocaleInfoW',[0x800,0x1004|0x20000000,localeBuffer,2]),2);assert.equal(h.u32(localeBuffer),1252);
assert.equal(invoke('GetLocaleInfoA',[0x409,1|0x20000000,localeBuffer,4]),4);assert.equal(h.u32(localeBuffer),0x409);
assert.equal(invoke('GetLocaleInfoW',[0x409,7,localeBuffer,4]),4);assert.equal(h.wide(localeBuffer),'USA');
assert.equal(invoke('GetLocaleInfoA',[0x409,7|0x20000000,localeBuffer,64]),0);assert.equal(h.lastError,1004);
assert.equal(invoke('GetLocaleInfoA',[0xffff,7,localeBuffer,64]),0);assert.equal(h.lastError,87);
console.log('kernel_host_test: heap, TLS, atomics, synchronization, files/ranges, registry, locales, windows/messages and explicit unsupported services passed');
