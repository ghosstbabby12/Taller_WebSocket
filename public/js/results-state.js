/**
 * Estado del cliente público, sin dependencias del navegador. `prev` encadena las entradas de cada
 * tópico: si no coincide con lo que se tiene, hay un hueco y solo el servidor puede repararlo.
 */
export function createResultsState() {
  const topics = new Map();

  const ensure = (topic) => {
    if (!topics.has(topic)) topics.set(topic, { seq: undefined, values: {}, corrections: [] });
    return topics.get(topic);
  };

  return {
    /** Reemplaza todo el tópico. @param {any} snapshot */
    applySnapshot(snapshot) {
      const { topic, seq, state, corrections = [] } = snapshot;
      const entry = ensure(topic);
      if (entry.seq !== undefined && seq < entry.seq) return 'ignored';
      entry.seq = seq;
      entry.values = { ...state };
      entry.corrections = corrections;
      return 'applied';
    },

    /** Devuelve 'applied', 'ignored' (ya visto) o 'gap' (hay que reconectar con el cursor). @param {any} delta */
    applyDelta(delta) {
      const { topic, seq, prev, changes, corrections = [] } = delta;
      const entry = ensure(topic);
      if (entry.seq === undefined) return 'gap';
      if (seq <= entry.seq) return 'ignored';
      if (prev > entry.seq) return 'gap';
      Object.assign(entry.values, changes);
      entry.seq = seq;
      entry.corrections = [...corrections.slice().reverse(), ...entry.corrections].slice(0, 20);
      return 'applied';
    },

    cursor: (topic) => topics.get(topic)?.seq,
    view: (topic) => topics.get(topic),
  };
}

/** Candidatos de mayor a menor y porcentaje de mesas informadas de un tópico. */
export function summarize(values) {
  const ranking = Object.entries(values)
    .filter(([field]) => field.startsWith('v:C'))
    .map(([field, votes]) => ({ candidate: field.slice(2), votes }))
    .sort((a, b) => b.votes - a.votes);
  const informed = values.mesas_informadas ?? 0;
  const total = values.mesas_totales ?? 0;
  return {
    ranking,
    informed,
    total,
    percent: total > 0 ? (informed / total) * 100 : 0,
    inReview: values.en_verificacion ?? 0,
  };
}
