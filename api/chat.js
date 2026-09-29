// api/chat.js
// Vercel Serverless Function: handles chat requests and forwards them to Google Gemini API

module.exports = async function handler(req, res) {
  // 1. Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed. Please send a POST request with JSON.' });
  }

  // 2. Read the Gemini API key securely from environment variables (NEVER hardcoded)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured in environment variables. Please add it in your Vercel project settings or .env.local file.'
    });
  }

  try {
    // 3. Parse incoming request body
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const message = body?.message;

    // Validate that message is present and non-empty
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please provide a non-empty "message" string in the request body.' });
    }

    // 4. Call Google Gemini API (gemini-flash-latest is current, fast, and on the free tier)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: message.trim()
              }
            ]
          }
        ]
      })
    });

    const data = await geminiResponse.json();

    // 5. Check if Gemini returned an error response
    if (!geminiResponse.ok) {
      const errorMsg = data?.error?.message || 'Error received from Gemini API.';
      return res.status(geminiResponse.status).json({ error: errorMsg });
    }

    // 6. Extract the reply text from the Gemini response structure
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      return res.status(500).json({ error: 'Gemini returned an empty reply. Please try again.' });
    }

    // 7. Return the reply as JSON { reply }
    return res.status(200).json({ reply });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    return res.status(500).json({ error: error.message || 'Internal server error while processing chat.' });
  }
};
