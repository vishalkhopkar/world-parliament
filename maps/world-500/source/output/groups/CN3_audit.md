# CN3 audit (China north/west/south-west provinces + Mongolia; 29 seats)

## 1. Partition check
ADM0 in scope: China (partial, 16 ADM1 below), Mongolia. Mongolia [entire ADM0] appears only in seat 165.

China ADM1 -> seats (every ADM2 unit of each ADM1 appears in exactly one seat; checked by script, no gaps/overlaps):
- Sichuan (21 prefectures): 115 (Chengdu); 116 (Meishan, Leshan, Ya'an, Liangshan, Panzhihua); 117 (Mianyang, Guangyuan, Deyang, Suining, Bazhong); 118 (Nanchong, Dazhou, Guang'an); 119 (Yibin, Luzhou, Zigong, Neijiang, Ziyang); 171 (Ganzi, Aba)
- Chongqing (38 districts/counties, ADM3): 158 (16 districts), 159 (22 districts/counties)
- Hebei (11): 120 (Shijiazhuang, Hengshui); 121 (Tangshan, Qinhuangdao, Chengde, Zhangjiakou); 122 (Baoding, Cangzhou); 123 (Handan, Xingtai); 170 (Langfang)
- Beijing: 169 (entire ADM1)
- Tianjin: 170 (entire ADM1)
- Shanxi (11): 156 (6 prefectures), 157 (5)
- Shaanxi (10): 152 (Xi'an, Xianyang, Baoji); 153 (other 7)
- Liaoning (14): 148 (6), 149 (7 incl. Fuxin), 166 (Chaoyang)
- Jilin (9): 167 (7), 166 (Baicheng, Songyuan)
- Heilongjiang (13): 160 (Harbin, Suihua, Daqing); 161 (other 10)
- Inner Mongolia (12): 165 (Hohhot, Baotou, Wuhai, Ordos, Bayannur, Ulanqab, Xilingol, Alxa); 166 (Hulunbuir, Hinggan, Tongliao, Chifeng)
- Gansu (14): 164 (Lanzhou, Jiayuguan, Jinchang, Baiyin, Wuwei, Zhangye, Jiuquan, Dingxi, Linxia); 171 (Gannan, Longnan); 172 (Pingliang, Qingyang, Tianshui)
- Ningxia: 172 (entire ADM1)
- Qinghai: 171 (entire ADM1)
- Tibet: 171 (entire ADM1)
- Xinjiang (14 prefecture-level units + 12 XPCC county-level cities): 162 (north + Hami + 8 northern XPCC cities), 163 (Turpan, Bayingolin, Aksu, Kizilsu, Kashgar, Hotan + Aral, Tumxuk, Tiemenguan, Kunyu)

Nothing missing, nothing double-counted.

## 2. Population sum
Sum of seat K = 487.51m. Independent scope estimate (sum of 2026 provincial targets: Sichuan 83.5, Chongqing 32.1, Hebei 74.2, Beijing 21.8, Tianjin 13.5, Shanxi 34.0, Shaanxi 39.5, Liaoning 40.9, Jilin 23.0, Heilongjiang 29.6, Inner Mongolia 24.0, Gansu 24.5, Ningxia 7.3, Qinghai 5.95, Tibet 3.75, Xinjiang 26.3, Mongolia 3.62) = 487.52m. Difference ~0 (rounding). Provincial targets = 2020 census grown/shrunk with recent statistical-bureau trends (NE contraction, Chengdu/Xinjiang/Tibet growth); prefecture shares are 2020 census proportions (from memory, normalised to province totals), so splits inside a province are Medium confidence; Chongqing district splits Low. Not rescaled to UN WPP 2026 China total (not available offline); provincial totals sit about 0-1% below the 2020 census sum, consistent with WPP.

Seat range 13.07m (162) to 21.80m (169); mean 16.81m.

## 3. Flagged seats
- Beyond ADM2 = YES: 158, 159 (Chongqing split at ADM3 districts/counties; Chongqing has no prefecture tier).
- Above band (HIGH): 115 Chengdu (21.4m, single ADM2 megacity kept whole); 169 Beijing (21.8m, ADM1 kept whole).
- Below 12.5m: none. Close to edge: 162/163 (~13.1-13.2m), 152 (20.4m, near top).
- Long sea links: none (all seats land-contiguous).
- Cross-province pieces: 166 combines east Inner Mongolia with Chaoyang (Liaoning) and Baicheng/Songyuan (Jilin) (Horqin Mongol / Jehol ties); 171 combines Tibet and Qinghai with Tibetan prefectures from Sichuan/Gansu plus Longnan.
- Xinjiang XPCC (Bingtuan) county-level cities are treated as ADM2 units; verify against the geoBoundaries ADM2 list.
