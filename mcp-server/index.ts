#!/usr/bin/env node
/**
 * StellarSearch MCP Server
 *
 * Exposes tools for Claude Code (and any MCP client):
 *   - web_search:       pays 0.001 USDC via x402, returns Serper.dev results
 *   - ai_summarize:     uses Groq to summarise search results
 *   - check_balance:    reads live USDC balance from Stellar Horizon
 *
 * Setup: see README.md → "Claude Code / MCP Integration"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import Groq from 'groq-sdk'
import dotenv from 'dotenv'
import { StrKey } from '@stellar/stellar-sdk'
import { 
  HORIZON_URL, 
  USDC_ISSUER, 
  STELLAR_NETWORK,
  STELLAR_EXPERT_URL,
  AMOUNT_USDC,
  IS_MAINNET
} from '../src/lib/constants'

dotenv.config()

const SERVER_URL = process.env.SEARCH_API_URL || 'http://localhost:3001'
const GROQ_API_KEY = process.env.GROQ_API_KEY!

const groq = new Groq({ apiKey: GROQ_API_KEY })

// ─── Balance helpers ──────────────────────────────────────────────────────
const NETWORK_NAME = STELLAR_NETWORK.split(':')[1]
const PRICE_PER_SEARCH = parseFloat(AMOUNT_USDC)
const FRIENDBOT_URL = 'https://friendbot.stellar.org/?addr='
const FAUCET_URL = 'https://laboratory.stellar.org/#account-creator?network=test'
const TRUSTLINE_GUIDE_URL =
  'https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts#trustlines'

interface HorizonBalance {
  balance: string
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  is_authorized?: boolean
  is_authorized_to_maintain_liabilities?: boolean
}

interface HorizonAccount {
  balances?: HorizonBalance[]
}

/**
 * Validate a Stellar account ID locally so malformed input never reaches
 * Horizon (which answers 400 and an unhelpful payload).
 */
function validateStellarAddress(input: unknown): { address: string } | { error: string } {
  if (typeof input !== 'string' || input.trim() === '') {
    return {
      error: input === undefined || input === null || input === ''
        ? 'No address provided. Pass a Stellar account ID — 56 characters starting with "G".'
        : `Expected a Stellar account ID string, received ${typeof input}. Pass a Stellar account ID — 56 characters starting with "G".`,
    }
  }

  const address = input.trim()

  if (address.length !== 56) {
    return {
      error: `"${address}" is ${address.length} characters long. Stellar account IDs are exactly 56 characters — this looks truncated or pasted wrong.`,
    }
  }

  if (!address.startsWith('G')) {
    return {
      error: `"${address}" does not start with "G". Stellar account IDs (public keys) always start with G — secret keys start with S and must never be shared.`,
    }
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    return {
      error: `"${address}" is not a valid Stellar account ID — it failed the version/checksum check, so it has a typo in it. Re-copy it from your wallet.`,
    }
  }

  return { address }
}

/**
 * Horizon returns 404 for an address that exists as a keypair but has never
 * appeared on-chain. That is a normal, expected state — not a failure.
 */
function unfundedAccountMessage(address: string): string {
  return [
    `💳 Stellar Account: ${address}`,
    `   USDC: account not funded`,
    `   XLM:  account not funded`,
    `   Network: ${NETWORK_NAME}`,
    ``,
    `This account does not exist on Stellar ${NETWORK_NAME} yet. An account only`,
    `appears once it holds a balance of any asset — until then there are no`,
    `balances to report, and paying for a search would fail.`,
    ``,
    `   To activate it:`,
    `   1. Give it XLM so it can pay network fees:`,
    ...(IS_MAINNET
      ? [`      Buy XLM on an exchange, or use Stellar Laboratory:`,
         `      https://laboratory.stellar.org/#account-creator?network=public`]
      : [`      ${FRIENDBOT_URL}${address}`]),
    `   2. Add a USDC trustline to issuer ${USDC_ISSUER}`,
    `      ${TRUSTLINE_GUIDE_URL}`,
    ...(IS_MAINNET ? [] : [`   3. Get free testnet USDC: ${FAUCET_URL}`]),
    ``,
    `   Explorer: ${STELLAR_EXPERT_URL}/account/${address}`,
  ].join('\n')
}

