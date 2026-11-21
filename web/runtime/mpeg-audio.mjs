// MPEG audio (Layer I/II/III, MPEG-1/2/2.5) facts from frame headers, without
// decoding. Warcraft asks Miles for a sound file's type (AIL_file_type) and
// length (AIL_sample_ms_position after AIL_set_named_sample_file); its JASS
// GetSoundFileDuration answers from them. Maps schedule their music by that
// length: with 0 for every mp3, COT RPG restarted its music timer at once,
// forever, and each pass left new playlist strings in Warcraft's string table.
const BITRATES = {
  1: {1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]},
  2: {1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]},
};
const RATES = {1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000]};
// Where a search for the first frame gives up, after any ID3v2 tag.
const FIRST_FRAME_WINDOW = 64 * 1024, RESYNC_WINDOW = 4096;

// One frame header at byte i, or null. Free-format bitrates are not supported.
export function frameHeader(bytes, i) {
  if (i < 0 || i + 4 > bytes.length || bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[i + 1] >> 3) & 3, layerBits = (bytes[i + 1] >> 1) & 3;
  const bitrateIndex = bytes[i + 2] >> 4, rateIndex = (bytes[i + 2] >> 2) & 3, padding = (bytes[i + 2] >> 1) & 1;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5, layer = 4 - layerBits;
  const bitrate = BITRATES[version === 1 ? 1 : 2][layer][bitrateIndex] * 1000, rate = RATES[version][rateIndex];
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const length = layer === 1 ? (Math.floor(12 * bitrate / rate) + padding) * 4 : Math.floor(samples / 8 * bitrate / rate) + padding;
  return {version, layer, bitrate, rate, samples, length, channels: (bytes[i + 3] >> 6) === 3 ? 1 : 2};
}

const sameStream = (a, b) => b && b.version === a.version && b.layer === a.layer && b.rate === a.rate;
// A frame whose successor is a frame of the same stream, or the data's end:
// a lone 0xFFE bit pattern inside other data is not taken for audio.
function confirmed(bytes, i) {
  const header = frameHeader(bytes, i);
  if (!header || i + header.length > bytes.length) return null;
  return i + header.length === bytes.length || sameStream(header, frameHeader(bytes, i + header.length)) ? header : null;
}
function id3v2End(bytes) {
  let at = 0;
  while (at + 10 <= bytes.length && bytes[at] === 0x49 && bytes[at + 1] === 0x44 && bytes[at + 2] === 0x33) {
    const size = (bytes[at + 6] & 0x7f) << 21 | (bytes[at + 7] & 0x7f) << 14 | (bytes[at + 8] & 0x7f) << 7 | bytes[at + 9] & 0x7f;
    at += 10 + size + (bytes[at + 5] & 0x10 ? 10 : 0);
  }
  return at;
}
// A Xing/Info (LAME) or VBRI frame describes the stream and carries no audio.
function metadataFrame(bytes, i, header) {
  const side = header.version === 1 ? (header.channels === 1 ? 17 : 32) : (header.channels === 1 ? 9 : 17);
  const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  return header.layer === 3 && (['Xing', 'Info'].includes(tag(i + 4 + side)) || tag(i + 36) === 'VBRI');
}

// {layer, version, rate, channels, samplesPerFrame, frames, samples, seconds,
// firstFrame} or null. countFrames:false only identifies the stream.
export function mpegAudioInfo(bytes, {countFrames = true} = {}) {
  const start = id3v2End(bytes), limit = Math.min(bytes.length, start + FIRST_FRAME_WINDOW);
  let first = -1, header = null;
  for (let i = start; i < limit && first < 0; i++) if (bytes[i] === 0xff && (header = confirmed(bytes, i))) first = i;
  if (first < 0) return null;
  const info = {layer: header.layer, version: header.version, rate: header.rate, channels: header.channels,
    samplesPerFrame: header.samples, firstFrame: first, frames: 0, samples: 0, seconds: 0};
  if (!countFrames) return info;
  let frames = 0;
  for (let i = first; i + 4 <= bytes.length;) {
    let current = frameHeader(bytes, i);
    if (!sameStream(header, current) || i + current.length > bytes.length) {
      // A few bytes of junk between frames: continue at the next real frame.
      let next = -1;
      for (let j = i + 1; j < Math.min(bytes.length, i + RESYNC_WINDOW) && next < 0; j++)
        if (bytes[j] === 0xff && sameStream(header, confirmed(bytes, j))) next = j;
      if (next < 0) break;
      i = next; current = frameHeader(bytes, i);
    }
    if (!(i === first && metadataFrame(bytes, i, current))) frames++;
    i += current.length;
  }
  return Object.assign(info, {frames, samples: frames * header.samples, seconds: frames * header.samples / header.rate});
}

// Miles' AIL_file_type values for MPEG audio (AILFILETYPE_MPEG_L1/L2/L3_AUDIO).
export const MILES_MPEG_TYPE = Object.freeze({1: 11, 2: 12, 3: 13});
