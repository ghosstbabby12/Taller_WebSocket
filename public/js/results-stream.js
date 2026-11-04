import { fullJitterDelay } from './backoff.js';
import { createResultsState } from './results-state.js';

/**
 * Conexión SSE con continuidad (RF-6). No se usa la reconexión nativa de EventSource porque reintenta
 * con un intervalo fijo, lo que sincroniza a todos los clientes, y porque solo guarda un Last-Event-ID
 * cuando aquí hace falta un cursor por tópico. Cada intento lleva los cursores en la URL.
 */
export class ResultsStream {
  constructor({ topics, onChange, onStatus, baseUrl = '' }) {
    this.topics = topics;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.baseUrl = baseUrl;
    this.state = createResultsState();
    this.attempt = 0;
  }

  start() {
    const cursors = this.topics.map((topic) => this.state.cursor(topic) ?? '').join(',');
    const url = `${this.baseUrl}/api/public/stream?topics=${this.topics.join(',')}&cursors=${cursors}`;
    this.source = new EventSource(url);

    this.source.addEventListener('hello', (event) => {
      this.attempt = 0;
      this.onStatus({ connection: 'online', ...JSON.parse(event.data) });
    });
    this.source.addEventListener('status', (event) => this.onStatus(JSON.parse(event.data)));
    this.source.addEventListener('snapshot', (event) => {
      const snapshot = JSON.parse(event.data);
      if (this.state.applySnapshot(snapshot) === 'applied') this.onChange(snapshot.topic);
    });
    this.source.addEventListener('delta', (event) => {
      const delta = JSON.parse(event.data);
      const result = this.state.applyDelta(delta);
      if (result === 'applied') this.onChange(delta.topic);
      else if (result === 'gap') this.reconnect();
    });
    this.source.addEventListener('goaway', () => this.reconnect());
    this.source.onerror = () => this.reconnect();
  }

  /** Cierra para siempre, por ejemplo al cambiar de tópico: no vuelve a reconectar. */
  stop() {
    this.stopped = true;
    this.source?.close();
    clearTimeout(this.timer);
  }

  reconnect() {
    if (this.stopped) return;
    this.source?.close();
    clearTimeout(this.timer);
    this.onStatus({ connection: 'reconnecting' });
    this.timer = setTimeout(() => this.start(), fullJitterDelay(this.attempt++));
  }
}
