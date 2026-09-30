#!/usr/bin/env node
/**
 * Load test for the paid /search endpoint (issue #133).
 *
 * Targets a payment-disabled instance so the test never spends real USDC.
 * The script refuses to run unless PAYMENT_DISABLED=true is set, which is the
 * flag the server uses to skip the facilitator round trip and Serper billing.
 *
 * Usage:
 *   PAYMENT_DISABLED=true BASE_URL=http://localhost:3000 \
 *     node scripts/load-test.js
 *
 * Env vars:
 *   BASE_URL          Base URL of the payment-disabled instance (default http://localhost:3000)
 *   PAYMENT_DISABLED  Must be "true" to run; guards against spending funds
 *   CONCURRENCY       Number of concurrent workers (default 50)
 *   DURATION_MS       How long to run the test in ms (default 30000)
 *   QUERY             Search query to send (default "load test")
 *
 * Output: throughput (RPS), p95 latency, and error rate, plus a JSON summary.
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PAYMENT_DISABLED = process.env.PAYMENT_DISABLED === 'true';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '50', 10);
const DURATION_MS = parseInt(process.env.DURATION_MS || '30000', 10);
const QUERY = process.env.QUERY || 'load test';

if (!PAYMENT_DISABLED) {
  console.error(
    'Refusing to run: set PAYMENT_DISABLED=true to target a payment-disabled instance.\n' +
      'This prevents the load test from spending real USDC.'
  );
  process.exit(1);
}

const target = new URL('/search', BASE_URL);
const client = target.protocol === 'https:' ? https : http;

const latencies = [];
let completed = 0;
let errors = 0;
let inFlight = 0;
let stop = false;

function request() {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const body = JSON.stringify({ query: QUERY });
    const req = client.request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
          latencies.push(elapsedMs);
          completed += 1;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            errors += 1;
          }
          resolve();
        });
      }
    );
    req.on('error', () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      latencies.push(elapsedMs);
      completed += 1;
      errors += 1;
      resolve();
    });
    req.end(body);
  });
}

async function worker() {
  while (!stop) {
    inFlight += 1;
    await request();
    inFlight -= 1;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  console.log(
    `Load testing ${target.href} with concurrency=${CONCURRENCY} for ${DURATION_MS}ms`
  );
  const startedAt = Date.now();
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    workers.push(worker());
  }

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  stop = true;
  await Promise.all(workers);

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const sorted = latencies.slice().sort((a, b) => a - b);
  const rps = completed / elapsedSec;
  const p95 = percentile(sorted, 95);
  const errorRate = completed === 0 ? 0 : errors / completed;

  const summary = {
    target: target.href,
    concurrency: CONCURRENCY,
    durationSec: Number(elapsedSec.toFixed(2)),
    requests: completed,
    errors,
    rps: Number(rps.toFixed(2)),
    p95LatencyMs: Number(p95.toFixed(2)),
    errorRate: Number(errorRate.toFixed(4)),
  };

  console.log('\n--- Load test results ---');
  console.log(`Requests:        ${summary.requests}`);
  console.log(`Throughput:      ${summary.rps} req/s`);
  console.log(`p95 latency:     ${summary.p95LatencyMs} ms`);
  console.log(`Error rate:      ${(summary.errorRate * 100).toFixed(2)}%`);
  console.log('\nJSON summary:');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
