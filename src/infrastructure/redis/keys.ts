/**
 * Único lugar donde se construyen nombres de clave. Todo vive en una sola base lógica: los scripts
 * Lua tocan claves dinámicas (flush_window), lo que impide repartirlas en un Redis Cluster.
 */
export const KEY_PREFIX = 'el:';

const key = (suffix: string) => `${KEY_PREFIX}${suffix}`;

export const keys = {
  acta: (id: string) => key(`acta:${id}`),
  idem: (idem: string) => key(`idem:${idem}`),
  tally: (scope: string) => key(`tally:${scope}`),
  pub: (scope: string) => key(`pub:${scope}`),
  rank: (scope: string) => key(`rank:${scope}`),
  history: (scope: string) => key(`hist:${scope}`),
  corrections: (scope: string) => key(`corr:${scope}`),
  channel: (scope: string) => key(`ch:${scope}`),
  rateLimit: (credential: string, window: number) => key(`rl:${credential}:${window}`),
  metricsInstance: (instanceId: string) => key(`metrics:instance:${instanceId}`),

  catalog: key('catalog'),
  seedDone: key('seed:done'),
  dirtyScopes: key('dirty'),
  sequence: key('seq'),
  flushGuard: key('flush:guard'),
  pendingCorrections: key('corrections:pending'),
  oldestUnpublished: key('oldest'),
  publishLagMs: key('metrics:publish_lag_ms'),
  actasPerMinute: key('metrics:actas_per_minute'),
  messagesTotal: key('metrics:messages_total'),
  metricsInstances: key('metrics:instances'),
  verificationQueue: key('verify:queue'),
} as const;

export const scopeFromChannel = (channel: string) => channel.slice(keys.channel('').length);
