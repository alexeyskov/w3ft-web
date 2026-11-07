// Explicit OpenGL 1.1 fixed-function subset translated to WebGL 2 shaders.
// Missing state is an error: unsupported legacy calls must never succeed silently.
export const GL=Object.freeze({POINTS:0,LINES:1,LINE_LOOP:2,LINE_STRIP:3,TRIANGLES:4,
  TRIANGLE_STRIP:5,TRIANGLE_FAN:6,QUADS:7,DEPTH_BUFFER_BIT:0x100,COLOR_BUFFER_BIT:0x4000,
  MODELVIEW:0x1700,PROJECTION:0x1701,TEXTURE:0x1702,TEXTURE_2D:0x0de1,
  BLEND:0x0be2,DEPTH_TEST:0x0b71,CULL_FACE:0x0b44,SCISSOR_TEST:0x0c11,ALPHA_TEST:0x0bc0,
  FOG:0x0b60,FOG_DENSITY:0x0b62,FOG_START:0x0b63,FOG_END:0x0b64,FOG_MODE:0x0b65,FOG_COLOR:0x0b66,
  NEAREST:0x2600,LINEAR:0x2601,CLAMP:0x2900,CLAMP_TO_BORDER:0x812d,CLAMP_TO_EDGE:0x812f,REPEAT:0x2901,MIRRORED_REPEAT:0x8370,EXP:0x0800,EXP2:0x0801,
  LIGHTING:0x0b50,LIGHT0:0x4000,COLOR_MATERIAL:0x0b57,NORMALIZE:0x0ba1,RESCALE_NORMAL:0x803a,
  AMBIENT:0x1200,DIFFUSE:0x1201,SPECULAR:0x1202,POSITION:0x1203,SPOT_DIRECTION:0x1204,
  SPOT_EXPONENT:0x1205,SPOT_CUTOFF:0x1206,CONSTANT_ATTENUATION:0x1207,LINEAR_ATTENUATION:0x1208,QUADRATIC_ATTENUATION:0x1209,
  EMISSION:0x1600,SHININESS:0x1601,AMBIENT_AND_DIFFUSE:0x1602,
  LIGHT_MODEL_LOCAL_VIEWER:0x0b51,LIGHT_MODEL_TWO_SIDE:0x0b52,LIGHT_MODEL_AMBIENT:0x0b53,
  FRONT:0x0404,BACK:0x0405,FRONT_AND_BACK:0x0408,FLAT:0x1d00,SMOOTH:0x1d01,
  TEXTURE_GEN_S:0x0c60,TEXTURE_GEN_T:0x0c61,TEXTURE_GEN_R:0x0c62,TEXTURE_GEN_Q:0x0c63,
  S:0x2000,T:0x2001,R:0x2002,Q:0x2003,TEXTURE_GEN_MODE:0x2500,OBJECT_PLANE:0x2501,EYE_PLANE:0x2502,
  OBJECT_LINEAR:0x2401,EYE_LINEAR:0x2400,SPHERE_MAP:0x2402,NORMAL_MAP:0x8511,REFLECTION_MAP:0x8512,
  RGBA:0x1908,RGB:0x1907,ALPHA:0x1906,LUMINANCE:0x1909,LUMINANCE_ALPHA:0x190a,
  BGR:0x80e0,BGRA:0x80e1,UNSIGNED_BYTE:0x1401,UNSIGNED_SHORT:0x1403,UNSIGNED_INT:0x1405,FLOAT:0x1406,UNPACK_ALIGNMENT:0x0cf5,
  TEXTURE_ENV:0x2300,TEXTURE_ENV_MODE:0x2200,MODULATE:0x2100,REPLACE:0x1e01,
  DECAL:0x2101,ADD:0x0104,NEVER:0x0200,LESS:0x0201,EQUAL:0x0202,LEQUAL:0x0203,
  GREATER:0x0204,NOTEQUAL:0x0205,GEQUAL:0x0206,ALWAYS:0x0207});

