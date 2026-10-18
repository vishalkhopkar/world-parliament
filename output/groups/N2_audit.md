# N2 audit (seats 455-470)

## 1. Partition check
Mexico (all 32 ADM1): 455 = Ciudad de Mexico + 11 Estado de Mexico municipalities; 456 = other 114 Estado de Mexico municipalities (125 total, verified in code), Morelos, Guerrero; 457 = Puebla, Tlaxcala, Veracruz; 458 = Oaxaca, Chiapas, Tabasco, Campeche, Yucatan, Quintana Roo; 459 = Jalisco, Michoacan, Nayarit, Colima; 460 = Guanajuato, Queretaro, Aguascalientes, San Luis Potosi, Hidalgo; 461 = Baja California, Baja California Sur, Sonora, Chihuahua, Sinaloa; 462 = Nuevo Leon, Coahuila, Tamaulipas, Durango, Zacatecas. (8+... = 1+1(split)+3+6+4+5+5+5 + Morelos, Guerrero = 32 ADM1 counted once; Estado de Mexico split 11/114 across 455/456 only.)
Canada: Quebec, NL, PEI, NS, NB -> 463; BC, AB, SK, MB, YT, NT, Nunavut -> 464; Ontario split by census division (49 CDs): 23 in 463, 26 in 464. Saint Pierre and Miquelon -> 463. Greenland -> 464.
Central America: Guatemala, Belize -> 465; Honduras, El Salvador -> 466; Nicaragua, Costa Rica, Panama -> 467.
Caribbean: 468 = Cuba, Jamaica, Bahamas, Turks and Caicos, Cayman, Bermuda; 469 = Haiti; 470 = Dominican Republic, Puerto Rico, USVI, BVI, Anguilla, Saint Martin, Sint Maarten, Saint Barthelemy, Bonaire/Sint Eustatius/Saba, St Kitts & Nevis, Antigua & Barbuda, Montserrat, Guadeloupe, Dominica, Martinique, Saint Lucia, St Vincent & Grenadines, Barbados, Grenada, Trinidad & Tobago, Aruba, Curacao.
Nothing missing, nothing double-counted (each ADM0/ADM1 appears in exactly one seat; only Ontario and Estado de Mexico are split, at ADM2, with complementary lists).

## 2. Population check
Sum of seat K = 270.85m. Independent scope estimate: Mexico 131.8 + Canada ~41.48 + Greenland 0.056 + SPM 0.006 + Central America 52.9 + Caribbean 44.6 = ~270.8m. Match within 0.1%. (2026 estimates: Mexico scaled from INEGI 2020 census; Canada from StatCan CD 2021 scaled to ~41.5m; others UN WPP-type values from memory, Medium confidence.)

## 3. Flagged seats
- 464 Western Canada-Greenland 20.99m: HIGH, UNAVOIDABLE (2 seats for 41.5m). 463 is 20.55m (in band, near top).
- 469 Haiti 11.98m: LOW, UNAVOIDABLE (single country; no natural partner).
- Long sea links: Greenland-Nunavut (464); Bermuda-Bahamas (468); Aruba/Curacao/Bonaire to Windward Antilles (470); DR-Puerto Rico Mona Passage (470); Bruce Peninsula-Manitoulin ferry inside 464.
- beyond ADM2: none (all splits are at ADM2 = Mexican municipio / Canadian census division).
- Mexico ADM2 names and Ontario CD pop values are from memory; spelling may need matching to geoBoundaries.
