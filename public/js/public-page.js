import { loadCatalog, parseTopic } from './catalog.js';
import { summarize } from './results-state.js';
import { ResultsStream } from './results-stream.js';

const $ = (id) => document.getElementById(id);
const formatNumber = new Intl.NumberFormat('es-CO');
const formatPercent = new Intl.NumberFormat('es-CO', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const formatTime = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const CONNECTION_LABEL = {
  connecting: 'Conectando…',
  online: 'En vivo',
  reconnecting: 'Reconectando…',
};

let catalog = null;
let stream = null;
let topic = parseTopic(new URLSearchParams(location.search).get('topic'));

const candidateLabel = (id) => `Candidato ${id.slice(1)}`;

function scopeTitle(currentTopic) {
  if (currentTopic === 'dep') return 'Departamento';
  const [kind, id] = currentTopic.split(':');
  if (kind === 'mun') return `Municipio ${id}`;
  const municipio = catalog?.municipioOf(Number(id));
  return municipio ? `Puesto ${id} · Municipio ${municipio}` : `Puesto ${id}`;
}

// Se dibuja como mucho una vez por cuadro: en un teléfono de gama baja, una ráfaga de eventos no
// debe convertirse en una ráfaga de trabajo de layout que estropee el INP (RT-9).
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function renderConnection({ connection, redis, instance }) {
  if (connection) {
    $('connection').textContent = CONNECTION_LABEL[connection];
    $('connection-pill').dataset.state = connection;
  }
  if (redis) $('degraded').hidden = redis !== 'down';
  if (instance) $('instance').textContent = instance;
}

/** Filas por candidato reutilizadas, para que la barra anime en lugar de reconstruirse. */
const candidateRows = new Map();

function candidateRow(candidate) {
  let row = candidateRows.get(candidate);
  if (!row) {
    row = $('candidate-template').content.firstElementChild.cloneNode(true);
    row.querySelector('.candidate-name').textContent = candidateLabel(candidate);
    candidateRows.set(candidate, row);
  }
  return row;
}

function renderRanking(ranking) {
  const totalVotes = ranking.reduce((sum, { votes }) => sum + votes, 0);
  const rows = ranking.map(({ candidate, votes }, index) => {
    const row = candidateRow(candidate);
    const share = totalVotes > 0 ? (votes / totalVotes) * 100 : 0;
    row.classList.toggle('is-leader', index === 0 && votes > 0);
    row.querySelector('.candidate-votes').textContent = formatNumber.format(votes);
    row.querySelector('.candidate-share').textContent = `${formatPercent.format(share)} %`;
    row.querySelector('.bar-fill').style.transform = `scaleX(${share / 100})`;
    return row;
  });
  $('ranking').replaceChildren(...rows);
  $('ranking-empty').hidden = rows.length > 0;
  $('ranking-note').hidden = rows.length === 0;
}

function correctionItem({ acta, fromVersion, toVersion, reason, at }) {
  const item = document.createElement('li');
  const text = document.createElement('p');
  text.textContent =
    reason === 'correction'
      ? `Se corrigió el acta ${acta}: la versión ${toVersion} reemplazó a la ${fromVersion}.`
      : `El acta ${acta} salió del conteo mientras se verifica.`;
  const time = document.createElement('time');
  time.dateTime = new Date(at).toISOString();
  time.textContent = formatTime.format(at);
  item.append(text, time);
  return item;
}

function render() {
  const view = stream.state.view(topic);
  if (!view) return;
  const { ranking, informed, total, percent, inReview, voters, otherVotes } = summarize(
    view.values,
  );

  $('percent').textContent = `${formatPercent.format(percent)} %`;
  $('informed').textContent = `${formatNumber.format(informed)} de ${formatNumber.format(total)}`;
  $('progress-fill').style.transform = `scaleX(${percent / 100})`;
  $('progress').setAttribute('aria-valuenow', percent.toFixed(1));
  $('voters').textContent = formatNumber.format(voters);
  $('review').textContent = formatNumber.format(inReview);
  $('blank').textContent = formatNumber.format(otherVotes.blank);
  $('invalid').textContent = formatNumber.format(otherVotes.invalid);
  $('unmarked').textContent = formatNumber.format(otherVotes.unmarked);
  $('updated').textContent = formatTime.format(Date.now());

  renderRanking(ranking);

  $('corrections').replaceChildren(...view.corrections.map(correctionItem));
  $('corrections-empty').hidden = view.corrections.length > 0;
}

function connect() {
  stream?.stop();
  candidateRows.clear();
  $('ranking').replaceChildren();
  $('title').textContent = scopeTitle(topic);
  document.title = `${scopeTitle(topic)} · Preconteo`;
  renderConnection({ connection: 'connecting' });
  stream = new ResultsStream({
    topics: [topic],
    onChange: scheduleRender,
    onStatus: renderConnection,
  });
  stream.start();
}

function changeTopic(next) {
  if (next === topic) return;
  topic = next;
  const url = next === 'dep' ? location.pathname : `${location.pathname}?topic=${next}`;
  history.pushState(null, '', url);
  syncSelectors();
  connect();
}

function fillSelect(select, placeholder, values, label) {
  const options = values.map((value) => new Option(label(value), String(value)));
  select.replaceChildren(new Option(placeholder, ''), ...options);
}

/** Refleja el tópico actual en los dos selectores; el de puesto depende del municipio. */
function syncSelectors() {
  if (!catalog) return;
  const [kind, id] = topic.split(':');
  const municipio =
    kind === 'mun' ? Number(id) : kind === 'puesto' ? catalog.municipioOf(Number(id)) : null;

  $('municipio').value = municipio ? String(municipio) : '';
  fillSelect(
    $('puesto'),
    'Todos',
    municipio ? catalog.puestosOf(municipio) : [],
    (value) => `Puesto ${value}`,
  );
  $('puesto').disabled = !municipio;
  $('puesto').value = kind === 'puesto' ? id : '';
}

$('municipio').addEventListener('change', (event) => {
  changeTopic(event.target.value ? `mun:${event.target.value}` : 'dep');
});

$('puesto').addEventListener('change', (event) => {
  const municipio = $('municipio').value;
  changeTopic(event.target.value ? `puesto:${event.target.value}` : `mun:${municipio}`);
});

window.addEventListener('popstate', () => {
  topic = parseTopic(new URLSearchParams(location.search).get('topic'));
  syncSelectors();
  connect();
});

connect();

loadCatalog()
  .then((loaded) => {
    catalog = loaded;
    fillSelect($('municipio'), 'Todos', catalog.municipios(), (value) => `Municipio ${value}`);
    syncSelectors();
    $('title').textContent = scopeTitle(topic);
  })
  .catch(() => {
    // Sin catálogo, los resultados siguen en vivo: solo se pierde la navegación por selectores.
    $('scope').hidden = true;
  });
