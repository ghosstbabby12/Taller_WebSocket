import type { Acta } from '../../domain/acta.js';
import { fingerprint, isDoubtful, verificationPriority } from '../../domain/acta.js';
import type { HistoryEntry } from '../../domain/recovery.js';
import type {
  Correction,
  SubmissionResult,
  TopicDelta,
  TopicSnapshot,
} from '../../domain/results.js';
import { scopesOf, type Topic } from '../../domain/topics.js';
import { KEY_PREFIX, keys } from './keys.js';
import type { ScriptedRedis } from './scripts.js';

const RANKING_SIZE = 20;
const CORRECTIONS_PER_TOPIC = 20;
/** Más que la jornada: nadie necesita el historial al día siguiente, y no debe quedar para siempre. */
const HISTORY_TTL_SECONDS = 24 * 3600;

export interface FlushResult {
  seq: number;
  published: number;
  lagMs: number;
}

export interface RecoveryRead {
  topic: Topic;
  currentSeq: number;
  entries: (HistoryEntry & TopicDelta)[];
}

/** cjson codifica un arreglo vacío como {}: se normaliza al leer. */
const asArray = <T>(value: T[] | Record<string, never>): T[] => (Array.isArray(value) ? value : []);

export class ResultsRepository {
  constructor(
    private readonly redis: ScriptedRedis,
    private readonly options: { idemTtlSeconds: number; historyMaxEntries: number },
  ) {}

  async submit(acta: Acta): Promise<SubmissionResult> {
    const scopes = scopesOf(acta);
    const input = {
      acta: acta.acta,
      version: acta.version,
      fp: fingerprint(acta),
      doubtful: isDoubtful(acta),
      priority: verificationPriority(acta),
      votos: acta.votos,
      sufragantes: acta.sufragantes,
      mesa: acta.mesa,
      puesto: acta.puesto,
      municipio: acta.municipio,
      jurado: acta.jurado,
      hash_foto: acta.hash_foto,
      idem: acta.idem,
      idemTtl: this.options.idemTtlSeconds,
      location: `${acta.puesto}:${acta.municipio}`,
      scopes: {
        mesa: scopes.mesa,
        puesto: scopes.puesto,
        mun: scopes.municipio,
        dep: scopes.departamento,
      },
    };
    const raw: string = await this.redis.submitActa(
      keys.acta(acta.acta),
      keys.idem(acta.idem),
      keys.tally(scopes.mesa),
      keys.tally(scopes.puesto),
      keys.tally(scopes.municipio),
      keys.tally(scopes.departamento),
      keys.dirtyScopes,
      keys.verificationQueue,
      keys.pendingCorrections,
      keys.oldestUnpublished,
      keys.catalog,
      keys.actasPerMinute,
      JSON.stringify(input),
    );
    return JSON.parse(raw) as SubmissionResult;
  }

  /** Devuelve `null` si otra instancia ya publicó esta ventana o no hubo cambios. */
  async flushWindow(guardTtlMs: number, instanceId: string): Promise<FlushResult | null> {
    const raw: string | null = await this.redis.flushWindow(
      keys.flushGuard,
      keys.dirtyScopes,
      keys.sequence,
      keys.pendingCorrections,
      keys.oldestUnpublished,
      keys.publishLagMs,
      KEY_PREFIX,
      guardTtlMs,
      instanceId,
      this.options.historyMaxEntries,
      HISTORY_TTL_SECONDS,
      CORRECTIONS_PER_TOPIC,
    );
    return raw ? (JSON.parse(raw) as FlushResult) : null;
  }

  async readSnapshots(topics: readonly Topic[]): Promise<TopicSnapshot[]> {
    const raw: string = await this.redis.readSnapshot(
      KEY_PREFIX,
      JSON.stringify(topics),
      RANKING_SIZE,
    );
    const rows = JSON.parse(raw) as {
      topic: Topic;
      fields: string[] | Record<string, never>;
      ranking: string[] | Record<string, never>;
      corrections: string[] | Record<string, never>;
    }[];
    return rows.map(({ topic, fields, ranking, corrections }) => {
      const { seq = 0, ...state } = pairsToNumbers(asArray(fields));
      const rankingPairs = asArray(ranking);
      return {
        topic,
        seq,
        state,
        ranking: Array.from({ length: rankingPairs.length / 2 }, (_, i) => ({
          candidate: rankingPairs[i * 2]!,
          votes: Number(rankingPairs[i * 2 + 1]),
        })),
        corrections: asArray(corrections).map((c) => JSON.parse(c) as Correction),
      };
    });
  }

  /** Lee hasta `limit` entradas por tópico posteriores a su cursor. */
  async readRecovery(
    requests: readonly { topic: Topic; cursor: number | undefined }[],
    limit: number,
  ): Promise<RecoveryRead[]> {
    const raw: string = await this.redis.readRecovery(KEY_PREFIX, JSON.stringify(requests), limit);
    const rows = JSON.parse(raw) as {
      topic: Topic;
      currentSeq: number;
      entries: string[] | Record<string, never>;
    }[];
    return rows.map(({ topic, currentSeq, entries }) => ({
      topic,
      currentSeq,
      entries: asArray(entries).map((entry) => JSON.parse(entry) as TopicDelta),
    }));
  }

  async currentSeq(topic: Topic): Promise<number> {
    return Number((await this.redis.hget(keys.pub(topic), 'seq')) ?? 0);
  }
}

function pairsToNumbers(pairs: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (let i = 0; i < pairs.length; i += 2) result[pairs[i]!] = Number(pairs[i + 1]);
  return result;
}
