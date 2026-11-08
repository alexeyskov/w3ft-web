// Reliable frame transport only. Warcraft's TCP/UDP Winsock shim is separate.
export class FrameTransport extends EventTarget {
  // room 'auto': the server seats the player in the first shared lobby of the
  // given language with a free seat; the welcome message names the lobby.
  constructor(room, {publicLobby = false, language = null} = {}) {
    super();
    if (room !== 'auto' && !/^[A-Za-z0-9_-]{8,64}$/.test(room)) throw new Error('Код комнаты: 8–64 латинских буквы, цифры, _ или -');
    this.room = room;
    this.publicLobby = publicLobby;
    this.language = language;
    this.socket = null;
    this.peerId = 0;
    this.peerIds = [];
    this.lobby = null;
    this.presenceToken = null;
  }

  async connect() {
    if (this.socket) throw new Error('Transport already connected');
    const url = new URL(`/api/relay/${this.room}`, location.href);
    if (this.publicLobby) url.searchParams.set('lobby', '1');
    if (this.room === 'auto' && this.language) url.searchParams.set('language', this.language);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Таймаут подключения комнаты')); }, 10000);
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Не удалось подключиться к комнате')); });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        reject(new Error('Соединение с комнатой закрыто'));
        if (this.socket === socket) {
          this.socket = null;
          this.peerId = 0;
          this.peerIds = [];
          this.lobby = null;
          this.presenceToken = null;
          this.dispatchEvent(new Event('disconnect'));
        }
      });
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (message.type === 'welcome') {
            this.room = message.room;
            this.peerId = message.peerId;
            this.peerIds = message.peers || [message.peerId];
            this.lobby = message.lobby || null;
            this.presenceToken = message.presenceToken || null;
            clearTimeout(timeout);
            resolve(this);
          } else if (message.type === 'peers') {
            this.peerIds = message.peers;
            if (this.lobby) this.lobby = {...this.lobby, players: message.peers.length};
            this.dispatchEvent(new CustomEvent('peers', {detail: message.peers}));
          }
        } else {
          const bytes = new Uint8Array(event.data);
          this.dispatchEvent(new CustomEvent('packet', {detail: {source: bytes[0], data: bytes.subarray(1)}}));
        }
      });
    });
  }

  send(destination, data) {
    if (!Number.isInteger(destination) || destination < 0 || destination > 254) throw new Error('Invalid peer');
    if (!(data instanceof Uint8Array) || !data.length || data.length > 65535) throw new Error('Invalid packet');
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Соединение с комнатой отсутствует');
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) throw new Error('Сетевая очередь переполнена');
    const packet = new Uint8Array(data.length + 1);
    packet[0] = destination;
    packet.set(data, 1);
    this.socket.send(packet);
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.peerId = 0;
    this.peerIds = [];
    this.lobby = null;
    this.presenceToken = null;
    socket?.close();
    if (socket) this.dispatchEvent(new Event('disconnect'));
  }
}
