/** Geografía electoral del enunciado. El reparto es sintético pero determinista. */
export const CATALOG_SIZE = { mesas: 6_400, puestos: 1_842, municipios: 115 } as const;

export interface MesaLocation {
  mesa: number;
  puesto: number;
  municipio: number;
}

/** El mensaje de ejemplo de la sección 3.1 debe aceptarse tal cual durante la sustentación. */
const ENUNCIADO_EXAMPLE = { mesa: 4201, puesto: 176 } as const;

const municipioOf = (puesto: number, size: typeof CATALOG_SIZE) =>
  Math.ceil((puesto * size.municipios) / size.puestos);

export function buildCatalog(size = CATALOG_SIZE): MesaLocation[] {
  const puestoOfMesa = Array.from({ length: size.mesas }, (_, index) =>
    Math.ceil(((index + 1) * size.puestos) / size.mesas),
  );

  // Intercambio con una mesa del puesto 176 para que la mesa 4201 quede allí sin alterar conteos.
  const exampleIndex = ENUNCIADO_EXAMPLE.mesa - 1;
  const swapIndex = puestoOfMesa.indexOf(ENUNCIADO_EXAMPLE.puesto);
  const displaced = puestoOfMesa[exampleIndex]!;
  puestoOfMesa[exampleIndex] = ENUNCIADO_EXAMPLE.puesto;
  puestoOfMesa[swapIndex] = displaced;

  return puestoOfMesa.map((puesto, index) => ({
    mesa: index + 1,
    puesto,
    municipio: municipioOf(puesto, size),
  }));
}
