import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version: APP_VERSION } = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const NETWORK = process.env.STELLAR_NETWORK || 'stellar:testnet'
  const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://www.x402.org/facilitator'
  const SERPER_API_KEY = process.env.SERPER_API_KEY
  const GROQ_API_KEY = process.env.GROQ_API_KEY
  const RECEIVING_ADDRESS = process.env.STELLAR_RECEIVING_ADDRESS

  res.json({
    status: 'ok',
    version: APP_VERSION,
    network: NETWORK,
    pricePerQuery: '0.001 USDC',
    protocol: 'x402',
    facilitator: FACILITATOR_URL,
    serperApiConfigured: !!SERPER_API_KEY,
    groqApiConfigured: !!GROQ_API_KEY,
    receivingAddressConfigured: !!RECEIVING_ADDRESS,
    stats: await getStats(),
    timestamp: new Date().toISOString(),
  })
}
async function getStats(): Promise<{ searches: number; payments: number } | null> {
  return null
}
