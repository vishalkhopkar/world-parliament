# CN2 audit (China east-central: Shandong, Henan, Jiangsu, Zhejiang, Anhui, Hubei, Shanghai)

## 1. Partition check
ADM0 in scope: China (ADM1s listed below). All prefecture-level (ADM2) units of each ADM1 are assigned to exactly one seat; no gaps, no overlaps (checked by script: every unit used once, none unassigned).

| ADM1 | Seats | Units |
|---|---|---|
| Shandong | 98, 99, 100, 101, 102, 103 | 16 prefecture-level cities (Laiwu is inside Jinan since 2019) |
| Henan | 104, 105, 106, 107, 108, 109 | 17 prefecture-level cities + Jiyuan (province-direct city, 104) |
| Jiangsu | 110, 111 (Suzhou only), 112, 113, 114 | 13 prefecture-level cities |
| Zhejiang | 111 (Huzhou only), 128, 129, 130, 131 | 11 prefecture-level cities |
| Anhui | 132, 133, 134, 135 | 16 prefecture-level cities |
| Hubei | 136, 137, 138 | 12 prefecture-level cities + Enshi prefecture + Xiantao, Qianjiang, Tianmen, Shennongjia (province-direct county-level units, treated as ADM2-level) |
| Shanghai | 168 (entire ADM1) | whole municipality |

Cross-provincial seat: 111 = Suzhou (Jiangsu) + Huzhou (Zhejiang), Taihu basin. Name clashes: Taizhou exists in Jiangsu (seat 110) and Zhejiang (seat 130); Suzhou exists in Jiangsu (111) and Anhui (133). Each is qualified by its ADM1 in column T.

## 2. Population
Method: 2020 census prefecture populations grown to 2026 with prefecture-specific factors (growth of Hangzhou, Wuhan, Hefei, Zhengzhou, Suzhou etc.; decline in agricultural north Henan/Anhui/Hubei), normalised per province to a 2026 provincial estimate, then scaled by 0.996 toward the UN WPP China total.
- Sum of 29 seats' pop_K = 493,330,000.
- My independent check: sum of the seven provinces' 2020 census totals = 493.86m (Shandong 101.53, Henan 99.37, Jiangsu 84.75, Zhejiang 64.57, Anhui 61.03, Hubei 57.75, Shanghai 24.87); my 2026 scope estimate = 495.3m x 0.996 = 493.3m. Difference vs census sum -0.1%; within 1%.
- Mean 17.01m, min 12.24m (seat 131), max 24.70m (seat 168).
- Confidence is Medium throughout: 2026 prefecture growth factors are my estimates, not published projections.

## 3. Flagged seats
- Beyond ADM2: none (no ADM3 splits).
- 168 Shanghai 24.70m: HIGH (outside band). Whole municipality kept as one seat; splitting would need ADM3 districts and a Suzhou/Jiaxing link would unbalance neighbours.
- 131 Jinhua-Quzhou-Lishui 12.24m: LOW (just below 12.5m). Geography leaves no contiguous partner that keeps neighbouring Zhejiang seats in band.
- Close to band edge but inside: 136 (19.90m), 137 (19.93m), 98 (19.48m), 99 (13.39m); Hubei has only 3 seats for 57.8m so its seats run ~18-20m.
- Long sea links: Zhoushan to Ningbo (seat 129) via established bridge/ferry link; no remote-island links.
