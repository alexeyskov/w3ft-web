// "Playing now": anonymous live counts from the server. The page reports only
// whether its own game is running and whether that game uses a site LAN lobby.
export class PresenceCounter extends EventTarget {
  constructor() {
    super();
    this.state = {playing:false, lan:false, presenceToken:null};
    this.counts = null; this.socket = null; this.retry = 1000; this.timer = null;
    this.lobbies = null;
  }
  start() { this.stopped = false; if (!this.socket) this.connect(); return this; }
  // Closing the page closes the connection at once, so the counts drop now
  // rather than after the server's ping timeout.
  stop() {
    this.stopped = true; clearTimeout(this.timer); this.timer = null;
    const socket = this.socket; this.socket = null; socket?.close();
    this.lobbies = null;
    if (this.counts) { this.counts = null; this.dispatchEvent(new Event('change')); }
  }
  update({playing, lan, presenceToken = null}) {
    this.state = {playing:!!playing, lan:!!playing && !!lan,
      presenceToken:playing && lan ? presenceToken : null};
    this.send();
  }
  send() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(this.state));
  }
  connect() {
    clearTimeout(this.timer); this.timer = null;
    const url = new URL('/api/presence', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try { socket = this.socket = new WebSocket(url); } catch { this.reconnect(); return; }
    socket.onopen = () => { if (this.socket !== socket) return; this.retry = 1000; this.send(); };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type !== 'presence' || ![message.online, message.playing, message.lan].every(Number.isSafeInteger)) return;
      this.counts = {online:message.online, playing:message.playing, lan:message.lan};
      this.lobbies = Array.isArray(message.lobbies) ? {lobbies:message.lobbies, privatePlayers:message.privatePlayers ?? 0} : null;
      this.dispatchEvent(new Event('change'));
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.lobbies = null;
      if (this.counts) { this.counts = null; this.dispatchEvent(new Event('change')); }
      this.reconnect();
    };
  }
  reconnect() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(30000, this.retry * 2);
  }
}
