import { loadCatalog } from './catalog.js';
import { JuradoClient } from './jurado-client.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'jurado.token';
const JURADO_KEY = 'jurado.id';
/** Corporación del ejemplo del enunciado: el identificador del acta la exige. */
const CORPORACION = '03';
const VOTE_FIELDS = ['C1', 'C2', 'C3', 'BLANCO', 'NULO', 'NO_MARCADO'];

const formatTime = new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' });

// Lo que el jurado lee: nunca debe quedar en duda si su acta quedó registrada (RF-1).
const STATUS_TEXT = {
  registered: 'Registrada.',
  in_review: 'Registrada. Los totales no cuadran: pasó a verificación y aún no suma.',
  duplicate: 'Ya estaba registrada. No necesita volver a enviarla.',
  superseded: 'Ya hay una versión posterior de esta acta. Esta no cambió nada.',
  conflict: 'Registrada, pero contradice otro envío de la misma versión. Pasó a verificación.',
};

const REJECTION_TEXT = {
  INVALID_ACTA: 'Hay datos con formato incorrecto.',
  FORBIDDEN: 'Esta sesión no corresponde al jurado del acta.',
  UNKNOWN_MESA: 'La mesa no pertenece a ese puesto y municipio.',
  IDEM_MISMATCH: 'El envío se repitió con otro contenido.',
};

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Sin almacenamiento solo se pierde la comodidad de no volver a iniciar sesión.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Igual que arriba.
    }
  },
};

let client = null;
let juradoId = null;
let catalog = null;

function renderConnection(state) {
  $('connection').textContent = state === 'online' ? 'Conectado' : 'Sin conexión';
  $('connection-pill').dataset.state = state === 'online' ? 'online' : 'reconnecting';
}

function updatePendingCount() {
  const pending = document.querySelectorAll('#items [data-state="pending"]').length;
  $('pending').hidden = pending === 0;
  $('pending').textContent =
    pending === 1 ? '1 acta por transmitir' : `${pending} actas por transmitir`;
  $('items-empty').hidden = $('items').children.length > 0;
}

function renderItem(acta, { state, status, code, receipt }) {
  const id = `item-${acta.idem}`;
  let row = document.getElementById(id);
  if (!row) {
    row = $('item-template').content.firstElementChild.cloneNode(true);
    row.id = id;
    row.querySelector('.item-title').textContent = `${acta.acta} · versión ${acta.version}`;
    $('items').prepend(row);
  }
  row.dataset.state = state;
  const message = row.querySelector('.item-message');
  if (state === 'done') {
    const time = receipt?.receivedAt
      ? ` Recibida a las ${formatTime.format(receipt.receivedAt)}.`
      : '';
    message.textContent = `${STATUS_TEXT[status]}${time}`;
  } else if (state === 'rejected') {
    message.textContent = `Rechazada. ${REJECTION_TEXT[code] ?? code} Revise y envíela de nuevo.`;
  } else {
    message.textContent = 'NO registrada todavía. Se enviará sola cuando haya red.';
  }
  updatePendingCount();
}

function showSession(token, id) {
  juradoId = id;
  $('login').hidden = true;
  $('session').hidden = false;
  $('jurado-label').textContent = id;
  client = new JuradoClient({
    token,
    onItemUpdate: renderItem,
    onConnection: renderConnection,
    onUnauthorized: () =>
      endSession('Su sesión venció. Ingrese de nuevo: sus actas siguen en cola.'),
  });
  client.start();
}

function endSession(message) {
  client?.stop();
  client = null;
  storage.remove(TOKEN_KEY);
  storage.remove(JURADO_KEY);
  $('session').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message ?? '';
  $('login-error').hidden = !message;
  renderConnection('offline');
}

function votes() {
  return Object.fromEntries(VOTE_FIELDS.map((field) => [field, Number($(field).value || 0)]));
}

function updateLocation() {
  const mesa = Number($('mesa').value);
  const location = catalog?.locationOf(mesa);
  $('mesa-location').textContent = !$('mesa').value
    ? 'Digite el número de la mesa.'
    : location
      ? `Puesto ${location.puesto} · Municipio ${location.municipio}`
      : 'Esa mesa no existe en el catálogo.';
  $('mesa-location').dataset.valid = String(Boolean(location));
  return location;
}

/** Regla contable de 3.1. Un acta descuadrada se puede enviar: la revisa un auditor. */
function updateTotals() {
  const sum = Object.values(votes()).reduce((total, value) => total + value, 0);
  const voters = Number($('sufragantes').value || 0);
  const box = $('totals');
  $('totals-sum').textContent = String(sum);
  if (!$('sufragantes').value) {
    box.dataset.state = 'idle';
    $('totals-message').textContent = 'Digite los sufragantes para comprobar la suma.';
  } else if (sum === voters) {
    box.dataset.state = 'ok';
    $('totals-message').textContent = 'La suma coincide con los sufragantes.';
  } else {
    box.dataset.state = 'warn';
    $('totals-message').textContent =
      `No coincide con ${voters} sufragantes. Si la envía así, irá a verificación y no sumará.`;
  }
}

async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').hidden = true;
  const id = $('jurado').value.trim().toUpperCase();
  let response;
  try {
    response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'jurado', subject: id, accessCode: $('code').value }),
    });
  } catch {
    $('login-error').textContent = 'Sin conexión. Para ingresar la primera vez necesita red.';
    $('login-error').hidden = false;
    return;
  }
  if (!response.ok) {
    $('login-error').textContent =
      response.status === 400
        ? 'El jurado debe tener el formato JUR-88134.'
        : 'Jurado o código de acceso incorrectos.';
    $('login-error').hidden = false;
    return;
  }
  const { token } = await response.json();
  storage.set(TOKEN_KEY, token);
  storage.set(JURADO_KEY, id);
  $('code').value = '';
  showSession(token, id);
});

$('logout').addEventListener('click', () => endSession());
$('mesa').addEventListener('input', updateLocation);
$('form').addEventListener('input', updateTotals);

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const location = updateLocation();
  if (!location) {
    $('mesa').focus();
    return;
  }
  const mesa = Number($('mesa').value);
  await client.enqueue({
    acta: `E14-${location.puesto}-${String(mesa).padStart(4, '0')}-${CORPORACION}`,
    mesa,
    puesto: location.puesto,
    municipio: location.municipio,
    version: Number($('version').value),
    jurado: juradoId,
    ts_cierre: Math.floor(Date.now() / 1000),
    votos: votes(),
    sufragantes: Number($('sufragantes').value),
    hash_foto: await sha256Hex($('foto').files[0]),
    idem: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  });
  event.target.reset();
  updateLocation();
  updateTotals();
  $('items-title').scrollIntoView({ block: 'nearest' });
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

updateTotals();
updatePendingCount();

loadCatalog()
  .then((loaded) => {
    catalog = loaded;
    updateLocation();
  })
  .catch(() => {
    $('mesa-location').textContent = 'No se pudo cargar el catálogo. Conéctese una vez y recargue.';
    $('mesa-location').dataset.valid = 'false';
  });

const savedToken = storage.get(TOKEN_KEY);
const savedJurado = storage.get(JURADO_KEY);
if (savedToken && savedJurado) showSession(savedToken, savedJurado);
