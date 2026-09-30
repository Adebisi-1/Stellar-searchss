import type { VercelRequest, VercelResponse } from '@vercel/node'

const CACHE_SECONDS = 5

export default function handler(req: VercelRequest, res: VercelResponse) {
  const NETWORK = process.env.STELLAR_NETWORK || 'stellar:testnet'
  const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://www.x402.org/facilitator'
  const SERPER_API_KEY = process.env.SERPER_API_KEY
  const GROQ_API_KEY = process.env.GROQ_API_KEY
  const RECEIVING_ADDRESS = process.env.STELLAR_RECEIVING_ADDRESS

  const body = {
    status: 'ok',
    network: NETWORK,
    pricePerQuery: '0.001 USDC',
    protocol: 'x402',
    facilitator: FACILITATOR_URL,
    serperApiConfigured: !!SERPER_API_KEY,
    groqApiConfigured: !!GROQ_API_KEY,
    receivingAddressConfigured: !!RECEIVING_ADDRESS,
    timestamp: new Date().toISOString(),
  }

  const etag = `"${Buffer.from(JSON.stringify(body)).toString('base64url')}"`

  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`)
  res.setHeader('ETag', etag)

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end()
    return
  }

  res.json(body)
}