export class GraphicsError extends Error {
  constructor(operation,message){super(`OpenGL ${operation}: ${message}`);this.name='GraphicsError';this.operation=operation;}
}
const unsupported=(operation,value)=>{throw new GraphicsError(operation,`unsupported value ${value} (0x${Number(value).toString(16)})`);};
const finite=(operation,values)=>{if(!values.every(Number.isFinite))throw new GraphicsError(operation,'finite numeric values required');};
export function mat4Identity(){return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);}
export function mat4Multiply(a,b){
  if(a.length!==16||b.length!==16)throw new GraphicsError('matrix','16 components required');
  const result=new Float32Array(16);
  for(let column=0;column<4;column++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)result[column*4+row]+=a[k*4+row]*b[column*4+k];
  return result;
}
export function transformVertex(matrix,vertex){
  if(matrix.length!==16||vertex.length!==4)throw new GraphicsError('transform','mat4 and vec4 required');
  return new Float32Array([0,1,2,3].map(row=>matrix[row]*vertex[0]+matrix[4+row]*vertex[1]+matrix[8+row]*vertex[2]+matrix[12+row]*vertex[3]));
}
export function normalMatrix(m){
  const[a,b,c,d,e,f,g,h,i]=[m[0],m[4],m[8],m[1],m[5],m[9],m[2],m[6],m[10]],det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if(!det)throw new GraphicsError('normal matrix','singular modelview');
  return new Float32Array([e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d].map(v=>v/det));
}
export function mat4Inverse(m){
  const rows=Array.from({length:4},(_,r)=>[m[r],m[4+r],m[8+r],m[12+r],...Array.from({length:4},(_,c)=>r===c?1:0)]);
  for(let c=0;c<4;c++){
    let pivot=c;for(let r=c+1;r<4;r++)if(Math.abs(rows[r][c])>Math.abs(rows[pivot][c]))pivot=r;
    if(!rows[pivot][c])throw new GraphicsError('matrix inverse','singular matrix');
    [rows[c],rows[pivot]]=[rows[pivot],rows[c]];
    const scale=rows[c][c];rows[c]=rows[c].map(v=>v/scale);
    for(let r=0;r<4;r++)if(r!==c){const factor=rows[r][c];rows[r]=rows[r].map((v,j)=>v-factor*rows[c][j]);}
  }
  return new Float32Array(Array.from({length:16},(_,i)=>rows[i%4][4+Math.floor(i/4)]));
}
const normalTransform=(m,v)=>[0,1,2].map(i=>m[i]*v[0]+m[3+i]*v[1]+m[6+i]*v[2]);
const normalize=v=>{const length=Math.hypot(...v);return length?v.map(x=>x/length):[0,0,0];};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const clamp=v=>Math.min(1,Math.max(0,v));
const materialDefaults=()=>({ambient:[.2,.2,.2,1],diffuse:[.8,.8,.8,1],specular:[0,0,0,1],emission:[0,0,0,1],shininess:0});
const materialProperty=new Map([[GL.AMBIENT,'ambient'],[GL.DIFFUSE,'diffuse'],[GL.SPECULAR,'specular'],[GL.EMISSION,'emission']]);
const textureDefaults=handle=>({handle,width:0,height:0,levels:new Map(),minFilter:0x2702,magFilter:GL.LINEAR,wrapS:GL.REPEAT,wrapT:GL.REPEAT,borderColor:[0,0,0,0]});
// Fixed-function per-vertex lighting (OpenGL 2.1 sections 2.11 and 2.14) is
// evaluated here instead of in JavaScript for every vertex of every draw.
// The packed u_light layout mirrors _lightingData(); _litColors() remains the
// double-precision reference implementation used by the pixel tests.
const LIGHT_VECTORS=61;
const VERTEX=`#version 300 es
in vec4 a_position;
in vec4 a_color;
in vec3 a_normal;
in vec4 a_texcoord;
in vec4 a_texcoord1;
uniform mat4 u_modelview;
uniform mat4 u_projection;
uniform mat4 u_textureMatrix;
uniform mat4 u_textureMatrix1;
uniform bool u_lighting;
uniform mat3 u_normalMatrix;
uniform vec4 u_light[${LIGHT_VECTORS}];
out vec4 v_color;
out vec4 v_backColor;
flat out vec4 v_flatColor;
flat out vec4 v_flatBackColor;
out vec4 v_texcoord;
out vec4 v_texcoord1;
out float v_eyeZ;
vec3 safeNormalize(vec3 v){float l=length(v);return l>0.0?v/l:vec3(0.0);}
float safePow(float x,float y){return y==0.0?1.0:(x<=0.0?0.0:pow(x,y));}
vec4 shade(int face,vec3 p,vec3 n,vec4 color){
 int base=3+face*5,track=int(u_light[base+4].y);
 vec4 ambient=(track&1)!=0?color:u_light[base];
 vec4 diffuse=(track&2)!=0?color:u_light[base+1];
 vec4 specular=(track&4)!=0?color:u_light[base+2];
 vec4 emission=(track&8)!=0?color:u_light[base+3];
 float shininess=u_light[base+4].x;
 vec3 rgb=emission.rgb+ambient.rgb*u_light[0].rgb;
 vec3 viewer=u_light[1].z>0.5?safeNormalize(-p):vec3(0.0,0.0,1.0);
 int count=int(u_light[1].x);
 for(int i=0;i<8;i++){
  if(i>=count)break;
  int l=13+i*6;
  vec4 position=u_light[l+3],k=u_light[l+5],spot=u_light[l+4];
  bool directional=position.w==0.0;
  vec3 delta=directional?position.xyz:position.xyz/position.w-p;
  vec3 direction=safeNormalize(delta);
  float distance=length(delta),attenuation=directional?1.0:1.0/(k.x+k.y*distance+k.z*distance*distance);
  if(spot.w>-1.5){float cosine=dot(-direction,safeNormalize(spot.xyz));attenuation*=cosine<spot.w?0.0:safePow(max(0.0,cosine),k.w);}
  float ndotl=max(0.0,dot(n,direction));
  float highlight=ndotl>0.0?safePow(max(0.0,dot(n,safeNormalize(direction+viewer))),shininess):0.0;
  rgb+=attenuation*(ambient.rgb*u_light[l].rgb+diffuse.rgb*u_light[l+1].rgb*ndotl+specular.rgb*u_light[l+2].rgb*highlight);
 }
 return vec4(clamp(rgb,0.0,1.0),clamp(diffuse.a,0.0,1.0));
}
void main(){
 vec4 eye=u_modelview*a_position;gl_Position=u_projection*eye;v_eyeZ=eye.z;gl_PointSize=1.0;
 vec4 front,back;
 if(u_lighting){
  vec3 p=eye.xyz/eye.w,n=u_normalMatrix*a_normal;
  if(u_light[1].w>0.5)n=safeNormalize(n);
  front=shade(0,p,n,a_color);
  back=u_light[1].y>0.5?shade(1,p,-n,a_color):front;
 }else front=back=clamp(a_color,0.0,1.0);
 v_color=v_flatColor=front;v_backColor=v_flatBackColor=back;
 v_texcoord=u_textureMatrix*a_texcoord;v_texcoord1=u_textureMatrix1*a_texcoord1;
}`;
// Client arrays: raw guest layouts are uploaded unchanged and WebGL performs
// the type conversion. Legacy callers may still pass tight Float32Arrays.
const ATTRIBUTES=[
  {kind:'position',location:0,legacy:'positions',sizeKey:'positionSize',size:3},
  {kind:'color',location:1,legacy:'colors',sizeKey:'colorSize',size:4},
  {kind:'normal',location:2,legacy:'normals',sizeKey:null,size:3},
  {kind:'texcoord',location:3,legacy:'texcoords',sizeKey:'texcoordSize',size:2},
  {kind:'texcoord1',location:4,legacy:'texcoords1',sizeKey:'texcoordSize1',size:2},
];
const align4=value=>(value+3)&~3;
// Tight Float32Array copy of one client array, for the CPU-only paths
// (texture coordinate generation and diagnostic frame capture).
function floatArray(attributes,spec,vertexCount){
  const raw=attributes.raw?.[spec.kind];
  if(!raw){const values=attributes[spec.legacy];return values===undefined?undefined:{values,size:spec.sizeKey?attributes[spec.sizeKey]??spec.size:spec.size};}
  const {bytes,offset=0,type,size,stride}=raw,width=type===GL.FLOAT?4:1,values=new Float32Array(vertexCount*size);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let vertex=0;vertex<vertexCount;vertex++)for(let component=0;component<size;component++){
    const at=offset+vertex*stride+component*width;values[vertex*size+component]=type===GL.FLOAT?view.getFloat32(at,true):view.getUint8(at)/255;
  }
  return {values,size};
}
// Converts raw client arrays ({raw:{position,...}}) to the legacy Float32Array
// attribute object ({positions,positionSize,colors,...}).
export function floatAttributes(attributes,vertexCount){
  const result={};
  for(const spec of ATTRIBUTES){const array=floatArray(attributes,spec,vertexCount);if(array){result[spec.legacy]=array.values;if(spec.sizeKey)result[spec.sizeKey]=array.size;}}
  return result;
}
const TEXTURE_SHADER=`
in vec4 v_texcoord;
uniform sampler2D u_texture;
uniform bool u_textured;
uniform int u_texenv;
uniform int u_texformat;
uniform ivec2 u_textureWrap;
uniform ivec2 u_textureFilters;
uniform vec4 u_textureBorder;
uniform int u_textureMaxMip;
// GL 1.x CLAMP blends the edge texel with the border at s/t = 0 and 1.
// WebGL only provides CLAMP_TO_EDGE. Explicit taps retain the original border
// semantics at every mip level, including mixed wrapping on the two axes.
float wrapCoordinate(float s,int mode,float size){
 if(mode==10496)return clamp(s,0.0,1.0);
 if(mode==10497)return fract(s);
 if(mode==33648)return 1.0-abs(mod(s,2.0)-1.0);
 if(mode==33069)return clamp(s,-0.5/size,1.0+0.5/size);
 return clamp(s,0.5/size,1.0-0.5/size);
}
int wrapIndex(int i,int mode,int size,bool linearFilter){
 if(mode==10497)return (i%size+size)%size;
 if(mode==33071||mode==33648||(mode==10496&&!linearFilter))return clamp(i,0,size-1);
 return i;
}
vec4 texel(ivec2 p,ivec2 size,int level,bool linearFilter){
 p=ivec2(wrapIndex(p.x,u_textureWrap.x,size.x,linearFilter),wrapIndex(p.y,u_textureWrap.y,size.y,linearFilter));
 if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,size)))return u_textureBorder;
 return texelFetch(u_texture,p,level);
}
vec4 sampleLevel(vec2 uv,int level,bool linearFilter){
 ivec2 size=textureSize(u_texture,level);
 vec2 p=vec2(wrapCoordinate(uv.x,u_textureWrap.x,float(size.x)),wrapCoordinate(uv.y,u_textureWrap.y,float(size.y)))*vec2(size);
 if(!linearFilter)return texel(ivec2(floor(p)),size,level,false);
 p-=0.5;ivec2 i=ivec2(floor(p));vec2 f=fract(p);
 return mix(mix(texel(i,size,level,true),texel(i+ivec2(1,0),size,level,true),f.x),
            mix(texel(i+ivec2(0,1),size,level,true),texel(i+ivec2(1,1),size,level,true),f.x),f.y);
}
vec4 sampleTexture(){
 if(all(notEqual(u_textureWrap,ivec2(10496)))&&all(notEqual(u_textureWrap,ivec2(33069))))return textureProj(u_texture,v_texcoord);
 vec2 uv=v_texcoord.xy/v_texcoord.w,scale=vec2(textureSize(u_texture,0));
 float lod=log2(max(max(length(dFdx(uv)*scale),length(dFdy(uv)*scale)),1e-20));
 int minFilter=u_textureFilters.x,magFilter=u_textureFilters.y;
 float transition=magFilter==9729&&(minFilter==9984||minFilter==9986)?0.5:0.0;
 if(lod<=transition)return sampleLevel(uv,0,magFilter==9729);
 if(minFilter==9728||minFilter==9729)return sampleLevel(uv,0,minFilter==9729);
 bool linearFilter=minFilter==9985||minFilter==9987;
 lod=clamp(lod,0.0,float(u_textureMaxMip));
 if(minFilter==9984||minFilter==9985)return sampleLevel(uv,max(0,int(ceil(lod+0.5))-1),linearFilter);
 int lower=int(floor(lod));return mix(sampleLevel(uv,lower,linearFilter),sampleLevel(uv,min(lower+1,u_textureMaxMip),linearFilter),fract(lod));
}
`;
const NATIVE_TEXTURE_SHADER=`
in vec4 v_texcoord;
uniform sampler2D u_texture;
uniform bool u_textured;
uniform int u_texenv;
uniform int u_texformat;
vec4 sampleTexture(){return textureProj(u_texture,v_texcoord);}
`;
const textureShader=(unit,native)=> (native?NATIVE_TEXTURE_SHADER:TEXTURE_SHADER).replace(/\b(u_texture\w*|u_textured|u_texenv|u_texformat|v_texcoord|wrapCoordinate|wrapIndex|texel|sampleLevel|sampleTexture)\b/g,name=>name+(unit||''));
const fragmentShader=native=>`#version 300 es
precision highp float;
in vec4 v_color;
in vec4 v_backColor;
flat in vec4 v_flatColor;
flat in vec4 v_flatBackColor;
in float v_eyeZ;
uniform bool u_alphaTest;
uniform int u_alphaFunc;
uniform float u_alphaRef;
uniform bool u_fogEnabled;
uniform int u_fogMode;
uniform float u_fogDensity;
uniform float u_fogStart;
uniform float u_fogEnd;
uniform vec4 u_fogColor;
uniform bool u_flat;
out vec4 outputColor;
${textureShader(0,native)}
${textureShader(1,native)}
vec4 applyTexture(vec4 c,vec4 t,int mode,int format){
 if(mode==7681){
  if(format==3||format==1)return vec4(t.rgb,c.a);
  if(format==0)return vec4(c.rgb,t.a);
  return t;
 }
 if(mode==8449)return vec4(mix(c.rgb,t.rgb,t.a),c.a);
 if(mode==260)return vec4(format==0?c.rgb:c.rgb+t.rgb,c.a*t.a);
 return c*t;
}
void main(){
 vec4 c=gl_FrontFacing?(u_flat?v_flatColor:v_color):(u_flat?v_flatBackColor:v_backColor);
 if(u_textured)c=applyTexture(c,sampleTexture(),u_texenv,u_texformat);
 if(u_textured1)c=applyTexture(c,sampleTexture1(),u_texenv1,u_texformat1);
 if(u_alphaTest){bool pass=u_alphaFunc==519 ||
  (u_alphaFunc==513&&c.a<u_alphaRef)||(u_alphaFunc==514&&c.a==u_alphaRef)||
  (u_alphaFunc==515&&c.a<=u_alphaRef)||(u_alphaFunc==516&&c.a>u_alphaRef)||
  (u_alphaFunc==517&&c.a!=u_alphaRef)||(u_alphaFunc==518&&c.a>=u_alphaRef);
  if(!pass)discard;
 }
 if(u_fogEnabled){
  float distance=abs(v_eyeZ);
  float factor;
  if(u_fogMode==9729)factor=(u_fogEnd-distance)/(u_fogEnd-u_fogStart);
  else if(u_fogMode==2048)factor=exp(-u_fogDensity*distance);
  else{float exponent=u_fogDensity*distance;factor=exp(-exponent*exponent);}
  c.rgb=mix(u_fogColor.rgb,clamp(c.rgb,0.0,1.0),clamp(factor,0.0,1.0));
 }
 outputColor=c;
}`;

// Display gamma ramp pass (units 2 and 3; fixed function uses units 0 and 1).
const GAMMA_UNIT=2;
const GAMMA_VERTEX=`#version 300 es
out vec2 v_uv;
void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);v_uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}`;
const GAMMA_FRAGMENT=`#version 300 es
precision highp float;
uniform sampler2D u_scene,u_table;
in vec2 v_uv;
out vec4 o_color;
float ramp(float value,int channel){return texture(u_table,vec2((value*255.+.5)/256.,.5))[channel];}
void main(){vec4 c=texture(u_scene,v_uv);o_color=vec4(ramp(c.r,0),ramp(c.g,1),ramp(c.b,2),c.a);}`;