/** Does this account hold *our* USDC trustline, and if so is it usable? */
function findUsdcTrustline(account: HorizonAccount): HorizonBalance | undefined {
  return (account.balances ?? []).find(
    (b) => b.asset_type !== 'native' && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
  )
}

function balanceMessage(address: string, account: HorizonAccount): string {
  const balances = account.balances ?? []
  const native = balances.find((b) => b.asset_type === 'native')
  const usdcTrustline = findUsdcTrustline(account)
  const xlm = native ? parseFloat(native.balance) : 0

  const lines = [`💳 Stellar Account: ${address}`]

  // ── XLM ─────────────────────────────────────────────────────────────────
  if (native) {
    lines.push(`   XLM:  ${xlm.toFixed(4)}`)
  } else {
    lines.push(`   XLM:  no XLM balance — the account exists but cannot pay network fees`)
  }

  // ── USDC: three distinct states, not two ───────────────────────────────
  if (!usdcTrustline) {
    const otherIssuers = balances
      .filter((b) => b.asset_code === 'USDC' && b.asset_issuer !== USDC_ISSUER)
      .map((b) => b.asset_issuer!)

    lines.push(`   USDC: no trustline (not the same as a 0 balance)`)
    lines.push(``)
    lines.push(`This account has never accepted StellarSearch USDC, so it cannot hold`)
    lines.push(`any — it can receive no USDC until a trustline to the issuer is added:`)
    lines.push(`   Issuer: ${USDC_ISSUER}`)
    lines.push(`   Guide:  ${TRUSTLINE_GUIDE_URL}`)
    if (otherIssuers.length) {
      lines.push(``)
      lines.push(`Note: this account holds USDC from a different issuer, which cannot pay for searches:`)
      for (const issuer of otherIssuers) lines.push(`   ${issuer}`)
    }
  } else if (usdcTrustline.is_authorized === false) {
    const balance = parseFloat(usdcTrustline.balance)
    lines.push(`   USDC: ${balance.toFixed(6)} REVOKED`)
    lines.push(``)
    lines.push(`The issuer has revoked this trustline (no longer authorized), so the issuer`)
    lines.push(`can claw back the balance and the line cannot receive new payments. It must`)
    lines.push(`be re-authorized by the issuer before it can pay for searches.`)
  } else {
    const balance = parseFloat(usdcTrustline.balance)
    const queries = PRICE_PER_SEARCH > 0 ? Math.floor(balance / PRICE_PER_SEARCH) : 0
    lines.push(`   USDC: ${balance.toFixed(6)} (~${queries.toLocaleString()} searches remaining)`)

    if (balance === 0) {
      lines.push(``)
      lines.push(`The USDC trustline exists and is authorized, but the balance is 0 —`)
      lines.push(`this account cannot pay for searches until USDC is deposited.`)
      if (xlm === 0) {
        lines.push(`It also holds no XLM, so it could not pay network fees either.`)
      }
      lines.push(`   Get testnet USDC: ${FAUCET_URL}`)
    }
  }

  lines.push(``)
  lines.push(`   Network: ${NETWORK_NAME}`)
  lines.push(`   Explorer: ${STELLAR_EXPERT_URL}/account/${address}`)

  return lines.join('\n')}

