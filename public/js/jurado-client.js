import { fullJitterDelay } from './backoff.js';
import { outbox } from './outbox.js';

const ACK_TIMEOUT_MS = 10000;
const UNAUTHORIZED_CLOSE_CODE = 4401;

/**
 * Transmite la cola hasta recibir respuesta definitiva. Un acta solo sale de la cola con un ack o un
 * rechazo no reintentable: si la conexión cae antes de la respuesta, se reenvía con el MISMO `idem`.
 */
export class JuradoClient {
  constructor({ token, onItemUpdate, onConnection, onUnauthorized }) {
    this.token = token;
    this.onItemUpdate = onItemUpdate;
    this.onConnection = onConnection;
    this.onUnauthorized = onUnauthorized;
    this.attempt = 0;
    this.inFlight = new Map();
    window.addEventListener('online', () => this.connectNow());
  }

  async start() {
    for (const item of await outbox.all()) this.onItemUpdate(item, { state: 'pending' });
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  /** `idem` se fija una sola vez, al encolar: es lo que hace seguro cualquier reintento. */
  async enqueue(acta) {
    await outbox.put(acta);
    this.onItemUpdate(acta, { state: 'pending' });
    this.flush();
  }

  connectNow() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.connect();
  }

  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/jurado`);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: this.token }));
    socket.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
    socket.onclose = (event) => {
      this.ready = false;
      this.inFlight.forEach(clearTimeout);
      this.inFlight.clear();
      // Token vencido o inválido: reintentar no sirve. La cola se conserva para el próximo ingreso.
      if (event.code === UNAUTHORIZED_CLOSE_CODE) {
        this.stop();
        this.onUnauthorized();
        return;
      }
      if (this.stopped) return;
      this.onConnection('offline');
      this.reconnectTimer = setTimeout(() => this.connect(), fullJitterDelay(this.attempt++));
    };
  }

  async flush() {
    if (!this.ready) return;
    for (const acta of await outbox.all()) {
      if (this.inFlight.has(acta.idem)) continue;
      this.socket.send(JSON.stringify({ type: 'acta.submit', reqId: acta.idem, acta }));
      // Sin respuesta a tiempo, la conexión no sirve aunque parezca abierta: se fuerza el reintento.
      this.inFlight.set(
        acta.idem,
        setTimeout(() => this.socket.close(), ACK_TIMEOUT_MS),
      );
    }
  }

  async handleMessage(message) {
    if (message.type === 'hello.ok') {
      this.attempt = 0;
      this.ready = true;
      this.onConnection('online');
      this.flush();
      return;
    }
    if (message.type !== 'acta.ack' && message.type !== 'acta.nack') return;
    clearTimeout(this.inFlight.get(message.reqId));
    this.inFlight.delete(message.reqId);

    const item = (await outbox.all()).find(({ idem }) => idem === message.reqId);
    if (!item) return;
    if (message.type === 'acta.ack') {
      await outbox.remove(item.idem);
      this.onItemUpdate(item, { state: 'done', status: message.status, receipt: message });
    } else if (message.retryable) {
      this.onItemUpdate(item, { state: 'pending', code: message.code });
      setTimeout(() => this.flush(), message.retryAfterMs ?? fullJitterDelay(this.attempt++));
    } else {
      await outbox.remove(item.idem);
      this.onItemUpdate(item, { state: 'rejected', code: message.code });
    }
  }
}
