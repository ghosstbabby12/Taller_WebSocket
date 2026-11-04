import { JuradoClient } from './jurado-client.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'jurado.token';

// Lo que el jurado lee: nunca debe quedar en duda si su acta quedó registrada (RF-1).
const STATUS_TEXT = {
  registered: 'Registrada.',
  in_review: 'Registrada. Los totales no cuadran y pasó a verificación.',
  duplicate: 'Ya estaba registrada. No necesita volver a enviarla.',
  superseded: 'Ya hay una versión posterior de esta acta.',
  conflict: 'Registrada, pero contradice otro envío de la misma versión. Pasó a verificación.',
};

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

let client;

function renderItem(acta, { state, status, code }) {
  const id = `item-${acta.idem}`;
  const row = document.getElementById(id) ?? Object.assign(document.createElement('li'), { id });
  $('items').prepend(row);
  const label = `${acta.acta} v${acta.version}: `;
  if (state === 'done') {
    row.className = 'status-ok';
    row.textContent = label + STATUS_TEXT[status];
  } else if (state === 'rejected') {
    row.className = 'status-error';
    row.textContent = `${label}rechazada (${code}). Revise los datos y envíela de nuevo.`;
  } else {
    row.className = 'status-pending';
    row.textContent = `${label}NO registrada todavía. Se enviará sola cuando haya red.`;
  }
}

function startClient(token) {
  $('login').hidden = true;
  $('form').hidden = false;
  client = new JuradoClient({
    token,
    onItemUpdate: renderItem,
    onConnection: (state) => {
      $('connection').textContent = state === 'online' ? 'Conectado' : 'Sin conexión';
    },
  });
  client.start();
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: 'jurado',
      subject: $('jurado').value,
      accessCode: $('code').value,
    }),
  });
  if (!response.ok) {
    $('connection').textContent = 'Credenciales inválidas';
    return;
  }
  const { token } = await response.json();
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem('jurado.id', $('jurado').value);
  } catch {
    // Sin almacenamiento solo se pierde la comodidad de no volver a iniciar sesión.
  }
  startClient(token);
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const acta = JSON.parse($('payload').value);
  acta.idem = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  await client.enqueue(acta);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

const saved = readToken();
if (saved) startClient(saved);
