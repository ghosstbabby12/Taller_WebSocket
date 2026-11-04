/** Catálogo electoral indexado para los selectores y para ubicar una mesa. */
export async function loadCatalog() {
  const response = await fetch('/api/public/catalog');
  if (!response.ok) throw new Error(`Catálogo no disponible (${response.status})`);
  const { mesas } = await response.json();
  return indexCatalog(mesas);
}

export function indexCatalog(rows) {
  const locationByMesa = new Map();
  const municipioByPuesto = new Map();
  const puestosByMunicipio = new Map();

  for (const [mesa, puesto, municipio] of rows) {
    locationByMesa.set(mesa, { puesto, municipio });
    municipioByPuesto.set(puesto, municipio);
    if (!puestosByMunicipio.has(municipio)) puestosByMunicipio.set(municipio, new Set());
    puestosByMunicipio.get(municipio).add(puesto);
  }

  return {
    locationOf: (mesa) => locationByMesa.get(mesa),
    municipioOf: (puesto) => municipioByPuesto.get(puesto),
    municipios: () => [...puestosByMunicipio.keys()].sort((a, b) => a - b),
    puestosOf: (municipio) => [...(puestosByMunicipio.get(municipio) ?? [])].sort((a, b) => a - b),
  };
}

/** `dep`, `mun:11` o `puesto:176`. Cualquier otra cosa vuelve al departamento. */
export function parseTopic(value) {
  return /^(dep|mun:[1-9]\d*|puesto:[1-9]\d*)$/.test(value ?? '') ? value : 'dep';
}
