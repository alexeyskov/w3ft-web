// Warcraft's Print Screen writes Screenshots/WC3ScrnShot_<date>_<time>_<n>.tga
// (1.26: uncompressed 32-bit BGRA, rows top-down). The page hands each one to
// the player as a PNG, which every system opens; it is not kept with the saves.

// The frame is opaque: the alpha channel of the back buffer means nothing here.
export function decodeTGA(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 18) throw new Error('Not a TGA image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[2], width = view.getUint16(12, true), height = view.getUint16(14, true), depth = bytes[16], descriptor = bytes[17];
  if (bytes[1] !== 0 || ![2, 10].includes(type) || ![24, 32].includes(depth) || !width || !height) {
    throw new Error(`Unsupported TGA image (type ${type}, ${depth} bits)`);
  }
  const size = depth / 8, total = width * height, pixels = new Uint8ClampedArray(total * 4);
  const topDown = (descriptor & 0x20) !== 0, rightToLeft = (descriptor & 0x10) !== 0;
  let source = 18 + bytes[0], count = 0;
  // Pixel `count` of the file, in file order, to its place in the picture.
  const put = (b, g, r) => {
    const row = Math.floor(count / width), column = count % width;
    const at = ((topDown ? row : height - 1 - row) * width + (rightToLeft ? width - 1 - column : column)) * 4;
    pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b; pixels[at + 3] = 255; count++;
  };
  const need = n => { if (source + n > bytes.length) throw new Error('TGA image is truncated'); };
  if (type === 2) {
    need(total * size);
    for (; count < total; source += size) put(bytes[source], bytes[source + 1], bytes[source + 2]);
  } else {
    while (count < total) {
      need(1);
      const header = bytes[source++], run = (header & 0x7f) + 1;
      if (count + run > total) throw new Error('TGA run exceeds the image');
      if (header & 0x80) { need(size); for (let i = 0; i < run; i++) put(bytes[source], bytes[source + 1], bytes[source + 2]); source += size; }
      else { need(run * size); for (let i = 0; i < run; i++, source += size) put(bytes[source], bytes[source + 1], bytes[source + 2]); }
    }
  }
  return {width, height, pixels};
}

// 'screenshots/wc3scrnshot_110726_165125_01.tga' (the guest filesystem keeps
// paths in lower case) → 'WC3ScrnShot_110726_165125_01'.
export function screenshotName(path) {
  const base = String(path).split('/').at(-1).replace(/\.[^.]*$/, '') || 'screenshot';
  return base.replace(/^wc3scrnshot/i, 'WC3ScrnShot');
}

async function png({width, height, pixels}) {
  const image = new ImageData(pixels, width, height);
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(image, 0, 0);
    return canvas.convertToBlob({type: 'image/png'});
  }
  const canvas = Object.assign(document.createElement('canvas'), {width, height});
  canvas.getContext('2d').putImageData(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
}

// {path, data} from the game → {name, blob, width, height} to save.
export async function screenshotFile({path, data}) {
  if (/\.tga$/i.test(path)) {
    const image = decodeTGA(data);
    return {name: `${screenshotName(path)}.png`, blob: await png(image), width: image.width, height: image.height};
  }
  const type = /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.bmp$/i.test(path) ? 'image/bmp' : 'application/octet-stream';
  return {name: screenshotName(path) + (String(path).match(/\.[^./]*$/)?.[0] || ''), blob: new Blob([data], {type})};
}
