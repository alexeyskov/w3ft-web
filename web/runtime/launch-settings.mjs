// Launch resolutions: 4:3, the only shape Warcraft III 1.26 draws without
// stretching. The page scales the canvas to the screen.
export const GAME_RESOLUTIONS = Object.freeze([[800, 600], [1024, 768], [1152, 864], [1280, 960], [1400, 1050], [1600, 1200], [1920, 1440], [2048, 1536]]);

export function gameResolution(value = {width: 1024, height: 768}) {
  if (!value || !GAME_RESOLUTIONS.some(([width, height]) => value.width === width && value.height === height))
    throw new Error(`Game resolution must be one of ${GAME_RESOLUTIONS.map(([width, height]) => `${width}×${height}`).join(', ')}`);
  return {width: value.width, height: value.height};
}

// Warcraft's own video options (HKCU\Software\Blizzard Entertainment\Warcraft
// III\Video), in the game's registry encoding: detail levels 0–2 (low, medium,
// high), switches 0/1 and the gamma slider position. game.dll defaults apply
// to every value the launcher does not set.
export const GRAPHICS_SETTINGS = Object.freeze({
  gamma: [0, 100], modeldetail: [0, 2], animquality: [0, 2], texquality: [0, 2], particles: [0, 2],
  lights: [0, 2], unitshadows: [0, 1], occlusion: [0, 1], spellfilter: [0, 2],
});

export function gameGraphics(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Graphics settings must be an object');
  const result = {};
  for (const [name, setting] of Object.entries(value)) {
    const range = Object.hasOwn(GRAPHICS_SETTINGS, name) ? GRAPHICS_SETTINGS[name] : null;
    if (!range) throw new Error(`Unknown Warcraft graphics setting: ${name}`);
    if (!Number.isInteger(setting) || setting < range[0] || setting > range[1]) throw new Error(`Warcraft graphics setting ${name} must be ${range[0]}–${range[1]}`);
    result[name] = setting;
  }
  return result;
}
