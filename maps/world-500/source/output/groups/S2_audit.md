# S2 audit (seats 485-497, northern/western South America)

## 1. Partition check
| ADM0 | Seats |
|---|---|
| Colombia (33 ADM1) | 485: Bogotá D.C., Cundinamarca, Boyacá, Santander, Norte de Santander (5). 486: Antioquia, Córdoba, Sucre, Bolívar, Atlántico, Magdalena, Cesar, La Guajira, San Andrés y Providencia (9). 487: Valle del Cauca, Cauca, Nariño, Putumayo, Chocó, Caldas, Risaralda, Quindío, Tolima, Huila, Caquetá, Meta, Casanare, Arauca, Vichada, Guaviare, Amazonas, Guainía, Vaupés (19). 5+9+19 = 33. |
| Peru (25 ADM1) | 491: Lima, Callao, Áncash, La Libertad, Ica (5). 492: other 20 (Tumbes, Piura, Lambayeque, Cajamarca, Amazonas, San Martín, Loreto, Ucayali, Huánuco, Pasco, Junín, Huancavelica, Ayacucho, Apurímac, Cusco, Madre de Dios, Puno, Arequipa, Moquegua, Tacna). |
| Venezuela (25 ADM1 incl. Distrito Capital, La Guaira, Dependencias Federales) | 493: Distrito Capital, Miranda, La Guaira, Aragua, Carabobo, Yaracuy, Guárico, Nueva Esparta, Anzoátegui, Sucre, Monagas, Dependencias Federales (12). 494: Zulia, Falcón, Lara, Trujillo, Mérida, Táchira, Barinas, Portuguesa, Cojedes, Apure, Bolívar, Amazonas, Delta Amacuro (13). |
| Argentina (24 ADM1) | 488: Ciudad Autónoma de Buenos Aires (entire) + Buenos Aires Province (40 metropolitan partidos, ADM2). 489: Buenos Aires Province (other 95 partidos, ADM2; 40+95 = 135), Santa Fe, Entre Ríos, Corrientes, Misiones, Chaco, Formosa, La Pampa. 490: Córdoba, Mendoza, Tucumán, Salta, Santiago del Estero, San Juan, Jujuy, Río Negro, Neuquén, Chubut, San Luis, Catamarca, La Rioja, Santa Cruz, Tierra del Fuego. Only Buenos Aires Province is split (between 488 and 489). |
| Uruguay | 489 (entire) |
| Chile (incl. Easter Island) | 495 (entire) |
| Ecuador (incl. Galápagos) | 496 (entire) |
| Bolivia | 497 (entire) |
| Falkland Islands; South Georgia & S. Sandwich Is. | 490 (entire) |

Nothing missing or double-counted (partido lists checked programmatically: 135 unique Buenos Aires partidos = 40 + 95). The Buenos Aires partido split assumes the 135-partido list; geoBoundaries ADM2 naming may differ slightly.

## 2. Population
Sum of seat K = 216,200,000. Own estimate of scope total (WPP-style 2026: Colombia 53.1, Venezuela 28.5, Ecuador 18.3, Peru 34.5, Bolivia 12.6, Chile 19.9, Argentina 45.9, Uruguay 3.4, Falklands/S. Georgia ~0.004) = 216.2m. Match within 0.01% (rounding). Mean seat 16.63m, min 12.60m (497), max 19.90m (495).

## 3. Flags
- No seat uses ADM3 (beyond_ADM2 = NO everywhere). ADM2 used only in seats 488/489 (Buenos Aires Province partidos).
- No seat outside 12.5-20.8m. Near edges: 497 Bolivia 12.60m (just above floor), 495 Chile 19.90m, 486 19.05m.
- Long sea links: San Andrés y Providencia (486, ~700 km), Falkland Islands/South Georgia (490, remote; no sovereignty implied), Easter Island (495), Galápagos (496), Nueva Esparta (493, ferry). Tierra del Fuego (490) connects to Santa Cruz via a short Strait ferry/road through Chile.
- Cross-country block: 489 = entire Uruguay + part of Argentina (Litoral/Pampas, Rioplatense culture; rule 3).
- Low confidence: Venezuela seats 493/494 (post-2015 emigration; rounded to 100,000). Medium: Colombia, Peru, Argentina (provincial splits from census/projections scaled to WPP; Buenos Aires partido aggregates approximate).
