/** Tópicos públicos a los que un cliente puede suscribirse (RF-5). */
export type Topic = 'dep' | `mun:${number}` | `puesto:${number}`;

export const MAX_TOPICS_PER_CONNECTION = 4;

const TOPIC_PATTERN = /^(dep|mun:[1-9]\d{0,3}|puesto:[1-9]\d{0,4})$/;

export const isTopic = (value: string): value is Topic => TOPIC_PATTERN.test(value);

/** Los cuatro niveles de acumulado que modifica un acta (RF-3). */
export const scopesOf = (a: { mesa: number; puesto: number; municipio: number }) => ({
  mesa: `mesa:${a.mesa}`,
  puesto: `puesto:${a.puesto}`,
  municipio: `mun:${a.municipio}`,
  departamento: 'dep',
});