export class FixedFunctionGL {
  constructor(canvas,{context,debugChecks=false,legacyClampToEdge=false,nativeTextureShader=true}={}) {
    this.gl=context||canvas?.getContext('webgl2',{alpha:false,antialias:false,depth:true,preserveDrawingBuffer:true});
    if(!this.gl)throw new GraphicsError('create','WebGL 2 is unavailable');
    this.canvas=canvas;this.destroyed=false;this.mode=GL.MODELVIEW;this.draws=0;this.frames=0;
    this.debugChecks=debugChecks;this.checkedOperations=new Set();this.errorChecks=0;
    // Some contemporary Windows drivers treated GL_CLAMP as CLAMP_TO_EDGE.
    // Warcraft's 16x16 fog tiles rely on that behavior: their last UV is
    // 0.9765625, beyond the last texel center (0.96875). Strict border sampling
    // makes the dark overlay transparent at every tile seam. Keep strict GL
    // semantics by default and enable this driver compatibility in the game
    // profile. Explicit CLAMP_TO_BORDER and the queried guest state stay intact.
    this.legacyClampToEdge=legacyClampToEdge;
    this.nativeTextureShader=nativeTextureShader;this.nativeDraws=0;this.borderDraws=0;
    this.matrices=new Map([[GL.MODELVIEW,[mat4Identity()]],[GL.PROJECTION,[mat4Identity()]],[GL.TEXTURE,[mat4Identity()]]]);
    this.currentColor=new Float32Array([1,1,1,1]);this.currentTexcoord=new Float32Array([0,0,0,1]);
    this.texgen=Array.from({length:4},(_,i)=>({enabled:false,mode:GL.EYE_LINEAR,objectPlane:[0,1,2,3].map(j=>i===j?1:0),eyePlane:[0,1,2,3].map(j=>i===j?1:0)}));
    this.currentNormal=[0,0,1];this.shading=GL.SMOOTH;
    this.lighting={enabled:false,normalize:false,rescale:false,colorMaterial:false,colorFace:GL.FRONT_AND_BACK,colorMode:GL.AMBIENT_AND_DIFFUSE,
      ambient:[.2,.2,.2,1],localViewer:false,twoSide:false,materials:[materialDefaults(),materialDefaults()],
      lights:Array.from({length:8},(_,i)=>({enabled:false,ambient:[0,0,0,1],diffuse:i?[0,0,0,1]:[1,1,1,1],specular:i?[0,0,0,1]:[1,1,1,1],position:[0,0,1,0],direction:[0,0,-1],exponent:0,cutoff:180,attenuation:[1,0,0]}))};
    this.textured=false;this.alphaTest=false;this.alphaFunction=GL.ALWAYS;this.alphaReference=0;
    this.fog={enabled:false,mode:GL.EXP,density:1,start:0,end:1,color:new Float32Array([0,0,0,0])};
    this.textureEnvironment=GL.MODULATE;this.textures=new Map();this.nextTexture=1;this.boundTexture=0;this.unpackAlignment=4;this.unpackRowLength=0;this.unpackSkipRows=0;this.unpackSkipPixels=0;this.unpackSwapBytes=false;this.unpackLSBFirst=false;this.immediate=null;
    this.activeUnit=0;
    this.textureUnits=Array.from({length:2},()=>({textured:false,boundTexture:0,textureEnvironment:GL.MODULATE,currentTexcoord:new Float32Array([0,0,0,1]),matrix:[mat4Identity()],
      texgen:Array.from({length:4},(_,i)=>({enabled:false,mode:GL.EYE_LINEAR,objectPlane:[0,1,2,3].map(j=>i===j?1:0),eyePlane:[0,1,2,3].map(j=>i===j?1:0)}))}));
    for(const key of ['textured','boundTexture','textureEnvironment','currentTexcoord','texgen'])Object.defineProperty(this,key,{get:()=>this.textureUnits[this.activeUnit][key],set:value=>{this.textureUnits[this.activeUnit][key]=value;}});
    const gl=this.gl;
    // A new virtual WGL context starts with OpenGL defaults even when the
    // underlying canvas survives deletion of an earlier context.
    for(const cap of [gl.BLEND,gl.CULL_FACE,gl.DEPTH_TEST,gl.SCISSOR_TEST,gl.STENCIL_TEST,gl.POLYGON_OFFSET_FILL])gl.disable(cap);
    gl.enable(gl.DITHER);gl.blendFunc(gl.ONE,gl.ZERO);gl.depthFunc(gl.LESS);gl.depthMask(true);gl.depthRange(0,1);
    gl.colorMask(true,true,true,true);gl.cullFace(gl.BACK);gl.frontFace(gl.CCW);gl.clearColor(0,0,0,0);gl.clearDepth(1);
    gl.viewport(0,0,canvas.width,canvas.height);gl.scissor(0,0,canvas.width,canvas.height);gl.activeTexture(gl.TEXTURE0);
    // Shadow of the WebGL state set above. Every WebGL call is validated and
    // serialized for the GPU process, so repeated identical guest state changes
    // (Warcraft re-specifies most state for every model) are filtered here.
    this.glCaps=new Map([[gl.BLEND,false],[gl.CULL_FACE,false],[gl.DEPTH_TEST,false],[gl.SCISSOR_TEST,false],[gl.POLYGON_OFFSET_FILL,false],[gl.DITHER,true]]);
    this.glState={blend:[gl.ONE,gl.ZERO],depthFunc:gl.LESS,depthMask:true,cullFace:gl.BACK,frontFace:gl.CCW,colorMask:[true,true,true,true],
      clearColor:[0,0,0,0],clearDepth:1,viewport:[0,0,canvas.width,canvas.height],scissor:[0,0,canvas.width,canvas.height]};
    this.glActiveUnit=0;this.glBound=[undefined,undefined];this.lightingVersion=1;this.maxTextureSize=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // Guest GL calls arrive in separate Worker tasks. A browser may present or
    // discard its default drawing buffer between those tasks, whereas desktop
    // WGL preserves the back buffer until the application swaps a whole frame.
    this.backbuffer=gl.createFramebuffer();this.backColor=gl.createRenderbuffer();this.backDepth=gl.createRenderbuffer();
    this._resizeBackbuffer();
    const compile=(type,source)=>{const shader=gl.createShader(type);if(!shader)throw new GraphicsError('compileShader','allocation failed');gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const log=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new GraphicsError('compileShader',log||'unknown compiler failure');}return shader;};
    const vertex=compile(gl.VERTEX_SHADER,VERTEX),attributeNames=ATTRIBUTES.map(a=>a.kind);
    const uniformNames=['modelview','projection','textureMatrix','texture','textured','texenv','texformat','textureWrap','textureFilters','textureBorder','textureMaxMip','alphaTest','alphaFunc','alphaRef','fogEnabled','fogMode','fogDensity','fogStart','fogEnd','fogColor','flat','lighting','normalMatrix','light',...['textureMatrix','texture','textured','texenv','texformat','textureWrap','textureFilters','textureBorder','textureMaxMip'].map(n=>n+'1')];
    const link=native=>{
      const fragment=compile(gl.FRAGMENT_SHADER,fragmentShader(native)),program=gl.createProgram();
      gl.attachShader(program,vertex);gl.attachShader(program,fragment);
      // Both programs share a VAO, including constant attributes. Fix locations
      // before linking so a program switch cannot reinterpret existing arrays.
      attributeNames.forEach((name,index)=>gl.bindAttribLocation(program,index,`a_${name}`));
      gl.linkProgram(program);gl.deleteShader(fragment);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)){const log=gl.getProgramInfoLog(program);gl.deleteProgram(program);throw new GraphicsError('linkProgram',log||'unknown linker failure');}
      // Uniform values are program state: each program keeps its own cache.
      return{program,uniforms:Object.fromEntries(uniformNames.map(name=>[name,gl.getUniformLocation(program,`u_${name}`)])),cache:Object.create(null)};
    };
    this.borderProgram=link(false);this.nativeProgram=nativeTextureShader?link(true):null;gl.deleteShader(vertex);
    this.program=this.borderProgram.program;this.uniforms=this.borderProgram.uniforms;this.uniformCache=this.borderProgram.cache;this.currentProgram=null;
    this.attributes=Object.fromEntries(attributeNames.map((name,index)=>[name,index]));
    // One streaming vertex buffer receives all client arrays of a draw in a
    // single upload; attribute pointers select the original guest layouts.
    this.vao=gl.createVertexArray();this.buffers={vertex:gl.createBuffer(),index:gl.createBuffer()};
    gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.buffers.index);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffers.vertex);
    this.attributeState=ATTRIBUTES.map(()=>({enabled:false,pointer:null,constant:null}));this.uploadScratch=new Uint8Array(65536);this.lightData=new Float32Array(LIGHT_VECTORS*4);
    this.defaultTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.defaultTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    this.glBound[0]=this.defaultTexture;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);this._check('initialize',true);
  }
  _resizeBackbuffer(){
    const gl=this.gl;this.bufferWidth=this.canvas.width;this.bufferHeight=this.canvas.height;
    const previous=gl.getParameter(gl.RENDERBUFFER_BINDING);gl.bindFramebuffer(gl.FRAMEBUFFER,this.backbuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER,this.backColor);gl.renderbufferStorage(gl.RENDERBUFFER,gl.RGBA8,this.bufferWidth,this.bufferHeight);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,this.backColor);
    gl.bindRenderbuffer(gl.RENDERBUFFER,this.backDepth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,this.bufferWidth,this.bufferHeight);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this.backDepth);gl.bindRenderbuffer(gl.RENDERBUFFER,previous);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new GraphicsError('back buffer','framebuffer is incomplete');
  }
  _alive(){if(this.destroyed)throw new GraphicsError('call','renderer was destroyed');if(this.gl.isContextLost())throw new GraphicsError('call','WebGL context lost');if(this.backbuffer&&(this.bufferWidth!==this.canvas.width||this.bufferHeight!==this.canvas.height))this._resizeBackbuffer();}
  _check(operation,synchronize=false){
    // getError can flush the GPU command queue and wait for another process.
    // Validate our API arguments immediately, then check backend errors at
    // presentation/readback barriers. Debug mode retains per-operation checks.
    this.checkedOperations.add(operation);
    if(!synchronize&&!this.debugChecks)return;
    this.errorChecks++;const error=this.gl.getError(),operations=[...this.checkedOperations];this.checkedOperations.clear();
    if(error!==this.gl.NO_ERROR)throw new GraphicsError(operation,`WebGL error 0x${error.toString(16)} (since last check: ${operations.join(', ')})`);
  }
  _stack(){return this.mode===GL.TEXTURE&&this.textureUnits?this.textureUnits[this.activeUnit].matrix:this.matrices.get(this.mode);}
  _matrix(mode=this.mode){const stack=mode===GL.TEXTURE&&this.textureUnits?this.textureUnits[this.activeUnit].matrix:this.matrices.get(mode);return stack[stack.length-1];}
  matrixMode(mode){if(!this.matrices.has(mode))unsupported('matrixMode',mode);this.mode=mode;}
  loadIdentity(){const stack=this._stack();stack[stack.length-1]=mat4Identity();}
  loadMatrix(matrix){if(matrix?.length!==16)throw new GraphicsError('loadMatrix','16 components required');finite('loadMatrix',Array.from(matrix));this._stack()[this._stack().length-1]=new Float32Array(matrix);}
  multMatrix(matrix){if(matrix?.length!==16)throw new GraphicsError('multMatrix','16 components required');finite('multMatrix',Array.from(matrix));this.loadMatrix(mat4Multiply(this._matrix(),matrix));}
  pushMatrix(){const stack=this._stack();if(stack.length>=32)throw new GraphicsError('pushMatrix','stack overflow');stack.push(this._matrix().slice());}
  popMatrix(){const stack=this._stack();if(stack.length===1)throw new GraphicsError('popMatrix','stack underflow');stack.pop();}
  translate(x,y,z){finite('translate',[x,y,z]);const m=mat4Identity();m[12]=x;m[13]=y;m[14]=z;this.multMatrix(m);}
  scale(x,y,z){finite('scale',[x,y,z]);const m=mat4Identity();m[0]=x;m[5]=y;m[10]=z;this.multMatrix(m);}
  rotate(angle,x,y,z){finite('rotate',[angle,x,y,z]);const length=Math.hypot(x,y,z);if(!length)throw new GraphicsError('rotate','axis cannot be zero');x/=length;y/=length;z/=length;const r=angle*Math.PI/180,c=Math.cos(r),s=Math.sin(r),t=1-c;this.multMatrix(new Float32Array([x*x*t+c,y*x*t+z*s,z*x*t-y*s,0,x*y*t-z*s,y*y*t+c,z*y*t+x*s,0,x*z*t+y*s,y*z*t-x*s,z*z*t+c,0,0,0,0,1]));}
  ortho(left,right,bottom,top,near,far){finite('ortho',[left,right,bottom,top,near,far]);if(left===right||bottom===top||near===far)throw new GraphicsError('ortho','degenerate volume');this.multMatrix(new Float32Array([2/(right-left),0,0,0,0,2/(top-bottom),0,0,0,0,-2/(far-near),0,-(right+left)/(right-left),-(top+bottom)/(top-bottom),-(far+near)/(far-near),1]));}
  frustum(left,right,bottom,top,near,far){finite('frustum',[left,right,bottom,top,near,far]);if(left===right||bottom===top||near===far||near<=0||far<=0)throw new GraphicsError('frustum','invalid volume');this.multMatrix(new Float32Array([2*near/(right-left),0,0,0,0,2*near/(top-bottom),0,0,(right+left)/(right-left),(top+bottom)/(top-bottom),-(far+near)/(far-near),-1,0,0,-2*far*near/(far-near),0]));}
  _same(key,values){const previous=this.glState[key];for(let i=0;i<values.length;i++)if(previous[i]!==values[i]){this.glState[key]=values;return false;}return true;}
  clearColor(r,g,b,a){this._alive();finite('clearColor',[r,g,b,a]);if(!this._same('clearColor',[r,g,b,a]))this.gl.clearColor(r,g,b,a);}
  clearDepth(value){finite('clearDepth',[value]);if(this.glState.clearDepth!==value){this.glState.clearDepth=value;this.gl.clearDepth(value);}}
  clear(mask){this._alive();if(mask&~(GL.COLOR_BUFFER_BIT|GL.DEPTH_BUFFER_BIT))unsupported('clear mask',mask);this.gl.clear(mask);this._check('clear');}
  fillRect(left,top,right,bottom,color){
    // GDI uses the display surface independently of the WGL context lifetime.
    if(this.gl.isContextLost())throw new GraphicsError('GDI FillRect','WebGL context lost');if(right<=left||bottom<=top)return;
    const gl=this.gl,enabled=gl.isEnabled(gl.SCISSOR_TEST),box=gl.getParameter(gl.SCISSOR_BOX),prior=gl.getParameter(gl.COLOR_CLEAR_VALUE),mask=gl.getParameter(gl.COLOR_WRITEMASK);
    const previous=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
    gl.enable(gl.SCISSOR_TEST);gl.scissor(left,this.canvas.height-bottom,right-left,bottom-top);gl.colorMask(true,true,true,true);
    gl.clearColor((color&255)/255,(color>>>8&255)/255,(color>>>16&255)/255,1);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(...prior);gl.colorMask(...mask);gl.scissor(...box);if(!enabled)gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,previous);this._check('GDI FillRect',true);
  }
  viewport(x,y,width,height){this._alive();if(![x,y,width,height].every(Number.isInteger)||width<0||height<0)throw new GraphicsError('viewport','integer rectangle required');if(!this._same('viewport',[x,y,width,height]))this.gl.viewport(x,y,width,height);this._check('viewport');}
  scissor(x,y,width,height){if(![x,y,width,height].every(Number.isInteger)||width<0||height<0)throw new GraphicsError('scissor','integer rectangle required');if(!this._same('scissor',[x,y,width,height]))this.gl.scissor(x,y,width,height);this._check('scissor');}
  enable(capability){this._setEnabled(capability,true);}
  disable(capability){this._setEnabled(capability,false);}
  _lightCapability(capability){
    if(capability>=GL.TEXTURE_GEN_S&&capability<=GL.TEXTURE_GEN_Q)return[this.texgen[capability-GL.TEXTURE_GEN_S],'enabled'];
    if(capability>=GL.LIGHT0&&capability<GL.LIGHT0+8)return[this.lighting.lights[capability-GL.LIGHT0],'enabled'];
    const key=new Map([[GL.LIGHTING,'enabled'],[GL.NORMALIZE,'normalize'],[GL.RESCALE_NORMAL,'rescale'],[GL.COLOR_MATERIAL,'colorMaterial']]).get(capability);
    return key?[this.lighting,key]:null;
  }
  _setEnabled(capability,enabled){this._alive();if(this.immediate)throw new GraphicsError('enable/disable','not permitted between begin/end');if(capability===GL.TEXTURE_2D){this.textured=enabled;return;}if(capability===GL.ALPHA_TEST){this.alphaTest=enabled;return;}if(capability===GL.FOG){this.fog.enabled=enabled;return;}const lighting=this._lightCapability(capability);if(lighting){if(lighting[0][lighting[1]]!==enabled){lighting[0][lighting[1]]=enabled;this.lightingVersion++;}if(capability===GL.COLOR_MATERIAL&&enabled)this._trackColor();return;}const previous=this.glCaps.get(capability);if(previous===undefined)unsupported('enable/disable',capability);if(previous!==enabled){this.gl[enabled?'enable':'disable'](capability);this.glCaps.set(capability,enabled);}this._check('enable/disable');}
  isEnabled(capability){this._alive();if(capability===GL.TEXTURE_2D)return this.textured;if(capability===GL.ALPHA_TEST)return this.alphaTest;if(capability===GL.FOG)return this.fog.enabled;const lighting=this._lightCapability(capability);if(lighting)return lighting[0][lighting[1]];if(![GL.BLEND,GL.DEPTH_TEST,GL.CULL_FACE,GL.SCISSOR_TEST,0x8037,0x0bd0].includes(capability))unsupported('isEnabled',capability);return this.gl.isEnabled(capability);}
  normal(x,y,z){finite('normal',[x,y,z]);this.currentNormal=[x,y,z];}
  shadeModel(mode){if(![GL.FLAT,GL.SMOOTH].includes(mode))unsupported('shadeModel',mode);this.shading=mode;}
  lightModelfv(parameter,values){
    finite('lightModel',Array.from(values));const l=this.lighting;this.lightingVersion++;
    if(parameter===GL.LIGHT_MODEL_AMBIENT){if(values.length<4)throw new GraphicsError('lightModel','four components required');l.ambient=Array.from(values).slice(0,4);}
    else if(parameter===GL.LIGHT_MODEL_LOCAL_VIEWER)l.localViewer=!!values[0];
    else if(parameter===GL.LIGHT_MODEL_TWO_SIDE)l.twoSide=!!values[0];
    else unsupported('lightModel parameter',parameter);
  }
  lightfv(light,parameter,values){
    const l=this.lighting.lights[light-GL.LIGHT0];if(!l)unsupported('light',light);
    finite('light',Array.from(values));this.lightingVersion++;
    const property=materialProperty.get(parameter);
    if(property&&property!=='emission'){if(values.length<4)throw new GraphicsError('light','four components required');l[property]=Array.from(values).slice(0,4);}
    else if(parameter===GL.POSITION){if(values.length<4)throw new GraphicsError('light position','four components required');l.position=Array.from(transformVertex(this._matrix(GL.MODELVIEW),values));}
    else if(parameter===GL.SPOT_DIRECTION){if(values.length<3)throw new GraphicsError('spot direction','three components required');l.direction=normalTransform(normalMatrix(this._matrix(GL.MODELVIEW)),values);}
    else if(parameter===GL.SPOT_EXPONENT){if(values[0]<0||values[0]>128)throw new GraphicsError('spot exponent','outside [0,128]');l.exponent=values[0];}
    else if(parameter===GL.SPOT_CUTOFF){if(values[0]!==180&&(values[0]<0||values[0]>90))throw new GraphicsError('spot cutoff','outside [0,90] or 180');l.cutoff=values[0];}
    else if(parameter>=GL.CONSTANT_ATTENUATION&&parameter<=GL.QUADRATIC_ATTENUATION){if(values[0]<0)throw new GraphicsError('light attenuation','must be nonnegative');l.attenuation[parameter-GL.CONSTANT_ATTENUATION]=values[0];}
    else unsupported('light parameter',parameter);
  }
  materialfv(face,parameter,values){
    if(this.immediate)throw new GraphicsError('material','material changes inside begin/end are not implemented');
    if(![GL.FRONT,GL.BACK,GL.FRONT_AND_BACK].includes(face))unsupported('material face',face);
    finite('material',Array.from(values));this.lightingVersion++;
    const properties=parameter===GL.AMBIENT_AND_DIFFUSE?['ambient','diffuse']:[materialProperty.get(parameter)];
    for(const index of face===GL.FRONT_AND_BACK?[0,1]:[face===GL.FRONT?0:1]){
      const material=this.lighting.materials[index];
      if(parameter===GL.SHININESS){if(values[0]<0||values[0]>128)throw new GraphicsError('shininess','outside [0,128]');material.shininess=values[0];}
      else{if(!properties[0])unsupported('material parameter',parameter);if(values.length<4)throw new GraphicsError('material','four components required');for(const property of properties)material[property]=Array.from(values).slice(0,4);}
    }
  }
  colorMaterial(face,mode){
    if(![GL.FRONT,GL.BACK,GL.FRONT_AND_BACK].includes(face))unsupported('colorMaterial face',face);
    if(!materialProperty.has(mode)&&mode!==GL.AMBIENT_AND_DIFFUSE)unsupported('colorMaterial mode',mode);
    this.lighting.colorFace=face;this.lighting.colorMode=mode;this.lightingVersion++;this._trackColor();
  }
  _trackColor(){
    const l=this.lighting;if(!l?.colorMaterial)return;this.lightingVersion++;
    for(const index of l.colorFace===GL.FRONT_AND_BACK?[0,1]:[l.colorFace===GL.FRONT?0:1])
      for(const property of l.colorMode===GL.AMBIENT_AND_DIFFUSE?['ambient','diffuse']:[materialProperty.get(l.colorMode)])l.materials[index][property]=Array.from(this.currentColor);
  }
  _litColors(attributes,count,face){
    // Fixed-function lighting is evaluated per vertex before rasterization.
    // OpenGL 2.1 sections 2.11 and 2.14; the shader interpolates these colors.
    const l=this.lighting,m=this._matrix(GL.MODELVIEW),nmat=normalMatrix(m),material=l.materials[face],out=new Float32Array(count*4);
    const lights=l.lights.filter(light=>light.enabled),positionSize=attributes.positionSize??3,colorSize=attributes.colorSize??4;
    if(attributes.normals&&attributes.normals.length<count*3)throw new GraphicsError('draw','normal array is too short');
    const tracking=l.colorMaterial&&(l.colorFace===GL.FRONT_AND_BACK||l.colorFace===(face?GL.BACK:GL.FRONT));
    for(let i=0;i<count;i++){
      const position=Array.from({length:4},(_,j)=>j<positionSize?attributes.positions[i*positionSize+j]:j===3?1:0),eye=transformVertex(m,position);
      const p=[eye[0]/eye[3],eye[1]/eye[3],eye[2]/eye[3]];
      let n=normalTransform(nmat,attributes.normals?attributes.normals.subarray(i*3,i*3+3):this.currentNormal);
      if(l.rescale){const scale=1/Math.hypot(nmat[6],nmat[7],nmat[8]);n=n.map(v=>v*scale);}
      if(l.normalize)n=normalize(n);if(face)n=n.map(v=>-v);
      const color=attributes.colors?Array.from({length:4},(_,j)=>j<colorSize?attributes.colors[i*colorSize+j]:1):Array.from(this.currentColor);
      const property=name=>tracking&&(materialProperty.get(l.colorMode)===name||l.colorMode===GL.AMBIENT_AND_DIFFUSE&&['ambient','diffuse'].includes(name))?color:material[name];
      const ambient=property('ambient'),diffuse=property('diffuse'),specular=property('specular'),emission=property('emission');
      const rgb=[0,1,2].map(j=>emission[j]+ambient[j]*l.ambient[j]),viewer=l.localViewer?normalize(p.map(v=>-v)):[0,0,1];
      for(const light of lights){
        const directional=light.position[3]===0,delta=light.position.slice(0,3).map((v,j)=>directional?v:v/light.position[3]-p[j]);
        const distance=Math.hypot(...delta),direction=normalize(delta);let attenuation=1;
        if(!directional)attenuation=1/(light.attenuation[0]+light.attenuation[1]*distance+light.attenuation[2]*distance*distance);
        if(light.cutoff!==180){const cosine=dot(direction.map(v=>-v),normalize(light.direction));attenuation*=cosine<Math.cos(light.cutoff*Math.PI/180)?0:Math.pow(Math.max(0,cosine),light.exponent);}
        const ndotl=Math.max(0,dot(n,direction)),half=normalize(direction.map((v,j)=>v+viewer[j]));
        const highlight=ndotl>0?Math.pow(Math.max(0,dot(n,half)),material.shininess):0;
        for(let j=0;j<3;j++)rgb[j]+=attenuation*(ambient[j]*light.ambient[j]+diffuse[j]*light.diffuse[j]*ndotl+specular[j]*light.specular[j]*highlight);
      }
      out.set([...rgb.map(clamp),clamp(diffuse[3])],i*4);
    }
    return out;
  }
  // OpenGL 2.1 section 3.10 permits |eye z| as the distance approximation.
  // Interpolate signed eye z perspectively and evaluate fog per fragment.
  // https://registry.khronos.org/OpenGL/specs/gl/glspec21.pdf
  fogf(parameter,value){
    this._alive();if(this.immediate)throw new GraphicsError('fog','not permitted between begin/end');finite('fog',[value]);
    if(parameter===GL.FOG_MODE){if(![GL.LINEAR,GL.EXP,GL.EXP2].includes(value))unsupported('fog mode',value);this.fog.mode=value;}
    else if(parameter===GL.FOG_DENSITY){if(value<0)throw new GraphicsError('fog density','must be nonnegative');this.fog.density=value;}
    else if(parameter===GL.FOG_START)this.fog.start=value;
    else if(parameter===GL.FOG_END)this.fog.end=value;
    else unsupported('fog parameter',parameter);
  }
  fogfv(parameter,values){
    this._alive();if(this.immediate)throw new GraphicsError('fog','not permitted between begin/end');
    const count=parameter===GL.FOG_COLOR?4:1;
    if(!values||values.length<count)throw new GraphicsError('fog','insufficient parameter components');
    const components=Array.from(values).slice(0,count);finite('fog',components);
    if(parameter===GL.FOG_COLOR)this.fog.color.set(components.map(v=>Math.min(1,Math.max(0,v))));
    else this.fogf(parameter,components[0]);
  }
  // Invalid enums still reach WebGL and are reported by the next error check.
  blendFunc(source,destination){if(!this._same('blend',[source,destination]))this.gl.blendFunc(source,destination);this._check('blendFunc');}
  depthFunc(func){if(func<GL.NEVER||func>GL.ALWAYS)unsupported('depthFunc',func);if(this.glState.depthFunc!==func){this.glState.depthFunc=func;this.gl.depthFunc(func);}this._check('depthFunc');}
  depthMask(enabled){enabled=Boolean(enabled);if(this.glState.depthMask!==enabled){this.glState.depthMask=enabled;this.gl.depthMask(enabled);}}
  cullFace(mode){if(this.glState.cullFace!==mode){this.glState.cullFace=mode;this.gl.cullFace(mode);}this._check('cullFace');}
  frontFace(mode){if(this.glState.frontFace!==mode){this.glState.frontFace=mode;this.gl.frontFace(mode);}this._check('frontFace');}
  colorMask(r,g,b,a){const mask=[Boolean(r),Boolean(g),Boolean(b),Boolean(a)];if(!this._same('colorMask',mask))this.gl.colorMask(...mask);}
  alphaFunc(func,reference){if(func<GL.NEVER||func>GL.ALWAYS)unsupported('alphaFunc',func);finite('alphaFunc',[reference]);this.alphaFunction=func;this.alphaReference=Math.min(1,Math.max(0,reference));}
  color(r,g,b,a=1){finite('color',[r,g,b,a]);this.currentColor.set([r,g,b,a]);this._trackColor();}
  activeTexture(unit){const index=unit-0x84c0;if(!Number.isInteger(index)||index<0||index>=this.textureUnits.length)unsupported('activeTexture',unit);this.activeUnit=index;this._glActive(index);}
  _glActive(unit){if(this.glActiveUnit!==unit){this.gl.activeTexture(this.gl.TEXTURE0+unit);this.glActiveUnit=unit;}}
  _bindUnit(unit,handle){if(this.glBound[unit]!==handle){this._glActive(unit);this.gl.bindTexture(this.gl.TEXTURE_2D,handle);this.glBound[unit]=handle;}}
  texCoord(s,t,r=0,q=1){this.multiTexCoord(0x84c0,s,t,r,q);}
  multiTexCoord(unit,s,t,r=0,q=1){finite('texCoord',[s,t,r,q]);const entry=this.textureUnits[unit-0x84c0];if(!entry)unsupported('multiTexCoord',unit);entry.currentTexcoord.set([s,t,r,q]);}
  texGenfv(coordinate,parameter,values){
    const state=this.texgen[coordinate-GL.S];if(!state)unsupported('texGen coordinate',coordinate);
    finite('texGen',Array.from(values));
    if(parameter===GL.TEXTURE_GEN_MODE){
      const mode=values[0];if(![GL.OBJECT_LINEAR,GL.EYE_LINEAR,GL.SPHERE_MAP,GL.NORMAL_MAP,GL.REFLECTION_MAP].includes(mode))unsupported('texGen mode',mode);
      if(mode===GL.SPHERE_MAP&&coordinate>GL.T||[GL.NORMAL_MAP,GL.REFLECTION_MAP].includes(mode)&&coordinate===GL.Q)throw new GraphicsError('texGen','invalid coordinate for generation mode');
      state.mode=mode;
    }else if(parameter===GL.OBJECT_PLANE||parameter===GL.EYE_PLANE){
      if(values.length<4)throw new GraphicsError('texGen plane','four components required');
      if(parameter===GL.OBJECT_PLANE)state.objectPlane=Array.from(values).slice(0,4);
      else{const inverse=mat4Inverse(this._matrix(GL.MODELVIEW));state.eyePlane=[0,1,2,3].map(i=>[0,1,2,3].reduce((sum,j)=>sum+inverse[i*4+j]*values[j],0));}
    }else unsupported('texGen parameter',parameter);
  }
  _generatedTexcoords(attributes,count,unit){
    const states=unit?.texgen||this.texgen,current=unit?.currentTexcoord||this.currentTexcoord;
    const m=this._matrix(GL.MODELVIEW),positionSize=attributes.positionSize??3,textureSize=attributes.texcoordSize??2;
    const environmental=states.some(s=>s.enabled&&[GL.SPHERE_MAP,GL.NORMAL_MAP,GL.REFLECTION_MAP].includes(s.mode));
    const nmat=environmental?normalMatrix(m):null,out=new Float32Array(count*4);
    for(let i=0;i<count;i++){
      const position=Array.from({length:4},(_,j)=>j<positionSize?attributes.positions[i*positionSize+j]:j===3?1:0),eye=transformVertex(m,position);
      const normal=environmental?normalize(normalTransform(nmat,attributes.normals?attributes.normals.subarray(i*3,i*3+3):this.currentNormal)):null;
      const unit=environmental?normalize(Array.from(eye).slice(0,3)):null,reflection=environmental?unit.map((v,j)=>v-2*normal[j]*dot(normal,unit)):null;
      for(let j=0;j<4;j++){
        const state=states[j];let value=attributes.texcoords?(j<textureSize?attributes.texcoords[i*textureSize+j]:j===3?1:0):current[j];
        if(state.enabled){
          if(state.mode===GL.OBJECT_LINEAR)value=state.objectPlane.reduce((sum,v,k)=>sum+v*position[k],0);
          else if(state.mode===GL.EYE_LINEAR)value=state.eyePlane.reduce((sum,v,k)=>sum+v*eye[k],0);
          else if(state.mode===GL.NORMAL_MAP)value=normal[j];
          else if(state.mode===GL.REFLECTION_MAP)value=reflection[j];
          else{const magnitude=2*Math.hypot(reflection[0],reflection[1],reflection[2]+1);value=magnitude?reflection[j]/magnitude+.5:.5;}
        }
        out[i*4+j]=value;
      }
    }
    return out;
  }
  genTexture(){this._alive();const id=this.nextTexture++,handle=this.gl.createTexture();if(!handle)throw new GraphicsError('genTexture','allocation failed');this.textures.set(id,textureDefaults(handle));return id;}
  deleteTexture(id){const entry=this.textures.get(id);if(!entry)return;this.gl.deleteTexture(entry.handle);this.textures.delete(id);for(let i=0;i<this.glBound.length;i++)if(this.glBound[i]===entry.handle)this.glBound[i]=null;const active=this.activeUnit;for(let i=0;i<this.textureUnits.length;i++)if(this.textureUnits[i].boundTexture===id){this.activeTexture(0x84c0+i);this.bindTexture(GL.TEXTURE_2D,0);}this.activeTexture(0x84c0+active);}
  bindTexture(target,id){this._alive();if(target!==GL.TEXTURE_2D)unsupported('bindTexture target',target);if(!Number.isInteger(id)||id<0)throw new GraphicsError('bindTexture','invalid texture id');if(id&&!this.textures.has(id)){const handle=this.gl.createTexture();if(!handle)throw new GraphicsError('bindTexture','allocation failed');this.textures.set(id,textureDefaults(handle));this.nextTexture=Math.max(this.nextTexture,id+1);}this.boundTexture=id;this._bindUnit(this.activeUnit,id?this.textures.get(id).handle:this.defaultTexture);this._check('bindTexture');}
  _texture(target){if(target!==GL.TEXTURE_2D)unsupported('texture target',target);if(!this.boundTexture)throw new GraphicsError('texture','upload requires a nonzero texture object');return this.textures.get(this.boundTexture);}
  pixelStorei(parameter,value){
    if(parameter===GL.UNPACK_ALIGNMENT){if(![1,2,4,8].includes(value))unsupported('pixelStorei alignment',value);this.unpackAlignment=value;return;}
    if(parameter===0x0cf0||parameter===0x0cf1){this[parameter===0x0cf0?'unpackSwapBytes':'unpackLSBFirst']=!!value;return;}
    const key=new Map([[0x0cf2,'unpackRowLength'],[0x0cf3,'unpackSkipRows'],[0x0cf4,'unpackSkipPixels']]).get(parameter);
    if(!key)unsupported('pixelStorei parameter',parameter);
    if(!Number.isInteger(value)||value<0||value>0x7fffffff)throw new GraphicsError('pixelStorei','nonnegative GLint required');this[key]=value;
  }
  pixelLayout(width,height,format,type){
    if(![width,height].every(v=>Number.isInteger(v)&&v>=0&&v<=32768))throw new GraphicsError('texture pixels','invalid dimensions');
    if(type!==GL.UNSIGNED_BYTE)unsupported('texture pixel type',type);
    const channels=new Map([[GL.RGBA,4],[GL.BGRA,4],[GL.RGB,3],[GL.BGR,3],[GL.ALPHA,1],[GL.LUMINANCE,1],[GL.LUMINANCE_ALPHA,2]]).get(format);
    if(!channels)unsupported('texture pixel format',format);
    const stride=Math.ceil((this.unpackRowLength||width)*channels/this.unpackAlignment)*this.unpackAlignment;
    const offset=(this.unpackSkipRows||0)*stride+(this.unpackSkipPixels||0)*channels;
    const required=width&&height?offset+stride*(height-1)+width*channels:0;
    if(required>256*1024*1024)throw new GraphicsError('texture pixels','transfer exceeds 256 MiB');
    return{channels,stride,offset,required};
  }
  _pixels(width,height,format,type,pixels){
    const {channels,stride,offset,required}=this.pixelLayout(width,height,format,type);
    if(pixels===null)return null;
    if(!(pixels instanceof Uint8Array))throw new GraphicsError('texture pixels','Uint8Array or null required');
    if(pixels.length<required)throw new GraphicsError('texture pixels',`need ${required} bytes, have ${pixels.length}`);
    const result=new Uint8Array(width*height*4),row=width*4;
    if(format===GL.RGBA){
      if(stride===row)result.set(pixels.subarray(offset,offset+row*height));
      else for(let y=0;y<height;y++)result.set(pixels.subarray(offset+y*stride,offset+y*stride+row),y*row);
      return result;
    }
    // Per-format row loops; texture uploads happen every frame (fog, minimap).
    for(let y=0;y<height;y++){
      let source=offset+y*stride,destination=y*row;const end=destination+row;
      if(format===GL.BGRA)for(;destination<end;source+=4,destination+=4){result[destination]=pixels[source+2];result[destination+1]=pixels[source+1];result[destination+2]=pixels[source];result[destination+3]=pixels[source+3];}
      else if(format===GL.RGB)for(;destination<end;source+=3,destination+=4){result[destination]=pixels[source];result[destination+1]=pixels[source+1];result[destination+2]=pixels[source+2];result[destination+3]=255;}
      else if(format===GL.BGR)for(;destination<end;source+=3,destination+=4){result[destination]=pixels[source+2];result[destination+1]=pixels[source+1];result[destination+2]=pixels[source];result[destination+3]=255;}
      else if(format===GL.ALPHA)for(;destination<end;source++,destination+=4){result[destination]=result[destination+1]=result[destination+2]=255;result[destination+3]=pixels[source];}
      else if(format===GL.LUMINANCE)for(;destination<end;source++,destination+=4){result[destination]=result[destination+1]=result[destination+2]=pixels[source];result[destination+3]=255;}
      else for(;destination<end;source+=2,destination+=4){result[destination]=result[destination+1]=result[destination+2]=pixels[source];result[destination+3]=pixels[source+1];}
    }
    return result;
  }
  texImage2D(target,level,internalFormat,width,height,border,format,type,pixels){
    const entry=this._texture(target);
    if(![level,width,height,border].every(Number.isInteger)||level<0||width<0||height<0||border!==0)throw new GraphicsError('texImage2D','invalid size, mip level, or border');
    const sized=new Map([[0x8056,{storage:4,format:this.gl.RGBA4}],[0x8057,{storage:4,format:this.gl.RGB5_A1}],[0x8058,{storage:4,format:this.gl.RGBA8}],
      [0x804f,{storage:3,format:this.gl.RGB565,pixelFormat:GL.RGB}],[0x8050,{storage:3,format:this.gl.RGB565,pixelFormat:GL.RGB}],
      [0x8051,{storage:3,format:this.gl.RGBA8}],[0x803c,{storage:0,format:this.gl.RGBA8}],[0x8040,{storage:1,format:this.gl.RGBA8}],[0x8045,{storage:2,format:this.gl.RGBA8}]]).get(internalFormat);
    if(!sized&&![1,2,3,4,GL.RGB,GL.RGBA,GL.ALPHA,GL.LUMINANCE,GL.LUMINANCE_ALPHA].includes(internalFormat))unsupported('texImage2D internalFormat',internalFormat);
    const maximum=this.maxTextureSize;if(width>maximum||height>maximum)throw new GraphicsError('texImage2D','texture exceeds device size limit');
    const storage=sized?.storage??(internalFormat===GL.ALPHA?0:internalFormat===GL.LUMINANCE?1:internalFormat===GL.LUMINANCE_ALPHA?2:internalFormat===GL.RGB?3:internalFormat===GL.RGBA?4:internalFormat);
    const pixelFormat=sized?.pixelFormat??GL.RGBA,rgba=this._nativePixels(this._storagePixels(this._pixels(width,height,format,type,pixels),storage),pixelFormat);this.gl.texImage2D(target,level,sized?.format??this.gl.RGBA,width,height,0,pixelFormat,this.gl.UNSIGNED_BYTE,rgba);this._check('texImage2D');
    if(level===0){entry.width=width;entry.height=height;entry.storage=storage;}
    entry.levels.set(level,{width,height,internalFormat,storage,pixelFormat});entry.complete=undefined;
  }
  _storagePixels(rgba,storage){if(rgba===null||storage===4)return rgba;for(let i=0;i<rgba.length;i+=4){if(storage===0){rgba[i]=rgba[i+1]=rgba[i+2]=255;}else if(storage===1||storage===2){rgba[i+1]=rgba[i+2]=rgba[i];if(storage===1)rgba[i+3]=255;}else if(storage===3)rgba[i+3]=255;}return rgba;}
  _nativePixels(rgba,format){if(rgba===null||format===GL.RGBA)return rgba;const rgb=new Uint8Array(rgba.length/4*3);for(let s=0,d=0;s<rgba.length;s+=4){rgb[d++]=rgba[s];rgb[d++]=rgba[s+1];rgb[d++]=rgba[s+2];}return rgb;}
  texSubImage2D(target,level,x,y,width,height,format,type,pixels){const entry=this._texture(target),image=entry.levels.get(level);if(![level,x,y,width,height].every(Number.isInteger)||level<0||x<0||y<0||width<0||height<0)throw new GraphicsError('texSubImage2D','invalid rectangle');if(!image||x+width>image.width||y+height>image.height)throw new GraphicsError('texSubImage2D','rectangle exceeds allocated mip level');if(pixels===null)throw new GraphicsError('texSubImage2D','pixels required');this.gl.texSubImage2D(target,level,x,y,width,height,image.pixelFormat,this.gl.UNSIGNED_BYTE,this._nativePixels(this._storagePixels(this._pixels(width,height,format,type,pixels),image.storage),image.pixelFormat));this._check('texSubImage2D');}
  texParameteri(target,parameter,value){
    const entry=this._texture(target),gl=this.gl;
    const key=new Map([[gl.TEXTURE_MIN_FILTER,'minFilter'],[gl.TEXTURE_MAG_FILTER,'magFilter'],[gl.TEXTURE_WRAP_S,'wrapS'],[gl.TEXTURE_WRAP_T,'wrapT']]).get(parameter);
    if(!key)unsupported('texParameteri',parameter);
    const values=key==='minFilter'?[GL.NEAREST,GL.LINEAR,0x2700,0x2701,0x2702,0x2703]:key==='magFilter'?[GL.NEAREST,GL.LINEAR]:[GL.REPEAT,GL.CLAMP,GL.CLAMP_TO_EDGE,GL.CLAMP_TO_BORDER,GL.MIRRORED_REPEAT];
    if(!values.includes(value))unsupported('texParameteri value',value);
    // The shader supplies border taps; the backing WebGL texture must stay valid.
    gl.texParameteri(target,parameter,[GL.CLAMP,GL.CLAMP_TO_BORDER].includes(value)?GL.CLAMP_TO_EDGE:value);this._check('texParameteri');
    entry[key]=value;entry.complete=undefined;
  }
  texParameterfv(target,parameter,values){
    if(parameter!==0x1004){this.texParameteri(target,parameter,Math.round(values[0]));return;}
    const entry=this._texture(target);if(values.length<4)throw new GraphicsError('texture border','four components required');
    finite('texture border',Array.from(values));entry.borderColor=Array.from(values).slice(0,4).map(clamp);
  }
  _textureComplete(entry){
    if(entry.complete!==undefined)return entry.complete;
    const base=entry.levels.get(0);if(!base||!base.width||!base.height)return entry.complete=false;
    const max=entry.minFilter>=0x2700?Math.floor(Math.log2(Math.max(base.width,base.height))):0;
    for(let level=1;level<=max;level++){const image=entry.levels.get(level);if(!image||image.width!==Math.max(1,base.width>>level)||image.height!==Math.max(1,base.height>>level)||image.internalFormat!==base.internalFormat)return entry.complete=false;}
    return entry.complete=true;
  }
  texEnvi(target,parameter,value){if(target!==GL.TEXTURE_ENV||parameter!==GL.TEXTURE_ENV_MODE)unsupported('texEnvi',parameter);if(![GL.MODULATE,GL.REPLACE,GL.DECAL,GL.ADD].includes(value))unsupported('texture environment mode',value);this.textureEnvironment=value;}
  _floatArray(attributes,spec,vertexCount){return floatArray(attributes,spec,vertexCount);}
  _floatAttributes(attributes,vertexCount){return floatAttributes(attributes,vertexCount);}
  _uniform1i(name,value){const location=this.uniforms[name];if(location!==null&&this.uniformCache[name]!==value){this.gl.uniform1i(location,value);this.uniformCache[name]=value;}}
  _uniform1f(name,value){const location=this.uniforms[name];if(location!==null&&this.uniformCache[name]!==value){this.gl.uniform1f(location,value);this.uniformCache[name]=value;}}
  _uniform2i(name,a,b){const location=this.uniforms[name],cached=this.uniformCache[name];if(location!==null&&(!cached||cached[0]!==a||cached[1]!==b)){this.gl.uniform2i(location,a,b);this.uniformCache[name]=[a,b];}}
  _uniform4fv(name,values){
    const location=this.uniforms[name],cached=this.uniformCache[name];
    if(location!==null&&(!cached||cached[0]!==values[0]||cached[1]!==values[1]||cached[2]!==values[2]||cached[3]!==values[3])){this.gl.uniform4fv(location,values);this.uniformCache[name]=Float32Array.from(values);}
  }
  // Matrices are replaced, never modified in place, so identity is sufficient.
  _uniformMatrix(name,matrix){const location=this.uniforms[name];if(location!==null&&this.uniformCache[name]!==matrix){this.gl.uniformMatrix4fv(location,false,matrix);this.uniformCache[name]=matrix;}}
  _colorTracking(face){
    const l=this.lighting;
    if(!l.colorMaterial||!(l.colorFace===GL.FRONT_AND_BACK||l.colorFace===(face?GL.BACK:GL.FRONT)))return 0;
    return l.colorMode===GL.AMBIENT_AND_DIFFUSE?3:l.colorMode===GL.AMBIENT?1:l.colorMode===GL.DIFFUSE?2:l.colorMode===GL.SPECULAR?4:l.colorMode===GL.EMISSION?8:0;
  }
  _lightingUniforms(){
    const gl=this.gl,l=this.lighting,cache=this.uniformCache,modelview=this._matrix(GL.MODELVIEW);
    if(cache.normalSource!==modelview||cache.normalRescale!==l.rescale){
      const matrix=normalMatrix(modelview);
      if(l.rescale){const scale=1/Math.hypot(matrix[6],matrix[7],matrix[8]);for(let i=0;i<9;i++)matrix[i]*=scale;}
      gl.uniformMatrix3fv(this.uniforms.normalMatrix,false,matrix);cache.normalSource=modelview;cache.normalRescale=l.rescale;
    }
    if(cache.lightingVersion===this.lightingVersion)return;
    // Layout: [0] scene ambient, [1] (lights, two-side, local viewer,
    // normalize), [3+5f] material of face f, [13+6i] enabled light i.
    const d=this.lightData;d.fill(0);d.set(l.ambient,0);
    let count=0;
    for(const light of l.lights){
      if(!light.enabled)continue;
      const base=(13+count*6)*4;count++;
      d.set(light.ambient,base);d.set(light.diffuse,base+4);d.set(light.specular,base+8);d.set(light.position,base+12);
      d[base+16]=light.direction[0];d[base+17]=light.direction[1];d[base+18]=light.direction[2];d[base+19]=light.cutoff===180?-2:Math.cos(light.cutoff*Math.PI/180);
      d[base+20]=light.attenuation[0];d[base+21]=light.attenuation[1];d[base+22]=light.attenuation[2];d[base+23]=light.exponent;
    }
    d[4]=count;d[5]=l.twoSide?1:0;d[6]=l.localViewer?1:0;d[7]=l.normalize?1:0;
    for(let face=0;face<2;face++){
      const material=l.materials[face],base=(3+face*5)*4;
      d.set(material.ambient,base);d.set(material.diffuse,base+4);d.set(material.specular,base+8);d.set(material.emission,base+12);
      d[base+16]=material.shininess;d[base+17]=this._colorTracking(face);
    }
    gl.uniform4fv(this.uniforms.light,d);cache.lightingVersion=this.lightingVersion;
  }
  // All client arrays of one draw share a single streaming upload. Raw guest
  // arrays keep their stride and component type; WebGL converts on the GPU.
  _uploadAttributes(attributes,vertexCount,generated){
    const gl=this.gl,lighting=this.lighting.enabled,plans=this.attributePlans??=ATTRIBUTES.map(()=>({})),sources=this.uploadSources??=new Map();
    sources.clear();let total=0;
    for(let index=0;index<ATTRIBUTES.length;index++){
      const spec=ATTRIBUTES[index],plan=plans[index],unit=spec.kind==='texcoord'?0:spec.kind==='texcoord1'?1:-1;
      plan.view=null;
      plan.fallback=spec.kind==='position'?null:spec.kind==='color'?this.currentColor:spec.kind==='normal'?this.currentNormal:this.textureUnits[unit].currentTexcoord;
      if(spec.kind==='normal'&&!lighting)continue;
      let values,size,raw=null;
      if(unit>=0&&generated?.[unit]){values=generated[unit];size=4;}
      else if((raw=attributes.raw?.[spec.kind]??null)){
        const width=raw.type===GL.FLOAT?4:raw.type===GL.UNSIGNED_BYTE?1:0,offset=raw.offset??0;
        if(!width||!Number.isInteger(raw.size)||raw.size<1||raw.size>4||!Number.isInteger(raw.stride)||raw.stride<raw.size*width||!(raw.bytes instanceof Uint8Array)||
          raw.bytes.byteLength<offset+(vertexCount?(vertexCount-1)*raw.stride+raw.size*width:0))throw new GraphicsError('draw',`invalid ${spec.kind} client array`);
        if(raw.stride<=255&&raw.stride%width===0&&offset%width===0){
          plan.view=raw.bytes;plan.size=raw.size;plan.type=raw.type;plan.normalized=raw.type===GL.UNSIGNED_BYTE;plan.stride=raw.stride;plan.offset=offset;
        }else({values,size}=this._floatArray(attributes,spec,vertexCount));
      }else{values=attributes[spec.legacy];size=spec.sizeKey?attributes[spec.sizeKey]??spec.size:spec.size;}
      if(!plan.view){
        if(values===undefined&&plan.fallback)continue;
        if(!(values instanceof Float32Array)||!Number.isInteger(size)||size<1||size>4||values.length<vertexCount*size)throw new GraphicsError('draw',`invalid ${spec.kind} Float32Array or size`);
        plan.view=values;plan.size=size;plan.type=GL.FLOAT;plan.normalized=false;plan.stride=0;plan.offset=0;
      }
      if(!sources.has(plan.view)){sources.set(plan.view,total);total+=align4(plan.view.byteLength);}
    }
    // The vertex buffer stays bound to ARRAY_BUFFER; nothing else binds it.
    if(sources.size===1){const [view]=sources.keys();gl.bufferData(gl.ARRAY_BUFFER,view,gl.STREAM_DRAW);}
    else if(sources.size){
      if(this.uploadScratch.byteLength<total)this.uploadScratch=new Uint8Array(Math.max(total,this.uploadScratch.byteLength*2));
      for(const [view,offset] of sources)this.uploadScratch.set(view instanceof Uint8Array?view:new Uint8Array(view.buffer,view.byteOffset,view.byteLength),offset);
      gl.bufferData(gl.ARRAY_BUFFER,this.uploadScratch,gl.STREAM_DRAW,0,total);
    }
    for(let index=0;index<ATTRIBUTES.length;index++){
      const plan=plans[index],state=this.attributeState[index],location=ATTRIBUTES[index].location;
      if(plan.view){
        if(!state.enabled){gl.enableVertexAttribArray(location);state.enabled=true;}
        const offset=sources.get(plan.view)+plan.offset,p=state.pointer;
        if(!p||p[0]!==plan.size||p[1]!==plan.type||p[2]!==plan.normalized||p[3]!==plan.stride||p[4]!==offset){
          gl.vertexAttribPointer(location,plan.size,plan.type,plan.normalized,plan.stride,offset);state.pointer=[plan.size,plan.type,plan.normalized,plan.stride,offset];
        }
        plan.view=null;
      }else{
        if(state.enabled){gl.disableVertexAttribArray(location);state.enabled=false;}
        const value=plan.fallback;if(!value)continue;
        const c=state.constant,x=value[0],y=value[1],z=value[2]??0,w=value[3]??1;
        if(!c||c[0]!==x||c[1]!==y||c[2]!==z||c[3]!==w){gl.vertexAttrib4f(location,x,y,z,w);state.constant=[x,y,z,w];}
      }
    }
    sources.clear();
  }
  _prepare(attributes,vertexCount){
    this._alive();
    // A separate small shader avoids carrying the software border/mipmap
    // sampler through drivers that cannot eliminate its uniform branches.
    // Any enabled stage requiring a true border uses the complete GL sampler.
    let native=!!this.nativeProgram;
    for(let i=0;native&&i<this.textureUnits.length;i++){
      const unit=this.textureUnits[i];if(!unit.textured)continue;
      const texture=this.textures.get(unit.boundTexture);if(!texture)continue;
      for(const wrap of [texture.wrapS,texture.wrapT])if(wrap===GL.CLAMP_TO_BORDER||(wrap===GL.CLAMP&&!this.legacyClampToEdge))native=false;
    }
    this.nativeProgramActive=native;
    const selected=native?this.nativeProgram:this.borderProgram,gl=this.gl;
    if(this.currentProgram!==selected){gl.useProgram(selected.program);this.currentProgram=selected;}
    this.program=selected.program;this.uniforms=selected.uniforms;this.uniformCache=selected.cache;
    if(this.fog.enabled&&this.fog.mode===GL.LINEAR&&this.fog.start===this.fog.end)throw new GraphicsError('draw','linear fog is undefined when start equals end');
    let floats=null,generated=null;const units=this.capture?[]:null;
    for(let i=0;i<this.textureUnits.length;i++){
      const unit=this.textureUnits[i],suffix=i||'',texture=this.textures.get(unit.boundTexture);
      if(unit.textured&&(!texture||!texture.width||!texture.height))throw new GraphicsError('draw','texturing requires an allocated texture');
      if(unit.textured&&unit.textureEnvironment===GL.DECAL&&texture.storage<3)throw new GraphicsError('draw','DECAL is only defined for RGB/RGBA textures');
      if(unit.texgen.some(s=>s.enabled)){
        floats??=this._floatAttributes(attributes,vertexCount);
        (generated??=[])[i]=this._generatedTexcoords({...floats,texcoords:floats['texcoords'+suffix],texcoordSize:floats['texcoordSize'+suffix]??2},vertexCount,unit);
      }
      this._uniformMatrix('textureMatrix'+suffix,unit.matrix.at(-1));
      this._bindUnit(i,texture?.handle||this.defaultTexture);this._uniform1i('texture'+suffix,i);
      const enabled=unit.textured&&this._textureComplete(texture);
      this._uniform1i('textured'+suffix,enabled?1:0);this._uniform1i('texenv'+suffix,unit.textureEnvironment);this._uniform1i('texformat'+suffix,texture?.storage??4);
      if(enabled&&!native){
        const wrapS=this.legacyClampToEdge&&texture.wrapS===GL.CLAMP?GL.CLAMP_TO_EDGE:texture.wrapS;
        const wrapT=this.legacyClampToEdge&&texture.wrapT===GL.CLAMP?GL.CLAMP_TO_EDGE:texture.wrapT;
        this._uniform2i('textureWrap'+suffix,wrapS,wrapT);this._uniform2i('textureFilters'+suffix,texture.minFilter,texture.magFilter);
        const border=texture.borderColor.slice();
        if(texture.storage===0)border[0]=border[1]=border[2]=1;
        else if(texture.storage===1||texture.storage===2){border[1]=border[2]=border[0];if(texture.storage===1)border[3]=1;}
        else if(texture.storage===3)border[3]=1;
        this._uniform4fv('textureBorder'+suffix,border);this._uniform1i('textureMaxMip'+suffix,Math.floor(Math.log2(Math.max(texture.width,texture.height))));
      }
      if(units){
        floats??=this._floatAttributes(attributes,vertexCount);const texcoords=generated?.[i]??floats['texcoords'+suffix];
        units.push({texture:unit.boundTexture,enabled,texenv:unit.textureEnvironment,storage:texture?.storage,size:texture?[texture.width,texture.height]:null,texcoords:Array.from((texcoords||unit.currentTexcoord).slice(0,16))});
      }
    }
    this._glActive(this.activeUnit);
    if(this.capture&&this.capture.length<512){
      floats??=this._floatAttributes(attributes,vertexCount);
      this.capture.push({vertices:vertexCount,positions:Array.from((floats.positions||[]).slice(0,12)),colors:Array.from((floats.colors||this.currentColor).slice(0,16)),units,
        lighting:this.lighting.enabled,colorMaterial:this.lighting.colorMaterial,modelview:Array.from(this._matrix(GL.MODELVIEW)),projection:Array.from(this._matrix(GL.PROJECTION)),
        blend:gl.isEnabled(gl.BLEND),blendFactors:[gl.getParameter(gl.BLEND_SRC_RGB),gl.getParameter(gl.BLEND_DST_RGB)],alphaTest:this.alphaTest,alphaFunction:this.alphaFunction,alphaRef:this.alphaReference});
    }
    this._uploadAttributes(attributes,vertexCount,generated);
    this._uniformMatrix('modelview',this._matrix(GL.MODELVIEW));this._uniformMatrix('projection',this._matrix(GL.PROJECTION));
    this._uniform1i('lighting',this.lighting.enabled?1:0);if(this.lighting.enabled)this._lightingUniforms();
    this._uniform1i('alphaTest',this.alphaTest?1:0);this._uniform1i('alphaFunc',this.alphaFunction);this._uniform1f('alphaRef',this.alphaReference);
    this._uniform1i('fogEnabled',this.fog.enabled?1:0);this._uniform1i('fogMode',this.fog.mode);this._uniform1f('fogDensity',this.fog.density);
    this._uniform1f('fogStart',this.fog.start);this._uniform1f('fogEnd',this.fog.end);this._uniform4fv('fogColor',this.fog.color);
    this._uniform1i('flat',this.shading===GL.FLAT?1:0);
  }
  _drawMode(mode){if(!Number.isInteger(mode)||mode<0||mode>6)unsupported('draw mode',mode);}
  drawArrays(mode,first,count,attributes){this._drawMode(mode);if(!Number.isInteger(first)||!Number.isInteger(count)||first<0||count<0)throw new GraphicsError('drawArrays','invalid range');this._prepare(attributes,first+count);this.gl.drawArrays(mode,first,count);this._check('drawArrays');this.draws++;this[this.nativeProgramActive?'nativeDraws':'borderDraws']++;}
  // vertexCount (largest index + 1) may be supplied by a caller that already
  // scanned the indices; indices may be views of shared guest memory.
  drawElements(mode,indices,attributes,vertexCount){
    this._drawMode(mode);if(!(indices instanceof Uint16Array)&&!(indices instanceof Uint32Array)&&!(indices instanceof Uint8Array))throw new GraphicsError('drawElements','unsigned integer indices required');
    if(vertexCount===undefined){let maximum=-1;for(let i=0;i<indices.length;i++)if(indices[i]>maximum)maximum=indices[i];vertexCount=maximum+1;}
    this._prepare(attributes,vertexCount);const gl=this.gl;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STREAM_DRAW);
    gl.drawElements(mode,indices.length,indices instanceof Uint32Array?gl.UNSIGNED_INT:indices instanceof Uint16Array?gl.UNSIGNED_SHORT:gl.UNSIGNED_BYTE,0);
    this._check('drawElements');this.draws++;this[this.nativeProgramActive?'nativeDraws':'borderDraws']++;
  }
  begin(mode){if(this.immediate)throw new GraphicsError('begin','nested begin');if(mode!==GL.QUADS)this._drawMode(mode);this.immediate={mode,positions:[],colors:[],texcoords:[],texcoords1:[],normals:[]};}
  vertex(x,y,z=0,w=1){if(!this.immediate)throw new GraphicsError('vertex','begin required');finite('vertex',[x,y,z,w]);this.immediate.positions.push(x,y,z,w);this.immediate.colors.push(...this.currentColor);this.immediate.texcoords.push(...this.textureUnits[0].currentTexcoord);this.immediate.texcoords1.push(...this.textureUnits[1].currentTexcoord);this.immediate.normals.push(...this.currentNormal);}
  end(){if(!this.immediate)throw new GraphicsError('end','begin required');const batch=this.immediate;this.immediate=null;const count=batch.positions.length/4,attributes={positions:new Float32Array(batch.positions),positionSize:4,colors:new Float32Array(batch.colors),texcoords:new Float32Array(batch.texcoords),texcoordSize:4,texcoords1:new Float32Array(batch.texcoords1),texcoordSize1:4,normals:new Float32Array(batch.normals)};if(batch.mode===GL.QUADS){if(count%4)throw new GraphicsError('end','QUADS requires a multiple of four vertices');const indices=[];for(let i=0;i<count;i+=4)indices.push(i,i+1,i+2,i,i+2,i+3);this.drawElements(GL.TRIANGLES,new Uint32Array(indices),attributes);}else this.drawArrays(batch.mode,0,count,attributes);}
  flush(){this._alive();this.gl.flush();}
  swapBuffers(){
    this._alive();const gl=this.gl,scissor=gl.isEnabled(gl.SCISSOR_TEST),readBuffer=gl.getParameter(gl.READ_BUFFER);
    gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.backbuffer);gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if(this.gamma?.active)this._presentGamma();
    else{gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);gl.blitFramebuffer(0,0,this.bufferWidth,this.bufferHeight,0,0,this.canvas.width,this.canvas.height,gl.COLOR_BUFFER_BIT,gl.NEAREST);}
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.backbuffer);gl.readBuffer(readBuffer);if(scissor)gl.enable(gl.SCISSOR_TEST);
    gl.flush();this._check('SwapBuffers',true);this.frames++;
    return this.stats();
  }
  // Display gamma, applied to every presented pixel and never to the back
  // buffer that glReadPixels sees: the ramp Warcraft programs with
  // SetDeviceGammaRamp (three 256-entry 16-bit tables) after the exponent of
  // its gamma option, which windowed Warcraft leaves to the launcher. Identity
  // keeps the plain blit; anything else runs one lookup pass.
  setGammaRamp(ramp){
    this._alive();if(!(ramp instanceof Uint16Array)||ramp.length!==768)throw new GraphicsError('SetDeviceGammaRamp','768 16-bit entries required');
    let identity=true;for(let i=0;i<768&&identity;i++)identity=Math.abs(ramp[i]-(i&255)*257)<=128;
    this.displayRamp=identity?null:ramp.slice();this._updateGamma();
  }
  setGammaExponent(exponent){
    this._alive();if(!Number.isFinite(exponent)||exponent<=0)throw new GraphicsError('gamma','positive exponent required');
    this.gammaExponent=Math.abs(exponent-1)<1e-6?null:exponent;this._updateGamma();
  }
  _updateGamma(){
    if(!this.displayRamp&&!this.gammaExponent){if(this.gamma)this.gamma.active=false;return;}
    const gl=this.gl,g=this.gamma??=this._createGammaPass(),table=new Uint8Array(1024),ramp=this.displayRamp,exponent=this.gammaExponent;
    for(let i=0;i<256;i++){
      const value=exponent?Math.round(Math.pow(i/255,exponent)*255):i;
      for(let channel=0;channel<3;channel++)table[i*4+channel]=ramp?Math.round(ramp[channel*256+value]/257):value;
      table[i*4+3]=255;
    }
    gl.activeTexture(gl.TEXTURE0+GAMMA_UNIT+1);gl.bindTexture(gl.TEXTURE_2D,g.table);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,256,1,gl.RGBA,gl.UNSIGNED_BYTE,table);
    gl.activeTexture(gl.TEXTURE0+this.glActiveUnit);g.active=true;this._check('gamma');
  }
  _createGammaPass(){
    const gl=this.gl,shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new GraphicsError('SetDeviceGammaRamp',gl.getShaderInfoLog(s)||'shader');return s;};
    const program=gl.createProgram(),vertex=shader(gl.VERTEX_SHADER,GAMMA_VERTEX),fragment=shader(gl.FRAGMENT_SHADER,GAMMA_FRAGMENT);
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new GraphicsError('SetDeviceGammaRamp',gl.getProgramInfoLog(program)||'link');
    gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'u_scene'),GAMMA_UNIT);gl.uniform1i(gl.getUniformLocation(program,'u_table'),GAMMA_UNIT+1);this.currentProgram=null;
    const texture=(unit,width,height)=>{const t=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);
      for(const [name,value] of [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,name,value);
      gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,width,height);return t;};
    const g={program,vao:gl.createVertexArray(),table:texture(GAMMA_UNIT+1,256,1),scene:null,framebuffer:gl.createFramebuffer(),width:0,height:0,active:false};
    gl.activeTexture(gl.TEXTURE0+this.glActiveUnit);return g;
  }
  _presentGamma(){
    const gl=this.gl,g=this.gamma,width=this.bufferWidth,height=this.bufferHeight;
    if(g.width!==width||g.height!==height){
      if(g.scene)gl.deleteTexture(g.scene);
      g.scene=gl.createTexture();gl.activeTexture(gl.TEXTURE0+GAMMA_UNIT);gl.bindTexture(gl.TEXTURE_2D,g.scene);
      for(const [name,value] of [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,name,value);
      gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,width,height);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,g.framebuffer);gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,g.scene,0);
      g.width=width;g.height=height;
    }
    // Copy the finished frame into a texture, then draw it through the ramp.
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,g.framebuffer);gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);gl.viewport(0,0,this.canvas.width,this.canvas.height);
    const caps=[gl.BLEND,gl.DEPTH_TEST,gl.CULL_FACE,gl.POLYGON_OFFSET_FILL].filter(cap=>this.glCaps.get(cap)),mask=this.glState.colorMask,masked=!mask.every(Boolean);
    for(const cap of caps)gl.disable(cap);if(masked)gl.colorMask(true,true,true,true);
    gl.activeTexture(gl.TEXTURE0+GAMMA_UNIT);gl.bindTexture(gl.TEXTURE_2D,g.scene);gl.activeTexture(gl.TEXTURE0+GAMMA_UNIT+1);gl.bindTexture(gl.TEXTURE_2D,g.table);
    gl.useProgram(g.program);gl.bindVertexArray(g.vao);gl.drawArrays(gl.TRIANGLES,0,3);
    // Restore the fixed-function state that the shadow caches describe.
    gl.bindVertexArray(this.vao);this.currentProgram=null;gl.activeTexture(gl.TEXTURE0+this.glActiveUnit);
    for(const cap of caps)gl.enable(cap);if(masked)gl.colorMask(...mask);gl.viewport(...this.glState.viewport);
  }
  stats(){return{frames:this.frames,draws:this.draws,textures:this.textures.size,width:this.bufferWidth,height:this.bufferHeight,errorChecks:this.errorChecks,debugChecks:this.debugChecks,legacyClampToEdge:this.legacyClampToEdge,nativeTextureShader:this.nativeTextureShader,nativeDraws:this.nativeDraws,borderDraws:this.borderDraws};}
  unsupported(operation,...args){throw new GraphicsError(operation,`not implemented (${args.join(', ')})`);}
  destroy(){if(this.destroyed)return;for(const texture of this.textures.values())this.gl.deleteTexture(texture.handle);this.textures.clear();this.gl.deleteTexture(this.defaultTexture);for(const buffer of Object.values(this.buffers))this.gl.deleteBuffer(buffer);this.gl.deleteVertexArray(this.vao);this.gl.deleteProgram(this.borderProgram.program);if(this.nativeProgram)this.gl.deleteProgram(this.nativeProgram.program);this.gl.deleteFramebuffer(this.backbuffer);this.gl.deleteRenderbuffer(this.backColor);this.gl.deleteRenderbuffer(this.backDepth);const g=this.gamma;if(g){this.gl.deleteProgram(g.program);this.gl.deleteVertexArray(g.vao);this.gl.deleteTexture(g.table);if(g.scene)this.gl.deleteTexture(g.scene);this.gl.deleteFramebuffer(g.framebuffer);}this.destroyed=true;}
}
