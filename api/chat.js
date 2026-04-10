const SHEET_ID = '1Zks3ZD8-ootOG1qoxB-ZA9iUy0uzKadulASwOrxbZZ4';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const PAGES_TO_SCRAPE = [
  'https://www.jitsudo.ca',
  'https://www.jitsudo.ca/join-now-for-martial-arts-classes',
  'https://www.jitsudo.ca/classes',
  'https://www.jitsudo.ca/programs',
  'https://www.jitsudo.ca/schedule',
  'https://www.jitsudo.ca/about',
  'https://www.jitsudo.ca/pricing',
  'https://www.jitsudo.ca/contact',
  'https://www.jitsudo.ca/kids-classes',
  'https://www.jitsudo.ca/adult-classes',
  'https://www.jitsudo.ca/bjj',
];

// Module-level cache
let cachedContext = null;
let cacheExpiry = 0;
const CACHE_TTL = 60 * 60 * 1000;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JitsudoBot/1.0)',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = stripHtml(html);
    return text.length > 100 ? text.substring(0, 3000) : null;
  } catch {
    return null;
  }
}

async function fetchGoogleSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

async function buildContext() {
  if (cachedContext && Date.now() < cacheExpiry) {
    return cachedContext;
  }

  const [faq, ...pageContents] = await Promise.all([
    fetchGoogleSheet(),
    ...PAGES_TO_SCRAPE.map(fetchPage),
  ]);

  const webContent = PAGES_TO_SCRAPE
    .map((url, i) => (pageContents[i] ? `[${url}]\n${pageContents[i]}` : null))
    .filter(Boolean)
    .join('\n\n---\n\n');

  cachedContext = { faq, webContent };
  cacheExpiry = Date.now() + CACHE_TTL;
  return cachedContext;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let messages;
  try {
    messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // Keep conversation history manageable
  if (messages.length > 20) messages = messages.slice(-20);

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not set');
      return res.status(500).json({ error: 'API key not configured' });
    }

    const system = `You are a warm, knowledgeable assistant for Jitsudo — a martial arts school that builds confident, capable people through BJJ, kickboxing, and other disciplines.

Your role:
1. Answer questions about Jitsudo's classes, schedule, pricing, instructors, and community
2. Help people figure out which class is the best fit for their goals, age, and fitness level
3. Inspire people and guide them toward booking a FREE trial class

Tone: Genuine, enthusiastic, and encouraging — like a passionate coach who really wants to help people find their path in martial arts. Warm and personable, never salesy. Nudge toward action when it feels natural.

When relevant, invite them to try a free trial class at: https://www.jitsudo.ca/join-now-for-martial-arts-classes

Guidelines:
- Keep responses concise and conversational (2–3 short paragraphs max)
- If someone shares their goals (fitness, self-defence, confidence, kids' programs, stress relief, competition, etc.), recommend the most relevant class
- Ask a follow-up question if it helps you give a better recommendation
- If unsure about something specific (e.g. exact schedule, pricing), be honest and suggest they contact the school or check the website
- Always end on an encouraging, welcoming note`;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 500,
        system,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API error:', response.status, errorText);
      return res.status(500).json({
        error: 'Claude API error',
        status: response.status,
        details: errorText.substring(0, 200)
      });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || "Sorry, I couldn't get a response — please try again!";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({
      error: 'Something went wrong. Please try again!',
      details: err.message || err.toString()
    });
  }
}
