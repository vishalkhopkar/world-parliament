# Agent A notes (engine)
- DONE: shared/src/engine/{types,rng,schedule,effects,votes,analyst,points,index}.ts; tests in shared/test (60 passing); tsc clean.
- Choices: frozen seat = phase close <= action ts; effects Map only has players with >=1 counted action; draw = both get seat pts + floor, 0 portfolio.
- Extra export: haversineKm.
