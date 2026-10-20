# Agent E notes (simulator + tuning)
- DONE: sim/src/{world,state,bots,game,metrics,run}.ts + tsconfig. Modes: checks, lone, mix, h2h, field, evolve, crowd, full; `--set path=val` overrides; `--verify` (incremental state vs engine: 3.6e-15).
- DONE: WORLD_CONFIG tuned: costs rally 20M / roadshow 4M (R=50, S=250), y=1, c=0.01, s=3, rally decay 150/800/0.5, roadshow decay 40/200/0.4, seat report 8M->18M, global 28M->62M, noise 0.07.
- Tests: shared vitest 60/60 pass, tsc clean; sim tsc clean.
- Key findings: 2p = "c-war" (more early rallies wins unvisited seats); time multiplier 1.1 > swing so late acts win ties; reports have negative seat ROI at 2-4.5 roadshow price; engine does not reject actions on frozen own seat (server must).
- REPORT.md: the Write tool refused to create it in the subagent context (told to return findings as text); full report content is in the final handback message instead.
