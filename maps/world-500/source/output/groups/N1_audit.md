# N1 audit - United States (48 contiguous states + DC + Alaska)

## 1. Partition check
Scope ADM0: United States (Hawaii and territories excluded, owned by other agents). ADM0 appears in seats 434-454. 50 ADM1 units (49 states + DC; Hawaii excluded) and 3139 ADM2 counties/county-equivalents (Census Vintage 2025 list, Hawaii excluded) were each assigned to exactly one seat (checked programmatically: per-state county counts across seats sum to the state's total; no county in two seats; none unassigned).

ADM1 to seat map:
- Alabama: entire, seat 443
- Alaska: entire, seat 454
- Arizona: entire, seat 451
- Arkansas: entire, seat 443
- California: split by county: seat 451 (1 of 58 counties), seat 452 (51 of 58 counties), seat 453 (6 of 58 counties)
- Colorado: entire, seat 450
- Connecticut: entire, seat 434
- Delaware: entire, seat 437
- District of Columbia: entire, seat 438
- Florida: split by county: seat 440 (26 of 67 counties), seat 441 (30 of 67 counties), seat 443 (11 of 67 counties)
- Georgia: entire, seat 440
- Idaho: entire, seat 450
- Illinois: split by county: seat 447 (22 of 102 counties), seat 449 (80 of 102 counties)
- Indiana: entire, seat 447
- Iowa: entire, seat 448
- Kansas: entire, seat 449
- Kentucky: entire, seat 442
- Louisiana: entire, seat 443
- Maine: entire, seat 434
- Maryland: entire, seat 438
- Massachusetts: entire, seat 434
- Michigan: entire, seat 446
- Minnesota: entire, seat 448
- Mississippi: entire, seat 443
- Missouri: entire, seat 449
- Montana: entire, seat 450
- Nebraska: entire, seat 449
- Nevada: entire, seat 451
- New Hampshire: entire, seat 434
- New Jersey: split by county: seat 435 (7 of 21 counties), seat 437 (14 of 21 counties)
- New Mexico: entire, seat 451
- New York: split by county: seat 435 (10 of 62 counties), seat 436 (52 of 62 counties)
- North Carolina: entire, seat 439
- North Dakota: entire, seat 448
- Ohio: split by county: seat 436 (13 of 88 counties), seat 442 (28 of 88 counties), seat 446 (47 of 88 counties)
- Oklahoma: entire, seat 445
- Oregon: entire, seat 454
- Pennsylvania: split by county: seat 436 (50 of 67 counties), seat 437 (17 of 67 counties)
- Rhode Island: entire, seat 434
- South Carolina: entire, seat 439
- South Dakota: entire, seat 449
- Tennessee: entire, seat 442
- Texas: split by county: seat 444 (83 of 254 counties), seat 445 (164 of 254 counties), seat 451 (7 of 254 counties)
- Utah: entire, seat 450
- Vermont: entire, seat 434
- Virginia: entire, seat 438
- Washington: entire, seat 454
- West Virginia: entire, seat 442
- Wisconsin: entire, seat 448
- Wyoming: entire, seat 450

Nothing is missing or double-counted.

## 2. Population check
Sum of seat pop_K = 342,120,000 (unrounded 342,151,344); my independent estimate of the scope (US Census Vintage 2025, July 2025 = 341.8m for 50 states+DC, minus Hawaii 1.43m, grown ~0.5% to 2026) is about 342.1m: match within 0.1%. Note the coordinator brief's scope figure of ~337m is ~1.5% lower than this; not scaled to UN WPP (WPP 2026 US total is higher than Census, so scaling to WPP would raise seats ~1-2%). Seat mean 16.29m, min 13.09m (seat 454), max 20.16m (seat 445).

## 3. Flagged seats
- Beyond ADM2: none (all seats built from whole states or whole counties).
- Out of band (12.5-20.8m): none. Lowest 437 (13.1m), 454 (13.1m), 450 (13.4m); highest 445 (20.2m, near top), 453 (19.7m).
- Long sea link: seat 454, Alaska attached to Washington/Oregon by Alaska Marine Highway / coastal shipping (no land border), per old sheet.
- Notable cross-state choices: Oklahoma with Dallas-Austin (445); San Bernardino County CA + El Paso/Trans-Pecos TX with the Southwest (451); Southern Ohio with Appalachia (442); Northeast Ohio with Upstate NY/West PA (436).
