# E3a audit (seats 411-417, 426, 432, 433)

## 1. Partition check
| ADM0 | Seat(s) |
|---|---|
| Italy (split by ADM1, all 20 regions) | see below |
| San Marino | 412 |
| Vatican City | 413 |
| Malta | 414 |
| Spain (split by ADM1, all 19 units) | see below |
| Gibraltar | 417 |
| Andorra | 416 |
| Portugal (entire, incl. Madeira, Azores) | 415 |
| Greece | 426 |
| Cyprus (whole island) | 426 |
| North Macedonia | 426 |
| Slovenia, Croatia, Bosnia and Herzegovina, Montenegro, Albania, Kosovo | 432 |
| Bulgaria, Serbia (excl. Kosovo) | 433 |

Italy ADM1: 411 = Lombardy, Piedmont, Aosta Valley, Liguria; 412 = Veneto, Friuli-Venezia Giulia, Trentino-Alto Adige, Emilia-Romagna, Marche, Abruzzo; 413 = Tuscany, Umbria, Lazio, Campania; 414 = Molise, Puglia, Basilicata, Calabria, Sicily, Sardinia.

Spain ADM1: 415 = Galicia, Asturias, Cantabria, Castile and Leon, Basque Country, Extremadura; 416 = Madrid, Castilla-La Mancha, Aragon, Navarre, La Rioja, Catalonia; 417 = Andalusia, Valencian Community, Murcia, Balearic Islands, Canary Islands, Ceuta, Melilla.

Nothing is missing or double-counted: every unit in scope appears in exactly one seat (Italy 4+6+4... = 20 regions, Spain 6+6+7 = 19 units). No ADM2/ADM3 splitting was used.

## 2. Population check
Seat K sum = 158.44m. Own estimate of scope total (WPP-2024-based 2026: Italy 58.93, Spain 47.85, Portugal 10.40, Greece 9.90, Cyprus 1.38, N. Macedonia 1.81, Slovenia 2.12, Croatia 3.85, BiH 3.14, Montenegro 0.62, Albania 2.71, Kosovo 1.68, Bulgaria 6.67, Serbia 6.69, Malta 0.54, San Marino 0.034, Gibraltar 0.033, Andorra 0.08, Vatican 0.0005) = 158.43m. Match within 0.01%. Regional shares for Italy and Spain are national statistics scaled to these totals (Spain's scaled total is below INE counts).
Seat range 13.09m (426) to 20.24m (415); mean 15.84m. All within 12.5-20.8m; no pop_flag set.

## 3. Flags
- beyond_ADM2: none.
- Out-of-band: none. 415 (20.24m) is near the upper limit; 426 (13.09m) and 433 (13.36m) near the lower limit.
- Long sea links: Cyprus-Greece (426); Sardinia and Malta-Sicily (414); Madeira/Azores (415); Canary Islands, Balearics, Ceuta/Melilla (417).
- Cultural-pairing notes: Catalonia paired with Madrid (416) by arithmetic; Greece+Cyprus+North Macedonia (426) chosen to reach band while keeping Kosovo/Albania together (432).
