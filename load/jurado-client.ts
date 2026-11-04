import { WebSocket } from 'ws';

export interface SubmitReply {
  type: 'acta.ack' | 'acta.nack';
  reqId: string;
  status?: string;
  code?: string;
  retryable?: boolean;
  receivedAt?: number;
}

/** Cliente WebSocket de jurado sin navegador, para el smoke test y la prueba de carga. */
export class JuradoTestClient {
  private socket!: WebSocket;
  private readonly pending = new Map<string, (reply: SubmitReply) => void>();
  instance = '';

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/jurado`;
    this.socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.once('open', () => {
        this.socket.send(JSON.stringify({ type: 'hello', token: this.token }));
      });
      this.socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'hello.ok') {
          this.instance = message.instance;
          resolve();
          return;
        }
        this.pending.get(message.reqId)?.(message);
        this.pending.delete(message.reqId);
      });
    });
  }

  submit(acta: { idem: string }, timeoutMs = 8_000): Promise<SubmitReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sin respuesta del servidor')), timeoutMs);
      this.pending.set(acta.idem, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.socket.send(JSON.stringify({ type: 'acta.submit', reqId: acta.idem, acta }));
    });
  }

  close(): void {
    this.socket.close();
  }
}