// ─── MCP server ───────────────────────────────────────────────────────────
const server = new Server(
  { name: 'stellar-search', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'web_search',
      description: `Search the web via StellarSearch. Automatically pays ${AMOUNT_USDC} USDC on Stellar (x402 protocol).
The server handles the full payment flow: HTTP 402 → sign Soroban auth → settle → return results.
Use for current events, documentation, research, or anything needing up-to-date web information.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Results count (1–10, default 5)', default: 5 },
          freshness: { type: 'string', enum: ['pd', 'pw', 'pm'], description: 'Age: pd=day, pw=week, pm=month' },
        },
        required: ['query'],
      },
    },
    {
      name: 'image_search',
      description: `Search the web for images via StellarSearch. Automatically pays ${AMOUNT_USDC} USDC on Stellar (x402 protocol).
Returns image URLs, titles, and source domains via the Serper.dev images API.
Use for visual references, photos, diagrams, or anything where you need image results.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Image search query' },
          count: { type: 'number', description: 'Results count (1–10, default 5)', default: 5 },
        },
        required: ['query'],
      },
    },
    {
      name: 'news_search',
      description: `Search recent news articles via StellarSearch. Automatically pays ${AMOUNT_USDC} USDC on Stellar (x402 protocol).
Returns articles with title, URL, snippet, publication date, and source via the Serper.dev news API.
Use for breaking stories, current events, and time-sensitive reporting.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'News search query' },
          count: { type: 'number', description: 'Results count (1–20, default 10)', default: 10 },
          freshness: { type: 'string', enum: ['pd', 'pw', 'pm'], description: 'Age: pd=day, pw=week, pm=month' },
        },
        required: ['query'],
      },
    },
    {
      name: 'ai_summarize',
      description: 'Use Groq (Llama 3) to summarise or analyse text. Free — no payment required.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to summarise or analyse' },
          instruction: { type: 'string', description: 'What to do with the text (e.g. "summarise", "extract key points")', default: 'summarise' },
        },
        required: ['text'],
      },
    },
    {
      name: 'check_balance',
      description: 'Check live USDC and XLM balance for a Stellar address from Horizon.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Stellar public key (G...)' },
        },
        required: ['address'],
      },
    },
    {
      name: 'get_search_stats',
      description: 'Get live statistics from the StellarSearch server (total queries, USDC settled, uptime, latencies).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  // ── web_search ────────────────────────────────────────────────────────
  if (name === 'web_search') {
    const { query, count = 5, freshness } = args as { query: string; count?: number; freshness?: string }

    try {
      const params = new URLSearchParams({ q: query, count: String(count) })
      if (freshness) params.set('freshness', freshness)

      // The server's x402 middleware handles the full payment flow.
      // In server-to-server mode the server needs a funded Stellar key.
      // For MCP usage we call the server which itself holds the paying wallet.
      const res = await fetch(`${SERVER_URL}/search?${params}`)

      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      const formatted = data.results
        .map((r: any, i: number) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
        .join('\n\n')

      return {
        content: [{
          type: 'text',
          text: [
            `🔍 Results for: "${query}"`,
            `💰 Paid: ${data.paidAmount} ${data.currency} on ${data.network}`,
            `⚡ Latency: ${data.latencyMs}ms`,
            `📊 ${data.count} results\n`,
            formatted,
          ].join('\n'),
        }],
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Search failed: ${err.message}` }], isError: true }
    }
  }

  // ── image_search ──────────────────────────────────────────────────────
  if (name === 'image_search') {
    const { query, count = 5 } = args as { query: string; count?: number }

    try {
      const safeCount = Math.min(Math.max(parseInt(String(count)) || 5, 1), 10)
      const params = new URLSearchParams({ q: query, count: String(safeCount) })

      const res = await fetch(`${SERVER_URL}/images?${params}`)

      if (!res.ok) {
        const e: any = await res.json().catch(() => ({}))
        throw new Error(e.error || `HTTP ${res.status}`)
      }

      const data: any = await res.json()
      const formatted = data.results
        .map((r: any, i: number) => `${i + 1}. **${r.title}**\n   Image: ${r.imageUrl}\n   Source: ${r.sourceUrl} (${r.source})`)
        .join('\n\n')

      return {
        content: [{
          type: 'text',
          text: [
            `🖼️  Image results for: "${query}"`,
            `💰 Paid: ${data.paidAmount} ${data.currency} on ${data.network}`,
            `⚡ Latency: ${data.latencyMs}ms`,
            `📊 ${data.count} results\n`,
            formatted,
          ].join('\n'),
        }],
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Image search failed: ${err.message}` }], isError: true }
    }
  }

  // ── news_search ───────────────────────────────────────────────────────
  if (name === 'news_search') {
    const { query, count = 10, freshness } = args as {
      query: string; count?: number; freshness?: string
    }

    try {
      const safeCount = Math.min(Math.max(parseInt(String(count)) || 10, 1), 20)
      const params = new URLSearchParams({ q: query, count: String(safeCount) })
      if (freshness) params.set('freshness', freshness)

      const res = await fetch(`${SERVER_URL}/news?${params}`)

      if (!res.ok) {
        const e: any = await res.json().catch(() => ({}))
        throw new Error(e.error || `HTTP ${res.status}`)
      }

      const data: any = await res.json()
      const formatted = data.results
        .map((r: any, i: number) => {
          const date = r.publishedAt ? ` · ${r.publishedAt}` : ''
          return `${i + 1}. **${r.title}** (${r.source}${date})\n   ${r.url}\n   ${r.snippet}`
        })
        .join('\n\n')

      return {
        content: [{
          type: 'text',
          text: [
            `📰 News results for: "${query}"`,
            `💰 Paid: ${data.paidAmount} ${data.currency} on ${data.network}`,
            `⚡ Latency: ${data.latencyMs}ms`,
            `📊 ${data.count} results\n`,
            formatted,
          ].join('\n'),
        }],
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `News search failed: ${err.message}` }], isError: true }
    }
  }

  // ── ai_summarize ──────────────────────────────────────────────────────
  if (name === 'ai_summarize') {
    const { text, instruction = 'summarise' } = args as { text: string; instruction?: string }

    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are a concise research assistant. Be brief and accurate.' },
          { role: 'user', content: `Please ${instruction} the following:\n\n${text}` },
        ],
        max_tokens: 512,
        temperature: 0.5,
      })

      const content = completion.choices[0]?.message?.content || 'No response.'
      return { content: [{ type: 'text', text: content }] }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Groq error: ${err.message}` }], isError: true }
    }
  }

  // ── check_balance ─────────────────────────────────────────────────────
  if (name === 'check_balance') {
    const { address: rawAddress } = args as { address?: unknown }

    // Validate locally first: never spend a network round-trip on bad input.
    const check = validateStellarAddress(rawAddress)
    if ('error' in check) {
      return {
        content: [{ type: 'text', text: `❌ Invalid Stellar address: ${check.error}` }],
        isError: true,
      }
    }
    const address = check.address

    try {
      const res = await fetch(`${HORIZON_URL}/accounts/${address}`)

      // 404 = valid keypair, but it has never been funded/used on-chain.
      // This is an answer, not a failure, so it is not flagged as an error.
      if (res.status === 404) {
        return { content: [{ type: 'text', text: unfundedAccountMessage(address) }] }
      }

      // Reachable if Horizon rejects something StrKey accepted (or is the wrong network).
      if (res.status === 400) {
        return {
          content: [{
            type: 'text',
            text: `❌ Horizon rejected ${address} as a malformed account ID. If it should be valid, note that ${NETWORK_NAME} accounts cannot be looked up on another network.`,
          }],
          isError: true,
        }
      }

      if (res.status === 429) {
        return {
          content: [{ type: 'text', text: `Balance check failed: Horizon rate limit reached — retry in a few seconds.` }],
          isError: true,
        }
      }

      if (!res.ok) throw new Error(`Horizon returned ${res.status}`)

      const account: HorizonAccount = await res.json()
      return { content: [{ type: 'text', text: balanceMessage(address, account) }] }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Balance check failed: ${err.message}` }], isError: true }
    }
  }

  // ── get_search_stats ──────────────────────────────────────────────────
  if (name === 'get_search_stats') {
    try {
      const res = await fetch(`${SERVER_URL}/health`)
      if (!res.ok) throw new Error(`Server health check returned ${res.status}`)

      const stats = await res.json()
      
      return {
        content: [{
          type: 'text',
          text: [
            `📊 StellarSearch Server Stats`,
            `   Status:           ${stats.status.toUpperCase()}`,
            `   Network:          ${stats.network}`,
            `   Uptime:           ${stats.uptime}`,
            `   Total Queries:    ${stats.totalQueries.toLocaleString()}`,
            `   USDC Settled:     ${stats.totalUsdcSettled} USDC`,
            `   Avg Latency:      ${stats.avgLatencyMs}ms`,
            `   Price per Query:  ${stats.pricePerQuery}`,
            `   Facilitator:      ${stats.facilitator}`,
            `   APIs Configured:  Serper: ${stats.serperApiConfigured ? '✅' : '❌'}, Groq: ${stats.groqApiConfigured ? '✅' : '❌'}`,
          ].join('\n'),
        }],
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Failed to fetch server stats: ${err.message}` }], isError: true }
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('StellarSearch MCP server started')
