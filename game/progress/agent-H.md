# Agent H notes (AWS adapters without AWS)
- test/fakes/fakeDdb.ts: in-memory DynamoDB DocumentClient (Get/Put/Update/Delete/Query+GSI+pagination/TransactWrite, expression subsets, SDK-style errors, validation incl. reserved words/unused names). Self-tests in test/fakes/fakeDdb.test.ts.
- test/dynamoRepo.contract.test.ts: same scenarios on MemoryRepo and DynamoRepo(fake) + Dynamo-specific tests.
- test/gameService.dynamo.test.ts: existing lobby/campaign/counting/hidden suites re-run on DynamoRepo(fake) via vi.mock of ./helpers (+ monotonic newId).
- test/aws-adapters.test.ts: ApiGwNotifier + SfnScheduler unit tests.
- Fixes in src/aws: report sort-key collision (dynamoRepo), pending players excluded from broadcast (apiGwNotifier), ConflictException tolerated on CreateSchedule (sfnScheduler).
