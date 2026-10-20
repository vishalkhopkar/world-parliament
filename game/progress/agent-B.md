# Agent B notes
- 07_game_map.py written; running/validating (see build/game_map_report.txt).
- DONE: script runs in ~5s, validation PASSED, outputs written. Caveat: Americas only reachable via Pacific NW<->Siberia East ferry, so k>=3 groups containing the Americas also include NE Asia.
- Follow-up: added EXTRA_FERRY 463<->403 (821 km) and switched balancing to cost-first move selection (natural Atlantic-basin group for the Americas). Validation PASSED.
