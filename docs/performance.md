# Performance

This document records load-testing methodology and results for the paid
endpoints, starting with `POST /search` (issue #133).

## Why load test `/search`

Each `/search` request involves a facilitator round trip plus a Serper call, so
the failure mode under concurrency is not obvious from reading the code. We need
measured throughput, tail latency, and error rate before we can reason about
capacity.

## Running the load test

The load test lives in [`scripts/load-test.js`](../scripts/load-test.js) and is
built for [k6](https://k6.io/).

### Payment-disabled instance (no real funds)

The test **must** run against an instance where payments are disabled so it does
not spend USDC. Start the server with payments turned off and point the test at
it via `BASE_URL`:

```bash
# Payment-disabled instance (no facilitator settlement, no USDC spent)
PAYMENTS_DISABLED=true npm start

# In another shell, run the load test against it
BASE_URL=http://localhost:3000 k6 run scripts/load-test.js
```

The script defaults to `http://localhost:3000` and never sends payment headers,
so it only exercises the payment-disabled path. Do **not** point it at a
production instance with payments enabled.

### Configuration

| Env var        | Default                 | Meaning                          |
| -------------- | ----------------------- | -------------------------------- |
| `BASE_URL`     | `http://localhost:3000` | Target payment-disabled instance |
| `VUS`          | `50`                    | Concurrent virtual users         |
| `DURATION`     | `30s`                   | Test duration                    |

Example targeting 50 concurrent searches:

```bash
BASE_URL=http://localhost:3000 VUS=50 DURATION=30s k6 run scripts/load-test.js
```

## Metrics recorded

k6 reports the following, which are the numbers we care about:

- **Throughput** — `http_reqs` rate (requests/second).
- **p95 latency** — `http_req_duration` p(95).
- **Error rate** — `http_req_failed` rate, plus the custom `search_errors` counter.

The script also asserts thresholds so a regression fails the run:

- `http_req_duration`: p(95) < 2000 ms
- `http_req_failed`: rate < 1%

## Results

> Fill in after running against a payment-disabled instance. Record the machine
> specs and the target instance's configuration alongside the numbers.

| Concurrency (VUs) | Throughput (req/s) | p95 latency (ms) | Error rate |
| ----------------- | ------------------ | ---------------- | ---------- |
| 50                | _TBD_              | _TBD_            | _TBD_      |

### Bottlenecks found

> Document any bottleneck observed (e.g. Serper rate limiting, facilitator
> round-trip latency, connection pool exhaustion) and the evidence for it.

- _TBD_

## Notes

- The test does not spend real funds: it runs against a payment-disabled
  instance and sends no payment headers.
- Re-run and update the table above whenever `/search` or its upstream
  dependencies change.
