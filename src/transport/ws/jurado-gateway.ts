import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import type { Principal, TokenService } from '../../application/auth.js';
import { actaSchema } from '../../domain/acta.js';
import type { SubmissionResult } from '../../domain/results.js';
import type { RateLimiter } from '../../infrastructure/redis/rate-limiter.js';
import type { ResultsRepository } from '../../infrastructure/redis/results-repository.js';

const MAX_PAYLOAD_BYTES = 16 * 1024; // La foto no viaja por aquí: solo su hash.
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RATE_WINDOW_MS = 60_000;

export const CloseCode = { Unauthorized: 4401, AuthTimeout: 4408, GoingAway: 1001 } as const;

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), token: z.string() }),
  z.object({ type: z.literal('acta.submit'), reqId: z.string().max(64), acta: z.unknown() }),
]);

export type NackCode =
  | 'INVALID_MESSAGE'
  | 'INVALID_ACTA'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'BACKEND_UNAVAILABLE'
  | 'IDEM_MISMATCH'
  | 'UNKNOWN_MESA';

/** Solo una respuesta `retryable` deja el acta en la cola del cliente. */
const RETRYABLE: ReadonlySet<NackCode> = new Set(['RATE_LIMITED', 'BACKEND_UNAVAILABLE']);

interface JuradoSocket extends WebSocket {
  principal?: Principal;
  isAlive?: boolean;
}

/**
 * Audiencia de jurados por WebSocket (RF-1): tráfico bidireccional con respuesta inequívoca por
 * envío. Cada `acta.submit` recibe exactamente un `acta.ack` o `acta.nack`. Si la instancia muere
 * antes de responder, el cliente no recibe nada, conserva el acta y la reenvía con el mismo `idem`
 * a otra instancia, que responde `duplicate` con los datos del registro original.
 */
export class JuradoGateway {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly results: ResultsRepository,
    private readonly rateLimiter: RateLimiter,
    private readonly tokens: TokenService,
    private readonly options: { submitsPerMinute: number; instanceId: string },
    private readonly onBackendError: (error: unknown) => void,
  ) {
    this.server.on('connection', (socket: JuradoSocket) => this.accept(socket));
  }

  start(): void {
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  get connectionCount() {
    return this.server.clients.size;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(request, socket, head, (client) => {
      this.server.emit('connection', client, request);
    });
  }

  drain(): void {
    clearInterval(this.heartbeatTimer);
    for (const client of this.server.clients) {
      client.close(CloseCode.GoingAway, 'instance shutting down');
    }
  }

  private accept(socket: JuradoSocket): void {
    socket.isAlive = true;
    socket.on('pong', () => (socket.isAlive = true));
    const authTimer = setTimeout(
      () => socket.close(CloseCode.AuthTimeout, 'auth timeout'),
      AUTH_TIMEOUT_MS,
    );
    socket.on('close', () => clearTimeout(authTimer));
    socket.on('error', () => socket.terminate());
    socket.on('message', (raw) => {
      void this.handleMessage(socket, raw, authTimer);
    });
  }

  private async handleMessage(
    socket: JuradoSocket,
    raw: RawData,
    authTimer: NodeJS.Timeout,
  ): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) {
      send(socket, { type: 'acta.nack', reqId: null, code: 'INVALID_MESSAGE', retryable: false });
      return;
    }
    if (message.type === 'hello') {
      const principal = this.tokens.verify(message.token);
      if (principal?.role !== 'jurado') {
        socket.close(CloseCode.Unauthorized, 'invalid token');
        return;
      }
      clearTimeout(authTimer);
      socket.principal = principal;
      send(socket, { type: 'hello.ok', instance: this.options.instanceId });
      return;
    }
    if (!socket.principal) {
      socket.close(CloseCode.Unauthorized, 'hello required');
      return;
    }
    await this.handleSubmit(socket, socket.principal, message.reqId, message.acta);
  }

  private async handleSubmit(
    socket: JuradoSocket,
    principal: Principal,
    reqId: string,
    rawActa: unknown,
  ): Promise<void> {
    const nack = (code: NackCode, extra: Record<string, unknown> = {}) =>
      send(socket, { type: 'acta.nack', reqId, code, retryable: RETRYABLE.has(code), ...extra });

    const parsed = actaSchema.safeParse(rawActa);
    if (!parsed.success) {
      nack('INVALID_ACTA', { issues: parsed.error.issues.map((i) => i.path.join('.')) });
      return;
    }
    if (parsed.data.jurado !== principal.subject) {
      nack('FORBIDDEN');
      return;
    }

    let result: SubmissionResult;
    try {
      const rate = await this.rateLimiter.consume(
        principal.subject,
        this.options.submitsPerMinute,
        RATE_WINDOW_MS,
      );
      if (!rate.allowed) {
        nack('RATE_LIMITED', { retryAfterMs: rate.retryAfterMs });
        return;
      }
      result = await this.results.submit(parsed.data);
    } catch (error) {
      // Incluye el caso ambiguo de un timeout con el script ya aplicado. Es seguro: el reintento con
      // el mismo `idem` no suma dos veces. Lo que nunca se hace es decir «registrada» sin saberlo.
      this.onBackendError(error);
      nack('BACKEND_UNAVAILABLE');
      return;
    }

    if (result.outcome === 'rejected') {
      nack(result.code);
      return;
    }
    const { outcome: _outcome, ...receipt } = result;
    send(socket, { type: 'acta.ack', reqId, ...receipt });
  }

  private checkHeartbeats(): void {
    for (const client of this.server.clients as Set<JuradoSocket>) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }
}

function parseClientMessage(raw: RawData) {
  try {
    const parsed = clientMessageSchema.safeParse(JSON.parse(raw.toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
