# CN1 audit (China South/Southeast + HK, Macau, Taiwan) - 27 seats

## 1. Partition check
ADM0 units in scope: China (mainland provinces below), Hong Kong, Macau (separate ADM0 as in geoBoundaries), Taiwan.
- Taiwan [entire ADM0]: seat 174 only.
- Hong Kong [entire ADM0], Macau [entire ADM0]: seat 173 only.
- China ADM1 -> seats (ADM2 prefecture-level units assigned exactly once):
  - Guangdong (21 ADM2): 90 Guangzhou; 91 Zhaoqing, Yunfu, Yangjiang, Maoming; 92 Shenzhen; 93 Qingyuan, Shaoguan, Heyuan, Meizhou; 94 Dongguan, Huizhou; 95 Foshan, Zhongshan; 96 Shantou, Jieyang, Chaozhou, Shanwei; 97 Zhanjiang; 173 Zhuhai, Jiangmen.
  - Hainan [entire ADM1]: 97.
  - Hunan (14): 124 Changsha, Zhuzhou, Xiangtan; 125 Yueyang, Changde, Yiyang, Loudi; 126 Hengyang, Chenzhou, Yongzhou; 127 Shaoyang, Huaihua, Zhangjiajie, Xiangxi.
  - Guangxi (14): 139 Nanning, Chongzuo, Baise, Fangchenggang, Qinzhou; 140 Guilin, Liuzhou, Hechi, Hezhou; 141 Wuzhou, Yulin, Guigang, Laibin, Beihai.
  - Yunnan (16): 142 Kunming, Yuxi, Chuxiong, Honghe; 143 Dali, Baoshan, Lijiang, Nujiang, Diqing, Dehong, Lincang, Puer, Xishuangbanna; 144 Qujing, Zhaotong, Wenshan.
  - Jiangxi (11): 145 Nanchang, Shangrao, Yingtan, Fuzhou; 146 Ganzhou, Ji'an; 147 Jiujiang, Jingdezhen, Yichun, Pingxiang, Xinyu.
  - Fujian (9): 146 Longyan; 150 Fuzhou, Ningde, Nanping, Sanming, Putian; 151 Xiamen, Quanzhou, Zhangzhou.
  - Guizhou (9): 154 Guiyang, Anshun, Qianxinan, Qiandongnan, Qiannan; 155 Zunyi, Bijie, Tongren, Liupanshui.
Programmatically checked: every unit appears exactly once; nothing missing or double-counted.

## 2. Population
Sum of seat K = 458.7m (rounded to 10k per seat) vs my scope estimate 458.6m (NBS 2024 provincial permanent residents x ~1.003 to approximate UN WPP 2026 scaling: Guangdong 128.2, Hainan 10.5, Fujian 42.1, Guangxi 50.35, Yunnan 46.5, Guizhou 38.5, Hunan 65.8, Jiangxi 45.2; HK 7.5, Macau 0.69, Taiwan 23.3). Prefecture splits within provinces are from census 2020/yearbook values scaled to those totals (Medium confidence). Seats: mean 17.0m, min 13.59m (seat 93), max 23.3m (seat 174).

## 3. Flags
- beyond_ADM2: none (Guangzhou 19.15m and Shenzhen 18.15m fit the band as whole ADM2).
- Out of band: seat 174 Taiwan 23.3m HIGH - UNAVOIDABLE (single territory, no rule-compliant pairing).
- Near the edges but in band: 150 Fuzhou-N. Fujian 20.11m; 90 Guangzhou 19.15m; 93 NE Guangdong 13.59m; 144 Qujing-Zhaotong-Wenshan 13.84m.
- Sea links: seat 97 Hainan + Zhanjiang (Qiongzhou Strait ferry ~20 km, established); seat 173 HK-Macau-Zhuhai via HK-Zhuhai-Macau Bridge (road link) plus Macau/Zhuhai/Jiangmen land borders.
- Cross-province moves: Longyan (Fujian) joins Ganzhou/Ji'an in seat 146 (Hakka, land border) to keep Fujian seats in band.
