import { summarize } from './results-state.js';
import { ResultsStream } from './results-stream.js';

const params = new URLSearchParams(location.search);
const topic = params.get('topic') ?? 'dep';
const $ = (id) => document.getElementById(id);

$('topic').textContent = topic === 'dep' ? 'Departamento' : topic;

// Se dibuja como mucho una vez por cuadro: en un teléfono de gama baja, una ráfaga de eventos no
// debe convertirse en una ráfaga de trabajo de layout que estropee el INP (RT-9).
let renderScheduled = false;
const scheduleRender = () => {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
};

const stream = new ResultsStream({
  topics: [topic],
  onChange: scheduleRender,
  onStatus: ({ connection, redis, instance }) => {
    if (connection)
      $('connection').textContent = connection === 'online' ? 'En vivo' : 'Reconectando…';
    if (redis) $('degraded').hidden = redis !== 'down';
    if (instance) $('instance').textContent = instance;
  },
});

function render() {
  const view = stream.state.view(topic);
  if (!view) return;
  const { ranking, informed, total, percent, inReview } = summarize(view.values);
  $('informed').textContent = `${informed} de ${total} mesas (${percent.toFixed(2)} %)`;
  $('review').textContent = `${inReview} actas en verificación, aún sin sumar`;

  const totalVotes = ranking.reduce((sum, { votes }) => sum + votes, 0);
  $('ranking').replaceChildren(
    ...ranking.map(({ candidate, votes }) => {
      const row = document.createElement('li');
      const share = totalVotes > 0 ? (votes / totalVotes) * 100 : 0;
      row.textContent = `${candidate}: ${votes.toLocaleString('es-CO')} (${share.toFixed(1)} %)`;
      return row;
    }),
  );
  $('corrections').replaceChildren(
    ...view.corrections.map(({ acta, fromVersion, toVersion, reason }) => {
      const row = document.createElement('li');
      row.textContent =
        reason === 'correction'
          ? `Acta ${acta} corregida (v${fromVersion} → v${toVersion}).`
          : `Acta ${acta} retirada del conteo mientras se verifica.`;
      return row;
    }),
  );
}

stream.start();
