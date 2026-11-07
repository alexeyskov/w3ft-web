// The device's own keyboard on touch screens, for chat, player and game names.
// A canvas cannot open it, so a hidden text field takes the focus. What that
// keyboard types, including word completion and autocorrection, becomes the
// key presses Warcraft reads from a desktop keyboard: the field's text is
// compared after every change and the difference is sent as Backspace and
// typed characters.

// The field never runs empty, so Backspace always has something to delete.
const SENTINEL = '  ';
const SPECIAL = Object.freeze({Enter:[13, '\r'], Escape:[27, '\x1b'], Tab:[9, '\t'],
  ArrowLeft:[37, '', true], ArrowUp:[38, '', true], ArrowRight:[39, '', true], ArrowDown:[40, '', true]});

// Characters removed from the end of `previous` and added after the common start.
export function textChange(previous, current) {
  const before = [...previous], after = [...current];
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  return {removed:before.length - common, added:after.slice(common)};
}

// Windows virtual-key code of a typed character: the key itself for Latin
// letters, digits and space; VK_PACKET (0xE7) carries any other character.
export function virtualKey(char) {
  return /^[a-z0-9 ]$/i.test(char) ? char.toUpperCase().charCodeAt(0) : 0xe7;
}

// key(type, keyCode, text, extended) delivers one key event to the game.
export function attachTouchKeyboard(field, key) {
  let last = SENTINEL;
  const press = (keyCode, text = '', extended = false) => { key('keydown', keyCode, text, extended); key('keyup', keyCode, '', extended); };
  const reset = () => {
    field.value = SENTINEL; last = SENTINEL;
    try { field.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch {}
  };
  field.addEventListener('focus', reset);
  field.addEventListener('input', event => {
    const {removed, added} = textChange(last, field.value);
    for (let i = 0; i < removed; i++) press(8, '\b');
    for (const char of added) press(virtualKey(char), char);
    last = field.value;
    // Mid-word the keyboard still edits the composed text: keep it until then.
    if (!event.isComposing && (field.value.length < SENTINEL.length || field.value.length > 64)) reset();
  });
  field.addEventListener('compositionend', () => { if (field.value.length > 64) reset(); });
  // Keys that do not type: Enter opens and sends Warcraft chat, Escape cancels.
  field.addEventListener('keydown', event => {
    const special = event.isComposing ? null : SPECIAL[event.key];
    if (!special) return;
    event.preventDefault();
    press(...special);
  });
  return {reset};
}
